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
import type { DestroyResult, DiscardGuard } from "./types.js";

/**
 * Workspace volumes (KOBE-28, KOBE-733, KOBE-739): destroying a sandbox with or without its
 * volume, deleting a retained volume, waiting out a terminating one, and telling and discarding a
 * lost one (split out of provider.ts by KOBE-710).
 */

/** KOBE-739: a claim with an unrecorded UID must predate a rebuild's mark by this much. */
const CLOCK_SKEW_MARGIN_MS = 5 * 60_000;

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
    const namespace = teamNamespaceName(team);
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
    const claimGone = await deleteWithRetry(CLAIM(namespace, name));
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
    if (!(await deleteWithRetry(PVC(teamNamespaceName(team), pvcName)))) {
      throw new SandboxProvisioningError(`Volume ${pvcName} could not be deleted; retry`);
    }
  };

  /** The workspace PVC's name: from the claim's Sandbox, or the claim's own name (they match). */
  const workspaceVolumeOf = async (team: TeamRef, userId: string) => {
    const namespace = teamNamespaceName(team);
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
  const refusal = async (
    namespace: string,
    userId: string,
    pvcName: string,
    guard: DiscardGuard | undefined,
  ): Promise<"newer_claim" | "newer_volume" | undefined> => {
    if (!guard) return undefined;
    const created = (o: KubeObject | undefined) => Date.parse(o?.metadata.creationTimestamp ?? "");
    const mark = guard.notCreatedAfter.getTime();
    const after = (o: KubeObject | undefined) => created(o) > mark;
    const claim = await kube.get(CLAIM(namespace, claimName(userId)));
    // Another claim than the one recorded is refused unless it clearly predates the mark (the row
    // can lag the cluster); the margin covers clock skew between the API server and Postgres.
    const otherUid =
      claim !== undefined &&
      guard.claimUid !== null &&
      claim.metadata.uid !== guard.claimUid &&
      !(created(claim) < mark - CLOCK_SKEW_MARGIN_MS);
    if (claim && (otherUid || after(claim))) return "newer_claim";
    if (after(await kube.get(PVC(namespace, pvcName)))) return "newer_volume";
    return undefined;
  };

  const discardLostVolume = async (
    team: TeamRef,
    userId: string,
    guard?: DiscardGuard,
  ): Promise<
    DestroyResult & { readonly pvc: string; readonly refused?: "newer_claim" | "newer_volume" }
  > => {
    assertTeamRef(team);
    assertUserId(userId);
    const { namespace, sandboxName, pvcName } = await workspaceVolumeOf(team, userId);
    const refused = await refusal(namespace, userId, pvcName, guard);
    if (refused) return { pvc: pvcName, refused };
    const pod = await kube.get(POD(namespace, sandboxName));
    const stuck = await onDeadNode(pod);
    const destroyed = await destroySandbox(team, userId, { retainVolume: false });
    if (stuck) await kube.delete(POD(namespace, sandboxName), { gracePeriodSeconds: 0 });
    await deleteVolume(team, pvcName);
    return { ...(destroyed.sandboxId ? { sandboxId: destroyed.sandboxId } : {}), pvc: pvcName };
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
