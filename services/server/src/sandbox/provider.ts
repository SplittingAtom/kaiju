import { createClaimOps } from "./provider/claims.js";
import { createProviderContext } from "./provider/context.js";
import { createEvalSandboxOps } from "./provider/eval-sandboxes.js";
import { createIdentityOps } from "./provider/identity.js";
import { createIsolationOps } from "./provider/isolation.js";
import { createReadinessOps } from "./provider/readiness.js";
import { createTeamOps } from "./provider/team.js";
import type { SandboxProvider, SandboxProviderOptions } from "./provider/types.js";
import { createVolumeOps } from "./provider/volumes.js";

/**
 * agent-sandbox provider (spec D11, D12; KOBE-22). One namespace per team with a default-deny
 * NetworkPolicy, a ResourceQuota, a LimitRange, the sandbox template and a warm pool; one
 * SandboxClaim per (user, team) whose UID is the sandbox id.
 *
 * Isolation (KOBE-9 binding requirements): every create path calls isolation.require()
 * immediately before creating, passes the VerifiedIsolation into the spec builders, then reads the
 * result back and deletes it if it is not running under the verified RuntimeClass and handler.
 * The chart's ValidatingAdmissionPolicies pin the same rule at admission time.
 *
 * The parts live in `provider/` (KOBE-710): `context.ts` (what every part shares), `team.ts`
 * (team namespaces), `claims.ts` (a member's claim, wake, hibernate), `readiness.ts` (waiting for
 * Ready), `volumes.ts` (destroy, volume delete, lost volumes), `identity.ts` (bootstrap tokens),
 * `isolation.ts` (the reconciler, liveness), `eval-sandboxes.ts` (skill eval claims), `errors.ts`,
 * `kube-objects.ts` and `types.ts`. This file composes them and keeps every public name importable
 * from here.
 */

export { POD_WAIT_TIMEOUT_MS, READY_TIMEOUT_MS } from "./provider/context.js";
export {
  SandboxAuthError,
  SandboxProvisioningError,
  TeamQuotaDegradedError,
  rancherRefusal,
} from "./provider/errors.js";
export { workspacePvcName } from "./provider/kube-objects.js";
export { ADMISSION_PROBE_NAMESPACE, TEAM_RECONVERGE_MS } from "./provider/team.js";
export type {
  BootstrapIdentity,
  DestroyResult,
  EvalSandboxInfo,
  HibernateOutcome,
  ReadyOutcome,
  ReconcileResult,
  SandboxAuditEvent,
  SandboxHandle,
  SandboxProvider,
  SandboxProviderOptions,
  UnassignedIdentity,
  WakeResult,
} from "./provider/types.js";

export function createSandboxProvider(options: SandboxProviderOptions): SandboxProvider {
  const ctx = createProviderContext(options);
  const team = createTeamOps(ctx);
  const volumes = createVolumeOps(ctx);
  const claims = createClaimOps(ctx, {
    ensureTeam: team.ensureTeam,
    untilVolumeNotTerminating: volumes.untilVolumeNotTerminating,
  });
  const readiness = createReadinessOps(ctx);
  const identity = createIdentityOps(ctx);
  const isolation = createIsolationOps(ctx);
  const evals = createEvalSandboxOps(ctx, { provision: claims.provision });

  return {
    ensureTeam: team.ensureTeam,
    reconcileTeams: team.reconcileTeams,
    ensureSandbox: claims.ensureSandbox,
    wakeSandbox: claims.wakeSandbox,
    awaitReady: readiness.awaitReady,
    hibernateSandbox: claims.hibernateSandbox,
    destroySandbox: volumes.destroySandbox,
    deleteVolume: volumes.deleteVolume,
    volumeHealth: volumes.volumeHealth,
    discardLostVolume: volumes.discardLostVolume,
    identifyBootstrapToken: identity.identifyBootstrapToken,
    recheckAssignment: identity.recheckAssignment,
    reconcileIsolation: isolation.reconcileIsolation,
    isLive: isolation.isLive,
    createEvalSandbox: evals.createEvalSandbox,
    deleteEvalSandbox: evals.deleteEvalSandbox,
    listEvalSandboxes: evals.listEvalSandboxes,
  };
}
