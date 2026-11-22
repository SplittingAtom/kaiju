import type { IsolationGate, VerifiedIsolation } from "../../isolation/gate.js";
import type { SandboxSettings } from "../config.js";
import type { EvalClaimSpec } from "../eval-manifests.js";
import type { KubeClient } from "../kube.js";
import type { TeamRef } from "../manifests.js";
import type { PodTermination } from "../pod-termination.js";
import type { SandboxPrincipal } from "../session-token.js";
import type { StallDiagnosis } from "../stall-diagnosis.js";
import type { TeamReconcileSummary } from "../team-reconcile.js";
import type { VolumeHealth } from "../volume-loss.js";

/** The sandbox provider's public types (KOBE-22; split out of provider.ts by KOBE-710). */

/** Outcome of {@link SandboxProvider.hibernateSandbox}. */
export type HibernateOutcome = "suspended" | "already_suspended" | "not_found";

export interface WakeResult {
  readonly handle: SandboxHandle & { readonly state: "running" };
  /** True when this call resumed a hibernated sandbox (false: it was running, or new). */
  readonly resumed: boolean;
  /**
   * Set when this wake found the sandbox's pod ended (evicted, killed) and deleted it so
   * agent-sandbox starts a new one (KOBE-636): why the old pod ended.
   */
  readonly replaced?: PodTermination;
}

/** Outcome of {@link SandboxProvider.awaitReady}. */
export type ReadyOutcome =
  | { readonly ready: true }
  | { readonly ready: false; readonly sandboxId: string; readonly stall: StallDiagnosis };

export interface SandboxHandle {
  /** SandboxClaim UID: the session token `sub`. */
  readonly sandboxId: string;
  readonly namespace: string;
  readonly claimName: string;
  readonly sandboxName: string;
  /** "suspended": hibernated (no pod); waking is KOBE-25's. */
  readonly state: "running" | "suspended";
  readonly podName?: string;
}

export type BootstrapIdentity =
  | {
      readonly state: "assigned";
      readonly principal: SandboxPrincipal;
      readonly namespace: string;
      readonly podName: string;
    }
  /** A warm-pool pod not claimed yet (or its claim metadata is still propagating): retry. */
  | UnassignedIdentity;

/** A reviewed bootstrap token's pod that nobody has claimed yet; see `recheckAssignment`. */
export interface UnassignedIdentity {
  readonly state: "unassigned";
  readonly namespace: string;
  readonly podName: string;
  readonly podUid: string;
  readonly teamId: string;
}

export interface SandboxProviderOptions {
  readonly kube: KubeClient;
  readonly isolation: Pick<IsolationGate, "require">;
  readonly settings: SandboxSettings;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly podWaitTimeoutMs?: number;
  /** How long a woken sandbox pod may take to be Ready (KOBE-192): the wire wake budget. */
  readonly readyTimeoutMs?: number;
  /**
   * The configured RuntimeClass (KOBE_RUNTIME_CLASS). Used only by the reconciler, to recognise a
   * definitive loss of isolation (class deleted or no longer isolating) when require() fails.
   */
  readonly runtimeClassName?: string;
  /** Receives audit events; must not throw (failures are the recorder's to log). */
  readonly audit?: (event: SandboxAuditEvent) => Promise<void> | void;
}

/** Audit events the provider emits (recorded by the caller: packages/db `sandbox.*`). */
export type SandboxAuditEvent =
  | {
      readonly action: "sandbox.created";
      readonly teamId: string;
      readonly target: { readonly sandboxId: string; readonly userId: string };
    }
  | {
      readonly action: "sandbox.woken";
      readonly teamId: string;
      readonly target: { readonly sandboxId: string; readonly userId: string };
    }
  | {
      readonly action: "sandbox.restarted";
      readonly teamId: string;
      readonly target: {
        readonly sandboxId: string;
        readonly userId: string;
        readonly cause: PodTermination["cause"];
        readonly podReason: string;
      };
    }
  | {
      readonly action: "sandbox.destroyed";
      readonly teamId: string;
      readonly target: {
        readonly sandboxId?: string;
        readonly userId?: string;
        readonly pod?: string;
        readonly reason: "isolation_mismatch" | "isolation_lost";
      };
    };

