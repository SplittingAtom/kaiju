import type { VerifiedIsolation } from "../../isolation/gate.js";
import {
  ANNOTATION_EVAL_THREAD,
  ANNOTATION_TEAM_ID,
  ANNOTATION_USER_ID,
  LABEL_CLAIM_UID,
} from "../constants.js";
import { evalClaimManifest, evalClaimName, type EvalClaimSpec } from "../eval-manifests.js";
import { isKubeStatus } from "../kube.js";
import { replacingPatch } from "../merge-patch.js";
import {
  assertTeamRef,
  assertUserId,
  claimName,
  sandboxClaimManifest,
  sandboxPodSpec,
  teamNamespaceName,
  type KubeObject,
  type TeamRef,
} from "../manifests.js";
import { podTermination, type PodTermination } from "../pod-termination.js";
import { SandboxProvisioningError } from "./errors.js";
import {
  CLAIM,
  POD,
  POD_NAME_ANNOTATION,
  SANDBOX,
  field,
  str,
  workspacePvcName,
} from "./kube-objects.js";
import type { ProviderContext } from "./context.js";
import type { SandboxProvider } from "./types.js";
import type { HibernateOutcome, SandboxHandle, WakeResult } from "./types.js";
import type { VolumeOps } from "./volumes.js";

/**
 * A member's sandbox claim (spec D11, D14; KOBE-22, KOBE-25, KOBE-636): getting or creating the
 * claim, provisioning and verifying its pod, resuming a hibernated sandbox, replacing an ended
 * pod once, and hibernating (split out of provider.ts by KOBE-710).
 */

export interface ClaimOps extends Pick<
  SandboxProvider,
  "ensureSandbox" | "wakeSandbox" | "hibernateSandbox"
> {
  /** The shared create-or-resume path (eval sandboxes use it with their own claim spec). */
  readonly provision: (
    team: TeamRef,
    userId: string,
    wake: boolean,
    evalSpec?: EvalClaimSpec,
    podWaitMs?: number,
  ) => Promise<{ handle: SandboxHandle; resumed: boolean; replaced?: PodTermination }>;
}

