import {
  IsolationRuntimeMissingError,
  type IsolationGate,
  type VerifiedIsolation,
} from "../../isolation/gate.js";
import type { SandboxSettings } from "../config.js";
import { KAIJU_ENDPOINTS } from "../constants.js";
import type { KubeClient, ObjectRef } from "../kube.js";
import type { EndpointAddresses, KubeObject } from "../manifests.js";
import { SandboxProvisioningError } from "./errors.js";
import { CLAIM, POD, field, ref, str } from "./kube-objects.js";
import type { SandboxAuditEvent, SandboxProviderOptions } from "./types.js";

/**
 * What every part of the sandbox provider shares (KOBE-710): the cluster client, the isolation
 * gate, settings and clock, the audit sink, and the helpers several parts use (endpoint
 * addresses, the RuntimeClass re-check, deletes with retries, deleting an unverified sandbox).
 */

export const POD_WAIT_TIMEOUT_MS = 30_000;
/** Same as the wire wakeRetryBudgetMs: the budget a wake had before KOBE-192. */
export const READY_TIMEOUT_MS = 90_000;
const DELETE_RETRIES = 4;
const IPV4 = /^(\d{1,3})(\.\d{1,3}){3}$/;
const IPV6 = /^[0-9a-fA-F:]+$/;

export interface ProviderContext {
  readonly kube: KubeClient;
  readonly isolation: Pick<IsolationGate, "require">;
  readonly settings: SandboxSettings;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly podWaitTimeoutMs: number;
  readonly readyTimeoutMs: number;
  readonly runtimeClassName: string | undefined;
  readonly emit: (event: SandboxAuditEvent) => Promise<void>;
  readonly endpointAddresses: () => Promise<EndpointAddresses>;
  readonly stillVerified: (verified: VerifiedIsolation, pod: KubeObject) => Promise<boolean>;
  readonly deleteWithRetry: (target: ObjectRef) => Promise<boolean>;
  readonly rejectAndDelete: (
    owner: { readonly teamId: string; readonly userId: string; readonly sandboxId: string },
    namespace: string,
    name: string,
    reason: string,
    podName?: string,
  ) => Promise<never>;
}

export function createProviderContext(options: SandboxProviderOptions): ProviderContext {
  const {
    kube,
    isolation,
    settings,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
    podWaitTimeoutMs = POD_WAIT_TIMEOUT_MS,
    readyTimeoutMs = READY_TIMEOUT_MS,
    runtimeClassName,
    audit,
  } = options;

  const emit = async (event: SandboxAuditEvent): Promise<void> => {
    try {
      await audit?.(event);
    } catch {
      // Recording is best effort here (no transaction of ours to join); the recorder logs failures.
    }
  };

  const endpointAddresses = async (): Promise<EndpointAddresses> => {
    const entries = await Promise.all(
      KAIJU_ENDPOINTS.map(async (e) => {
        const name = settings.endpoints[e].service;
        const svc = await kube.get(ref("v1", "Service", name, settings.releaseNamespace));
        const ip = str(svc, "spec", "clusterIP");
        if (!ip || !(IPV4.test(ip) || IPV6.test(ip))) {
          throw new SandboxProvisioningError(
            `Service ${settings.releaseNamespace}/${name} has no ClusterIP; sandboxes could not reach it`,
          );
        }
        return [e, ip] as const;
      }),
    );
    return Object.fromEntries(entries) as EndpointAddresses;
  };

  /**
   * The RuntimeClass still exists with the handler that was verified, and the pod was created
   * after that RuntimeClass object (a class recreated with another handler must not pass old pods).
   */
  const stillVerified = async (verified: VerifiedIsolation, pod: KubeObject): Promise<boolean> => {
    const rc = await kube.get(ref("node.k8s.io/v1", "RuntimeClass", verified.runtimeClassName));
    if (!rc || field(rc, "handler") !== verified.handler) return false;
    const rcCreated = Date.parse(rc.metadata.creationTimestamp ?? "");
    const podCreated = Date.parse(pod.metadata.creationTimestamp ?? "");
    return !(rcCreated > podCreated);
  };

  /** Deletes with retries; false if it still failed (the reconciler retries later). */
  const deleteWithRetry = async (target: ObjectRef): Promise<boolean> => {
    for (let attempt = 0; attempt <= DELETE_RETRIES; attempt++) {
      try {
        await kube.delete(target);
        return true;
      } catch {
        if (attempt < DELETE_RETRIES) await sleep(200 * 2 ** attempt);
      }
    }
    return false;
  };

  const rejectAndDelete = async (
    owner: { readonly teamId: string; readonly userId: string; readonly sandboxId: string },
    namespace: string,
    name: string,
    reason: string,
    podName?: string,
  ): Promise<never> => {
    const claimGone = await deleteWithRetry(CLAIM(namespace, name));
    // The pod directly too: it must stop even if the claim's cascade is slow or the delete failed.
    const podGone = podName ? await deleteWithRetry(POD(namespace, podName)) : true;
    await emit({
      action: "sandbox.destroyed",
      teamId: owner.teamId,
      target: {
        sandboxId: owner.sandboxId,
        userId: owner.userId,
        ...(podName ? { pod: podName } : {}),
        reason: "isolation_mismatch",
      },
    });
    throw new IsolationRuntimeMissingError(
      `sandbox ${namespace}/${name} ${claimGone && podGone ? "was deleted" : "is being deleted"}: ${reason}. ` +
        "Only the verified isolation runtime may run sandboxes.",
    );
  };

  return {
    kube,
    isolation,
    settings,
    sleep,
    now,
    podWaitTimeoutMs,
    readyTimeoutMs,
    runtimeClassName,
    emit,
    endpointAddresses,
    stillVerified,
    deleteWithRetry,
    rejectAndDelete,
  };
}