/**
 * KOBE-739 (review g72-2): what a rebuild's discard may delete. Only the claim the rebuild was
 * confirmed for: a claim with another UID, or a claim or volume created after the rebuild was
 * marked, is refused (`refused` in the result) and nothing is deleted.
 */
/**
 * Why a discard deleted nothing (more): a claim or volume newer than the confirmed rebuild, or an
 * object replaced under the same name while the discard ran (a UID precondition failed).
 */
export type DiscardRefusal = "newer_claim" | "newer_volume" | "replaced";

export interface DiscardGuard {
  /** The claim UID the row recorded when the rebuild was marked (null: none recorded). */
  readonly claimUid: string | null;
  /** When the rebuild was marked. */
  readonly notCreatedAfter: Date;
}

/** What {@link SandboxProvider.destroySandbox} removed; empty when there was no sandbox. */
export interface DestroyResult {
  /** The deleted claim's UID. */
  readonly sandboxId?: string;
  /** The workspace volume that was kept (detached from its owner), by name. */
  readonly pvc?: string;
}

export interface ReconcileResult {
  /** Pods deleted (namespace/name). */
  readonly deleted: readonly string[];
  readonly reason?: string;
}

/** An eval sandbox claim as the reaper sees it (KOBE-325). */
export interface EvalSandboxInfo {
  readonly teamId: string;
  readonly namespace: string;
  readonly claimName: string;
  readonly threadId: string;
  readonly userId: string | undefined;
  readonly evalRunId: string | undefined;
  readonly createdAt: number;
}

