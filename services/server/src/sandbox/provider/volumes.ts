import { logger } from "../../logger.js";
import {
  claimName,
  assertTeamRef,
  assertUserId,
  teamNamespaceName,
  type KubeObject,
  type TeamRef,
} from "../manifests.js";
import { inspectVolume, notReady, type VolumeHealth } from "../volume-loss.js";
import { SandboxProvisioningError } from "./errors.js";
import { CLAIM, POD, PVC, WORKSPACE_PVC, str, workspacePvcName } from "./kube-objects.js";
import type { ProviderContext } from "./context.js";
import type { SandboxProvider } from "./types.js";
import type { DestroyResult, DiscardGuard, DiscardRefusal } from "./types.js";
import { isKubeStatus, type ObjectRef } from "../kube.js";

/**
 * Workspace volumes (KOBE-28, KOBE-733, KOBE-739): destroying a sandbox with or without its
 * volume, deleting a retained volume, waiting out a terminating one, and telling and discarding a
 * lost one (split out of provider.ts by KOBE-710).
 */

/** KOBE-739: a claim with an unrecorded UID must predate a rebuild's mark by this much. */
const CLOCK_SKEW_MARGIN_MS = 5 * 60_000;
/** Attempts after the first of an exact (UID-preconditioned) delete. */
const EXACT_DELETE_RETRIES = 4;

/** KOBE-733: how long a new claim waits for a reclaimed volume of the same name to go. */
const VOLUME_TERMINATING_WAIT_MS = 60_000;

export type VolumeOps = Pick<
  SandboxProvider,
  "destroySandbox" | "deleteVolume" | "volumeHealth" | "discardLostVolume"
> & {
  /** KOBE-733: waits (bounded) until a volume of that name is no longer terminating. */
  readonly untilVolumeNotTerminating: (namespace: string, pvcName: string) => Promise<void>;
};

