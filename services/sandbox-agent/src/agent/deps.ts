import type { RunStartFrame } from "@kobe/protocol";
import type { Config } from "../config.js";
import type { EgressWiring } from "../egress/egress-wiring.js";
import type { McpWiring } from "../mcp/pi-mcp-config.js";
import type { ModelWiring } from "../models/types.js";
import type { KernelManager } from "../notebook/manager.js";
import type { PiIdentities } from "../pi/identities.js";
import type { SkillEvalHooks } from "../skill-eval/hooks.js";
import type { SkillStore } from "../skills/store.js";
import type { ExecWiring } from "../threads/exec-wiring.js";
import type { BackoffPolicy } from "../wire/backoff.js";
import type { WireLogger } from "../wire/client.js";
import type { PaceLimits } from "../wire/pacer.js";
import type { ConflictListener, PushedFile } from "../workspace/sync.js";

/** What `Agent` (agent.ts) is built from. */
export interface AgentDeps {
  readonly config: Config;
  readonly logger: WireLogger;
  readonly readToken: () => Promise<string>;
  /** The server refused the wire token (KOBE-522): the session client re-trades. */
  readonly onTokenRejected?: (token: string, reason: string) => void;
  readonly agentVersion: string;
  readonly piVersion: string;
  readonly home: string;
  readonly parentEnv: Readonly<Record<string, string | undefined>>;
  readonly onExit: (code: number) => void;
  readonly backoff?: BackoffPolicy;
  readonly heartbeatTimeoutMs?: number;
  /** Outbound send pace (KOBE-429); default `SANDBOX_SEND_PACE`. Tests only. */
  readonly pace?: PaceLimits;
  readonly policyReadyTimeoutMs?: number;
  /** SIGTERM: how long a lost run's report waits for its frames to be acked (KOBE-444). */
  readonly lostAckTimeoutMs?: number;
  /**
   * Root-owned extensions (or `builtin:<name>`) loaded before kobe-policy, which is always last
   * (KOBE-62 adds `builtin:mcp` here).
   */
  readonly extensions?: readonly string[];
  /** Model gateway wiring (KOBE-41); absent when the sandbox has no model access. */
  readonly models?: ModelWiring | undefined;
  /** Egress for Pi's tools (KOBE-39); absent outside Kobe's pods. */
  readonly egress?: EgressWiring | undefined;
  /** The root-owned BASH_ENV script for tools when egress is not wired (KOBE-235). */
  readonly toolEnvScript?: string | undefined;
  /** mcp-proxy wiring (KOBE-111); absent: no `mcp` capability, runs get no connector tools. */
  readonly mcp?: McpWiring | undefined;
  /** Pi identities (KOBE-71); absent: Pi runs as the agent's uid. */
  readonly identities?: PiIdentities | undefined;
  /** Workspace sync (KOBE-27): restore before runs, push after them and before stopping. */
  readonly workspace?: WorkspaceHooks;
  /**
   * kobe-tools (KOBE-128): the root-owned extension file, as checked at startup. Present: Pi gets
   * the fd-4 channel and the agent announces the `artifacts` capability.
   */
  readonly toolsExtension?: string | undefined;
  /**
   * The tool executor (KOBE-167): the root-owned kobe-exec extension file and where the executor
   * program lives. Present: every Pi's built-in tools run in an executor under its partner uid.
   */
  readonly exec?: { readonly extension: string; readonly wiring: ExecWiring } | undefined;
  /** Skills store (KOBE-82); absent: runs that list skills fail instead of starting without them. */
  readonly skills?: SkillStore;
  /** Skill eval fixtures and snapshots (KOBE-325); present: the agent announces `skill_eval`. */
  readonly skillEval?: SkillEvalHooks;
  /** Thread kernels (KOBE-464); present: the agent announces `notebooks`. */
  readonly kernels?: KernelManager | undefined;
}

/** What the agent needs of workspace sync (`workspace/sync.ts`). */
export interface WorkspaceHooks {
  beforeRun(frame: RunStartFrame): Promise<void>;
  runEnded(): void;
  /**
   * Push one file now and return its synced entry (`share_file`, KOBE-149). Absent: this agent
   * has no workspace sync, so it does not announce the `files` capability.
   */
  pushPath?(rel: string): Promise<PushedFile>;
  /**
   * Push every local change now (`commit_project`, KOBE-580: the server commits what the
   * manifest holds). Absent: `commit_project` answers `not_allowed`.
   */
  pushAll?(): Promise<unknown>;
  flush(deadlineMs: number): Promise<unknown>;
  /**
   * The member moved files (`workspace.moved`, KOBE-304): replay the server's moves as local
   * renames now. Present: the agent announces `workspace_moves`.
   */
  movedOnServer?(): void;
  /**
   * Push every local change now and resolve whether it committed (`workspace.sync_now`,
   * KOBE-599: the Files panel's Refresh). Never rejects. Present: the agent announces
   * `workspace_sync_now`.
   */
  syncNow?(): Promise<boolean>;
  /**
   * Hear about conflict copies the sync makes (KOBE-492). Present (with kobe-tools, which tells
   * the model): the agent announces `sync_conflicts` and reports each one to the server.
   */
  onConflict?(listener: ConflictListener): void;
}
