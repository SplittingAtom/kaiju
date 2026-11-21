import type { Logger } from "pino";
import type { SandboxProvider } from "../sandbox/provider.js";
import type { StallDiagnosis } from "../sandbox/stall-diagnosis.js";
import { SandboxWakeError } from "../sandbox-wire/types.js";

/**
 * What a member sees when their workspace cannot start for a cluster reason (KOBE-192): no node,
 * volume or event text. The reason is in the audit log (`sandbox.wake_stalled`) and the server log.
 */
export const WORKSPACE_UNAVAILABLE_MESSAGE =
  "Your workspace could not be started because the cluster could not provide it. Ask your site admin to check the cluster, then try again.";

/**
 * What a member sees when their sandbox's pod ended (evicted, killed) and the wake's one
 * replacement did not come up either (KOBE-636). Same text as `FAILURE_MESSAGES.sandbox_failed`.
 */
export const SANDBOX_FAILED_MESSAGE =
  "Your sandbox stopped (it may have run out of temporary space or memory) and could not be restarted. Your files in /workspace are kept. Send your message again; if this keeps happening, ask your site admin.";

/**
 * What a member sees when the team's volume quota has no room for their workspace (KOBE-733). Same
 * text as `FAILURE_MESSAGES.workspace_quota_exhausted`.
 */
export const WORKSPACE_QUOTA_MESSAGE =
  "Your workspace could not be started because your team has used all of its workspace storage. Ask your team admin or site admin to free or raise the team's workspace quota, then try again.";

/** What a site admin can do, by cause; appended to the audit detail (docs/install.md). */
export const REMEDY: Readonly<Record<StallDiagnosis["cause"], string>> = {
  volume_unschedulable:
    "Remedy: free or add Longhorn disk space or raise over-provisioning (docs/install.md, Longhorn sizing); the next message retries",
  volume_attach:
    "Remedy: check the Longhorn volume and node; if the workspace never ran, delete its PVC by hand (docs/install.md)",
  scheduling: "Remedy: add node capacity or check taints and quotas",
  image_pull: "Remedy: check the sandbox image tag, registry and pull secrets",
  pod_failed:
    "Remedy: an eviction for the home or tmp emptyDir means raise sandbox.homeSize or sandbox.tmpSize; the next message replaces the pod again",
  volume_quota:
    "Remedy: raise sandbox.teamQuota (persistentvolumeclaims, requests.storage: members x workspace size + warm pool) or turn on sandbox.hibernation.reclaim (docs/install.md, team quota sizing)",
  unknown: "Remedy: kubectl describe the sandbox pod in the team namespace",
};

export type ReadyProvider = Pick<SandboxProvider, "awaitReady">;

export interface StallReport {
  readonly sandboxId: string;
  readonly stall: StallDiagnosis;
}

export interface EnsureReadyOptions {
  readonly provider: ReadyProvider;
  readonly team: { readonly id: string; readonly slug: string };
  readonly userId: string;
  /** Start of this wake (epoch ms): older cluster events are not about it. */
  readonly since: number;
  readonly log: Logger;
  readonly onStalled: (report: StallReport) => Promise<void>;
}

/**
 * Waits for the woken sandbox pod to be Ready. If it is not (a definite unrecoverable signal, or
 * the wake budget ran out), records why for site admins and fails the wake with
 * `workspace_unavailable` (`sandbox_failed` when the pod ended: KOBE-636). Nothing is ever deleted
 * here: replacing an ended pod is the wake's, once (`wakeSandbox`), and the rest the admin's.
 */
export async function ensureReady(options: EnsureReadyOptions): Promise<void> {
  const { provider, team, userId, log } = options;
  const outcome = await provider.awaitReady(team, userId, options.since);
  if (outcome.ready) return;
  const report = { sandboxId: outcome.sandboxId, stall: outcome.stall };
  log.error(
    {
      team_id: team.id,
      user_id: userId,
      sandbox_id: report.sandboxId,
      cause: report.stall.cause,
      detail: report.stall.detail,
      volume_phase: report.stall.volumePhase,
      definite: report.stall.definite,
    },
    "sandbox not ready: failing the wake",
  );
  await options.onStalled(report).catch((err: unknown) => log.error({ err }, "audit failed"));
  if (report.stall.cause === "pod_failed") {
    throw new SandboxWakeError("sandbox_failed", SANDBOX_FAILED_MESSAGE);
  }
  if (report.stall.cause === "volume_quota") {
    throw new SandboxWakeError("workspace_quota_exhausted", WORKSPACE_QUOTA_MESSAGE);
  }
  throw new SandboxWakeError("workspace_unavailable", WORKSPACE_UNAVAILABLE_MESSAGE);
}