export function createClaimOps(
  ctx: ProviderContext,
  {
    ensureTeam,
    untilVolumeNotTerminating,
  }: Pick<SandboxProvider, "ensureTeam"> & Pick<VolumeOps, "untilVolumeNotTerminating">,
): ClaimOps {
  const {
    kube,
    isolation,
    settings,
    sleep,
    now,
    podWaitTimeoutMs,
    emit,
    endpointAddresses,
    stillVerified,
    deleteWithRetry,
    rejectAndDelete,
  } = ctx;

  const getOrCreateClaim = async (
    namespace: string,
    team: TeamRef,
    userId: string,
    evalSpec?: EvalClaimSpec,
  ): Promise<KubeObject> => {
    const name = evalSpec ? evalClaimName(evalSpec.threadId) : claimName(userId);
    let claim = await kube.get(CLAIM(namespace, name));
    if (!claim && !evalSpec) {
      // KOBE-733: right after a reclaim the old volume (same name) may still be terminating; a
      // new claim must not meet it. Wait for it to go, bounded (GC finishes it otherwise).
      await untilVolumeNotTerminating(namespace, workspacePvcName(name));
    }
    if (!claim) {
      try {
        claim = await kube.create(
          evalSpec
            ? evalClaimManifest(namespace, team, evalSpec, settings)
            : sandboxClaimManifest(namespace, team, userId, settings),
        );
        if (claim.metadata.uid) {
          await emit({
            action: "sandbox.created",
            teamId: team.id,
            target: { sandboxId: claim.metadata.uid, userId },
          });
        }
      } catch (err) {
        // Another replica created it first: use that one.
        if (!isKubeStatus(err, 409)) throw err;
        claim = await kube.get(CLAIM(namespace, name));
      }
    }
    if (!claim?.metadata.uid) {
      throw new SandboxProvisioningError(`SandboxClaim ${namespace}/${name} has no UID`);
    }
    if (claim.metadata.deletionTimestamp) {
      throw new SandboxProvisioningError(`Sandbox ${namespace}/${name} is being deleted; retry`);
    }
    const annotations = claim.metadata.annotations ?? {};
    if (
      annotations[ANNOTATION_TEAM_ID] !== team.id ||
      annotations[ANNOTATION_USER_ID] !== userId ||
      annotations[ANNOTATION_EVAL_THREAD] !== evalSpec?.threadId
    ) {
      throw new SandboxProvisioningError(
        `SandboxClaim ${namespace}/${name} does not belong to this user and team`,
      );
    }
    return claim;
  };

  /**
   * Re-applies the pod template from the current settings and sets Running, guarded by the
   * resourceVersion read with it. False when the Sandbox changed meanwhile (409): re-read it.
   */
  const resume = async (
    namespace: string,
    sandbox: KubeObject,
    verified: VerifiedIsolation,
  ): Promise<boolean> => {
    const next = sandboxPodSpec(verified, settings, await endpointAddresses());
    const current = field(sandbox, "spec", "podTemplate", "spec");
    try {
      await kube.patch(
        SANDBOX(namespace, sandbox.metadata.name),
        {
          spec: {
            operatingMode: "Running",
            podTemplate: { spec: replacingPatch(current, next) },
          },
        },
        sandbox.metadata.resourceVersion
          ? { resourceVersion: sandbox.metadata.resourceVersion }
          : {},
      );
      return true;
    } catch (err) {
      if (isKubeStatus(err, 409)) return false;
      throw err;
    }
  };

  const ensureSandbox = (team: TeamRef, userId: string): Promise<SandboxHandle> =>
    provision(team, userId, false).then((r) => r.handle);

  const provision = async (
    team: TeamRef,
    userId: string,
    wake: boolean,
    evalSpec?: EvalClaimSpec,
    podWaitMs: number = podWaitTimeoutMs,
  ): Promise<{ handle: SandboxHandle; resumed: boolean; replaced?: PodTermination }> => {
    assertTeamRef(team);
    assertUserId(userId);
    // KOBE-9: a fresh check immediately before creating anything that runs agent code.
    const verified = await isolation.require();
    const namespace = await ensureTeam(team, verified);
    const claim = await getOrCreateClaim(namespace, team, userId, evalSpec);
    const name = claim.metadata.name;
    const sandboxId = claim.metadata.uid as string;
    const owner = { teamId: team.id, userId, sandboxId };

    const deadline = now() + podWaitMs;
    let resumed = false;
    /** At most one replacement per wake (KOBE-636): a pod that ends again is awaitReady's to report. */
    let replaced: PodTermination | undefined;
    /** The deleted pod's uid: seen again (a stale read), it is still not the next pod. */
    let replacedUid: string | undefined;
    for (let attempt = 0; ; attempt++) {
      const current = await kube.get(CLAIM(namespace, name));
      if (!current || current.metadata.uid !== sandboxId) {
        throw new SandboxProvisioningError(`SandboxClaim ${namespace}/${name} disappeared`);
      }
      const sandboxName = str(current, "status", "sandbox", "name");
      const sandbox = sandboxName ? await kube.get(SANDBOX(namespace, sandboxName)) : undefined;
      if (sandbox && sandboxName) {
        const suspended = str(sandbox, "spec", "operatingMode") === "Suspended";
        if (suspended && wake) {
          // The stored template is replaced wholesale (built with `verified`), then re-checked.
          if (await resume(namespace, sandbox, verified)) {
            resumed = true;
            // Audited when the resume is committed, whether or not its pod then verifies.
            await emit({ action: "sandbox.woken", teamId: team.id, target: { sandboxId, userId } });
          } else if (now() >= deadline) {
            throw new SandboxProvisioningError(`Sandbox ${namespace}/${name} could not be resumed`);
          } else await sleep(Math.min(100 * 2 ** attempt, 1000));
          continue;
        }
        if (suspended) {
          // Nothing runs while suspended, so a stale template is no isolation risk: never delete
          // (the claim owns the volume). A wake replaces the template before anything starts.
          return {
            handle: { sandboxId, namespace, claimName: name, sandboxName, state: "suspended" },
            resumed,
          };
        }
        const templateClass = str(sandbox, "spec", "podTemplate", "spec", "runtimeClassName");
        if (templateClass !== verified.runtimeClassName) {
          return rejectAndDelete(
            owner,
            namespace,
            name,
            `its template uses "${templateClass ?? "none"}"`,
          );
        }
        const podName = sandbox.metadata.annotations?.[POD_NAME_ANNOTATION] ?? sandboxName;
        const pod = await kube.get(POD(namespace, podName));
        // A pod still terminating after a hibernation is not this sandbox's next pod: wait.
        const owned =
          !pod?.metadata.deletionTimestamp &&
          (replacedUid === undefined || pod?.metadata.uid !== replacedUid) &&
          pod?.metadata.ownerReferences?.some(
            (o) => o.controller && o.kind === "Sandbox" && o.uid === sandbox.metadata.uid,
          ) &&
          pod.metadata.labels?.[LABEL_CLAIM_UID] === sandboxId;
        const ended = wake && !replaced && pod && owned ? podTermination(pod) : undefined;
        if (ended) {
          // agent-sandbox never replaces an ended pod itself, but starts one when it is gone. Only
          // the pod: claim, Sandbox and workspace volume stay. Nothing runs in it, so no
          // isolation risk; the next pod is verified below like any other.
          if (!(await deleteWithRetry(POD(namespace, podName)))) {
            throw new SandboxProvisioningError(
              `Sandbox ${namespace}/${name}: its ended pod could not be deleted; retry`,
            );
          }
          replaced = ended;
          replacedUid = pod?.metadata.uid;
          await emit({
            action: "sandbox.restarted",
            teamId: team.id,
            target: { sandboxId, userId, cause: ended.cause, podReason: ended.reason },
          });
          await sleep(Math.min(100 * 2 ** attempt, 1000));
          continue;
        }
        if (pod && owned) {
          const podClass = str(pod, "spec", "runtimeClassName");
          if (podClass !== verified.runtimeClassName) {
            return rejectAndDelete(
              owner,
              namespace,
              name,
              `its pod runs under "${podClass ?? "none"}"`,
              podName,
            );
          }
          if (!(await stillVerified(verified, pod))) {
            return rejectAndDelete(
              owner,
              namespace,
              name,
              "the RuntimeClass handler changed or the class was recreated",
              podName,
            );
          }
          return {
            handle: {
              sandboxId,
              namespace,
              claimName: name,
              sandboxName,
              state: "running",
              podName,
            },
            resumed,
            ...(replaced ? { replaced } : {}),
          };
        }
      }
      if (now() >= deadline) {
        throw new SandboxProvisioningError(
          `Sandbox ${namespace}/${name} has no pod after ${podWaitMs} ms (quota or capacity?)`,
        );
      }
      await sleep(Math.min(100 * 2 ** attempt, 1000));
    }
  };

  const wakeSandbox = async (team: TeamRef, userId: string): Promise<WakeResult> => {
    const { handle, resumed, replaced } = await provision(team, userId, true);
    if (handle.state !== "running") {
      throw new SandboxProvisioningError(
        `Sandbox ${handle.namespace}/${handle.claimName} did not resume`,
      );
    }
    return { handle: { ...handle, state: "running" }, resumed, ...(replaced ? { replaced } : {}) };
  };

  const hibernateSandbox = async (
    team: TeamRef,
    userId: string,
    sandboxId: string,
  ): Promise<HibernateOutcome> => {
    const namespace = teamNamespaceName(team, settings);
    for (let attempt = 0; ; attempt++) {
      const claim = await kube.get(CLAIM(namespace, claimName(userId)));
      if (!claim || claim.metadata.uid !== sandboxId || claim.metadata.deletionTimestamp) {
        return "not_found";
      }
      const sandboxName = str(claim, "status", "sandbox", "name");
      const sandbox = sandboxName ? await kube.get(SANDBOX(namespace, sandboxName)) : undefined;
      if (!sandbox) return "not_found";
      if (str(sandbox, "spec", "operatingMode") === "Suspended") return "already_suspended";
      try {
        await kube.patch(
          SANDBOX(namespace, sandbox.metadata.name),
          { spec: { operatingMode: "Suspended" } },
          sandbox.metadata.resourceVersion
            ? { resourceVersion: sandbox.metadata.resourceVersion }
            : {},
        );
        return "suspended";
      } catch (err) {
        // Changed since read (e.g. the claim controller synced metadata): read it again.
        if (!isKubeStatus(err, 409) || attempt >= 3) throw err;
      }
    }
  };

  return { ensureSandbox, provision, wakeSandbox, hibernateSandbox };
}