export interface SandboxProvider {
  /** Creates or converges the team's namespace and everything in it; returns the namespace. */
  ensureTeam(team: TeamRef, isolation: VerifiedIsolation): Promise<string>;
  /** The (user, team) sandbox, created from the warm pool if it does not exist yet. */
  ensureSandbox(team: TeamRef, userId: string): Promise<SandboxHandle>;
  /**
   * The (user, team) sandbox, running (KOBE-25, D14): created if missing, resumed if hibernated.
   * A resume calls isolation.require() first, re-applies the pod template built from the current
   * settings with that VerifiedIsolation, sets `operatingMode: Running` (guarded by the Sandbox's
   * resourceVersion, so concurrent wakes resume once), then verifies the new pod like
   * ensureSandbox (deleted on a RuntimeClass/handler mismatch, KOBE-9).
   */
  wakeSandbox(team: TeamRef, userId: string): Promise<WakeResult>;
  /**
   * Waits for the sandbox pod to be Ready, up to `readyTimeoutMs`, reading the events of this wake
   * (`since`, epoch ms) about the pod and the workspace volume as it waits. Returns early, not
   * ready, only on a definite unrecoverable signal (replica cannot be scheduled, no capacity, an
   * attach failing repeatedly, an image that cannot be pulled); progress such as Pulling or
   * ContainerCreating keeps it waiting. At the budget it returns the diagnosis, `unknown`
   * included (KOBE-192). Read-only: it never deletes anything.
   */
  awaitReady(team: TeamRef, userId: string, since: number): Promise<ReadyOutcome>;
  /**
   * Hibernates `sandboxId` (D14): `operatingMode: Suspended` — agent-sandbox deletes the pod and
   * keeps the claim and its volume. Idempotent; no isolation check (stopping is always safe). The
   * caller decides when (KOBE-25 hibernator, under the sandbox row's lock).
   */
  hibernateSandbox(team: TeamRef, userId: string, sandboxId: string): Promise<HibernateOutcome>;
  /**
   * Whether `sandboxId` is still the live sandbox of (team, user): its claim `u-<user>` exists in
   * the team namespace with that UID, is not being deleted, and is annotated for that team and
   * user. The sandbox wire (KOBE-24) checks it at connect and while connected. API errors throw.
   */
  /** With `evalThreadId` (KOBE-325): whether `sandboxId` is that eval thread's claim instead. */
  isLive(team: TeamRef, userId: string, sandboxId: string, evalThreadId?: string): Promise<boolean>;
  /**
   * Offboarding (KOBE-28, D12): deletes the (team, user) claim, Sandbox and pod at once. With
   * `retainVolume` the `/workspace` PVC is first detached from its owner (agent-sandbox would
   * delete it with the Sandbox) and survives until {@link deleteVolume}; if the detach fails
   * nothing is deleted. Idempotent: a missing claim returns `{}`. Throws when a delete fails
   * (the caller retries).
   */
  destroySandbox(
    team: TeamRef,
    userId: string,
    options: { readonly retainVolume: boolean },
  ): Promise<DestroyResult>;
  /** Deletes a retained workspace volume (`workspace-u-<user>`) of the team; missing is fine. */
  deleteVolume(team: TeamRef, pvcName: string): Promise<void>;
  /**
   * KOBE-739: whether the (team, user) workspace volume is lost or its node down (`volume-loss.ts`),
   * found by its claim's Sandbox name, or by the claim's name when the claim is gone. Read-only;
   * read errors throw (the caller never treats them as lost). `present` when detection is off.
   */
  volumeHealth(team: TeamRef, userId: string): Promise<VolumeHealth>;
  /**
   * KOBE-739: the Kubernetes half of rebuilding a lost workspace: deletes the claim without
   * keeping the volume, force-deletes its pod when that pod sits on a node that is missing or not
   * Ready (it could never finish terminating, and its volume would stay protected), then deletes
   * the volume. Every delete carries the UID read at the start (a 409 stops it: `replaced`).
   * Idempotent. The caller has decided the volume is lost; object storage is untouched.
   */
  discardLostVolume(
    team: TeamRef,
    userId: string,
    guard?: DiscardGuard,
    /** Stops the remaining deletes and their retries (the caller timed out). */
    signal?: AbortSignal,
  ): Promise<DestroyResult & { readonly pvc: string; readonly refused?: DiscardRefusal }>;
  /** Verifies a sandbox pod's bootstrap token (TokenReview) and resolves who it is. */
  identifyBootstrapToken(token: string): Promise<BootstrapIdentity>;
  /**
   * KOBE-417: re-resolves an already reviewed, unassigned pod while its session request is held.
   * One pod GET while it stays unclaimed (no TokenReview, isolation or namespace read); the full
   * claim and isolation checks once it carries a claim label. Throws SandboxAuthError when the
   * pod is gone or replaced.
   */
  recheckAssignment(identity: UnassignedIdentity): Promise<BootstrapIdentity>;
  /**
   * KOBE-325: creates a skill eval execution's ephemeral sandbox (claim `e-<thread>`, the eval
   * template, its own quota) after a fresh isolation check, and waits up to `podWaitMs` for its
   * pod under the verified RuntimeClass (the same read-back check as a member's sandbox).
   */
  createEvalSandbox(team: TeamRef, spec: EvalClaimSpec, podWaitMs?: number): Promise<SandboxHandle>;
  /** Deletes an eval thread's sandbox claim (its pod goes with it); a missing one is fine. */
  deleteEvalSandbox(team: TeamRef, threadId: string): Promise<boolean>;
  /** Every eval sandbox claim in every team namespace (the reaper's list). */
  listEvalSandboxes(): Promise<EvalSandboxInfo[]>;
  /**
   * Deletes pods in team namespaces that do not run under the verified RuntimeClass, or predate
   * the current RuntimeClass object. If isolation is definitively gone (class deleted or not
   * isolating) every team pod is deleted; claims and volumes are kept. API errors change nothing.
   */
  reconcileIsolation(): Promise<ReconcileResult>;
  /**
   * Converges every existing team namespace to the current server version with the same function
   * `ensureTeam` uses (KOBE-115): after an upgrade, awake teams get new NetworkPolicies without
   * waiting for their next sandbox setup. Requires verified isolation like any create path.
   */
  reconcileTeams(): Promise<TeamReconcileSummary>;
}
