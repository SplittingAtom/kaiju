import { IsolationRuntimeMissingError, type VerifiedIsolation } from "../../isolation/gate.js";
import { isIsolationHandler } from "../../isolation/runtime-class.js";
import {
  ANNOTATION_EVAL_THREAD,
  ANNOTATION_TEAM_ID,
  ANNOTATION_USER_ID,
  LABEL_CLAIM_UID,
  LABEL_TEAM_ID,
  LABEL_TEAM_NAMESPACE,
  TEAM_NAMESPACE_PREFIX,
} from "../constants.js";
import { evalClaimName } from "../eval-manifests.js";
import {
  claimName,
  isUuid,
  teamNamespaceName,
  type KubeObject,
  type TeamRef,
} from "../manifests.js";
import { CLAIM, POD, field, ref, str } from "./kube-objects.js";
import type { ProviderContext } from "./context.js";
import type { SandboxProvider } from "./types.js";
import type { ReconcileResult } from "./types.js";

/**
 * Isolation enforcement after the fact (KOBE-9, KOBE-24): the reconciler that deletes pods not
 * under the verified runtime, and the liveness check the sandbox wire asks (split out of
 * provider.ts by KOBE-710).
 */

export function createIsolationOps(
  ctx: ProviderContext,
): Pick<SandboxProvider, "reconcileIsolation" | "isLive"> {
  const { kube, isolation, runtimeClassName, emit, stillVerified, deleteWithRetry } = ctx;

  /** Definitive loss only: the configured class is gone (404) or its handler does not isolate. */
  const isolationDefinitivelyLost = async (): Promise<string | undefined> => {
    if (!runtimeClassName) return undefined;
    const rc = await kube.get(ref("node.k8s.io/v1", "RuntimeClass", runtimeClassName));
    if (!rc) return `RuntimeClass ${runtimeClassName} no longer exists`;
    const handler = field(rc, "handler");
    return typeof handler === "string" && isIsolationHandler(handler)
      ? undefined
      : `RuntimeClass ${runtimeClassName} no longer isolates`;
  };

  const deletePodAndClaim = async (
    pod: KubeObject,
    teamId: string | undefined,
    withClaim: boolean,
  ): Promise<boolean> => {
    const namespace = pod.metadata.namespace as string;
    const annotated = pod.metadata.annotations?.[ANNOTATION_USER_ID];
    const userId = annotated && isUuid(annotated) ? annotated : undefined;
    const claimUid = pod.metadata.labels?.[LABEL_CLAIM_UID];
    const sandboxId = claimUid && isUuid(claimUid) ? claimUid : undefined;
    const evalThread = pod.metadata.annotations?.[ANNOTATION_EVAL_THREAD];
    if (withClaim && userId) {
      const name = evalThread && isUuid(evalThread) ? evalClaimName(evalThread) : claimName(userId);
      const claim = await kube.get(CLAIM(namespace, name));
      if (claim && claim.metadata.uid === claimUid) {
        await deleteWithRetry(CLAIM(namespace, claim.metadata.name));
      }
    }
    const gone = await deleteWithRetry(POD(namespace, pod.metadata.name));
    if (gone && teamId && isUuid(teamId)) {
      await emit({
        action: "sandbox.destroyed",
        teamId,
        target: {
          ...(sandboxId ? { sandboxId } : {}),
          ...(userId ? { userId } : {}),
          pod: pod.metadata.name,
          reason: withClaim ? "isolation_mismatch" : "isolation_lost",
        },
      });
    }
    return gone;
  };

  const reconcileIsolation = async (): Promise<ReconcileResult> => {
    let verified: VerifiedIsolation | undefined;
    let lost: string | undefined;
    try {
      verified = await isolation.require();
    } catch (err) {
      if (!(err instanceof IsolationRuntimeMissingError)) throw err;
      lost = await isolationDefinitivelyLost();
      // Not definitive (e.g. API unreachable): change nothing, check again next time.
      if (!lost) return { deleted: [] };
    }
    const namespaces = await kube.list(
      "v1",
      "Namespace",
      undefined,
      `${LABEL_TEAM_NAMESPACE}=true`,
    );
    const deleted: string[] = [];
    for (const ns of namespaces) {
      const namespace = ns.metadata.name;
      if (!namespace.startsWith(TEAM_NAMESPACE_PREFIX)) continue;
      for (const pod of await kube.list("v1", "Pod", namespace)) {
        if (pod.metadata.deletionTimestamp) continue;
        const ok =
          verified !== undefined &&
          str(pod, "spec", "runtimeClassName") === verified.runtimeClassName &&
          (await stillVerified(verified, pod));
        if (ok) continue;
        // Lost isolation: stop pods, keep claims (and volumes) for when it is restored.
        if (
          await deletePodAndClaim(pod, ns.metadata.labels?.[LABEL_TEAM_ID], verified !== undefined)
        ) {
          deleted.push(`${namespace}/${pod.metadata.name}`);
        }
      }
    }
    return {
      deleted,
      ...(lost ? { reason: lost } : deleted.length > 0 ? { reason: "unverified runtime" } : {}),
    };
  };

  const isLive = async (
    team: TeamRef,
    userId: string,
    sandboxId: string,
    evalThreadId?: string,
  ): Promise<boolean> => {
    if (!isUuid(userId) || !isUuid(sandboxId)) return false;
    if (evalThreadId !== undefined && !isUuid(evalThreadId)) return false;
    const name = evalThreadId ? evalClaimName(evalThreadId) : claimName(userId);
    const claim = await kube.get(CLAIM(teamNamespaceName(team), name));
    if (!claim || claim.metadata.uid !== sandboxId || claim.metadata.deletionTimestamp)
      return false;
    const annotations = claim.metadata.annotations ?? {};
    return (
      annotations[ANNOTATION_TEAM_ID] === team.id &&
      annotations[ANNOTATION_USER_ID] === userId &&
      annotations[ANNOTATION_EVAL_THREAD] === evalThreadId
    );
  };

  return { reconcileIsolation, isLive };
}