export function createVolumeOps(ctx: ProviderContext): VolumeOps {
  const { kube, settings, sleep, now, deleteWithRetry } = ctx;

  const destroySandbox = async (
    team: TeamRef,
    userId: string,
    options: { readonly retainVolume: boolean },
  ): Promise<DestroyResult> => {
    const namespace = teamNamespaceName(team, settings);
    const name = claimName(userId);
    const claim = await kube.get(CLAIM(namespace, name));
    if (!claim) return {};
    const sandboxName = str(claim, "status", "sandbox", "name") ?? name;
    const pvc = workspacePvcName(sandboxName);
    let kept: string | undefined;
    if (options.retainVolume && (await kube.get(PVC(namespace, pvc)))) {
      // Before anything is deleted: the Sandbox's deletion would take the volume with it.
      await kube.patch(PVC(namespace, pvc), { metadata: { ownerReferences: null } });
      kept = pvc;
    }
    // By UID (review g72-3): never a claim that replaced this one under the same name. Replaced
    // (review g72-4): stop before the pod and volume deletes, which go by name and would hit the
    // replacement's; the caller rolls back (the reclaim reaper keeps the row) and retries.
    const claimUid = claim.metadata.uid;
    const claimOutcome = claimUid
      ? await deleteExact(CLAIM(namespace, name), claimUid, undefined).catch(
          () => "failed" as const,
        )
      : (await deleteWithRetry(CLAIM(namespace, name)))
        ? ("deleted" as const)
        : ("failed" as const);
    if (claimOutcome === "replaced") {
      throw new SandboxProvisioningError(
        `Sandbox ${namespace}/${name} was replaced while it was being deleted; nothing more deleted`,
      );
    }
    const claimGone = claimOutcome === "deleted";
    const podGone = await deleteWithRetry(POD(namespace, sandboxName));
    if (!claimGone || !podGone) {
      throw new SandboxProvisioningError(
        `Sandbox ${namespace}/${name} could not be deleted; retry`,
      );
    }
    return {
      ...(claim.metadata.uid ? { sandboxId: claim.metadata.uid } : {}),
      ...(kept ? { pvc: kept } : {}),
    };
  };

  const deleteVolume = async (team: TeamRef, pvcName: string): Promise<void> => {
    if (!WORKSPACE_PVC.test(pvcName)) {
      throw new SandboxProvisioningError(`${pvcName} is not a workspace volume; not deleting it`);
    }
    if (!(await deleteWithRetry(PVC(teamNamespaceName(team, settings), pvcName)))) {
      throw new SandboxProvisioningError(`Volume ${pvcName} could not be deleted; retry`);
    }
  };

  /** The workspace PVC's name: from the claim's Sandbox, or the claim's own name (they match). */
  const workspaceVolumeOf = async (team: TeamRef, userId: string) => {
    const namespace = teamNamespaceName(team, settings);
    const name = claimName(userId);
    const claim = await kube.get(CLAIM(namespace, name));
    const sandboxName = (claim ? str(claim, "status", "sandbox", "name") : undefined) ?? name;
    return { namespace, sandboxName, pvcName: workspacePvcName(sandboxName) };
  };

  const volumeHealth = async (team: TeamRef, userId: string): Promise<VolumeHealth> => {
    assertTeamRef(team);
    assertUserId(userId);
    // KOBE-739: detection off (no Node/PV RBAC): a volume is never reported lost.
    if (!settings.volumeLoss.detection) return { state: "present" };
    const { namespace, pvcName } = await workspaceVolumeOf(team, userId);
    return inspectVolume(kube, namespace, pvcName);
  };

  /** Whether a pod sits on a node that is missing or not Ready: its delete could never finish. */
  const onDeadNode = async (pod: KubeObject | undefined): Promise<boolean> => {
    const nodeName = str(pod, "spec", "nodeName");
    if (!nodeName || !settings.volumeLoss.detection) return false;
    const node = await kube.get({ apiVersion: "v1", kind: "Node", name: nodeName });
    return !node || notReady(node);
  };

  /** Why the guard refuses to delete what is there now (newer than the confirmed rebuild). */
  const refusal = (
    claim: KubeObject | undefined,
    pvc: KubeObject | undefined,
    guard: DiscardGuard | undefined,
  ): "newer_claim" | "newer_volume" | undefined => {
    if (!guard) return undefined;
    const created = (o: KubeObject | undefined) => Date.parse(o?.metadata.creationTimestamp ?? "");
    const mark = guard.notCreatedAfter.getTime();
    const after = (o: KubeObject | undefined) => created(o) > mark;
    // Another claim than the one recorded is refused unless it clearly predates the mark (the row
    // can lag the cluster); the margin covers clock skew between the API server and Postgres.
    const otherUid =
      claim !== undefined &&
      guard.claimUid !== null &&
      claim.metadata.uid !== guard.claimUid &&
      !(created(claim) < mark - CLOCK_SKEW_MARGIN_MS);
    if (claim && (otherUid || after(claim))) return "newer_claim";
    if (after(pvc)) return "newer_volume";
    return undefined;
  };

  /**
   * Deletes exactly the object read with `uid` (KOBE-739, review g72-3): a UID precondition, so a
   * call still running after its caller gave up can only ever delete the object it was aimed at.
   * A 409 (another object under that name now) is `replaced`: stop, never retried by name. The
   * signal stops the attempts and the waits between them.
   */
  const deleteExact = async (
    target: ObjectRef,
    uid: string,
    signal: AbortSignal | undefined,
    gracePeriodSeconds?: number,
  ): Promise<"deleted" | "replaced"> => {
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) {
        throw new SandboxProvisioningError(`Deleting ${target.kind} ${target.name} was stopped`);
      }
      try {
        await kube.delete(target, {
          preconditions: { uid },
          ...(gracePeriodSeconds === undefined ? {} : { gracePeriodSeconds }),
        });
        return "deleted";
      } catch (err) {
        if (isKubeStatus(err, 409)) return "replaced";
        if (attempt >= EXACT_DELETE_RETRIES) {
          throw new SandboxProvisioningError(`${target.kind} ${target.name} could not be deleted`);
        }
        await sleep(200 * 2 ** attempt);
      }
    }
  };

  const discardLostVolume = async (
    team: TeamRef,
    userId: string,
    guard?: DiscardGuard,
    signal?: AbortSignal,
  ): Promise<DestroyResult & { readonly pvc: string; readonly refused?: DiscardRefusal }> => {
    assertTeamRef(team);
    assertUserId(userId);
    const { namespace, sandboxName, pvcName } = await workspaceVolumeOf(team, userId);
    if (!WORKSPACE_PVC.test(pvcName)) {
      throw new SandboxProvisioningError(`${pvcName} is not a workspace volume; not deleting it`);
    }
    // Read once; every delete below names these objects by UID.
    const claim = await kube.get(CLAIM(namespace, claimName(userId)));
    const pvc = await kube.get(PVC(namespace, pvcName));
    const pod = await kube.get(POD(namespace, sandboxName));
    const refused = refusal(claim, pvc, guard);
    if (refused) return { pvc: pvcName, refused };
    const stuck = await onDeadNode(pod);
    // The claim (its Sandbox goes with it by owner reference), the pod (at once when it sits on a
    // dead node: it could never finish terminating), then the volume itself.
    const steps: [ObjectRef, string | undefined, number | undefined][] = [
      [CLAIM(namespace, claim?.metadata.name ?? claimName(userId)), claim?.metadata.uid, undefined],
      [POD(namespace, sandboxName), pod?.metadata.uid, stuck ? 0 : undefined],
      [PVC(namespace, pvcName), pvc?.metadata.uid, undefined],
    ];
    for (const [target, uid, grace] of steps) {
      if (!uid) continue;
      if ((await deleteExact(target, uid, signal, grace)) === "replaced") {
        return { pvc: pvcName, refused: "replaced" };
      }
    }
    return { ...(claim?.metadata.uid ? { sandboxId: claim.metadata.uid } : {}), pvc: pvcName };
  };

  const untilVolumeNotTerminating = async (namespace: string, pvcName: string): Promise<void> => {
    const end = now() + VOLUME_TERMINATING_WAIT_MS;
    for (;;) {
      const pvc = await kube.get(PVC(namespace, pvcName));
      if (!pvc?.metadata.deletionTimestamp) return;
      if (now() >= end) {
        logger.warn({ namespace, pvc: pvcName }, "old workspace volume still being deleted");
        throw new SandboxProvisioningError(
          `Old workspace volume ${namespace}/${pvcName} still being deleted; retry`,
        );
      }
      await sleep(1000);
    }
  };

  return {
    destroySandbox,
    deleteVolume,
    volumeHealth,
    discardLostVolume,
    untilVolumeNotTerminating,
  };
}
