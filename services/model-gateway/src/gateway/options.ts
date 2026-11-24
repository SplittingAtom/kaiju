import type { SessionTokenClaims, ThinkingLevel } from "@kaiju/protocol";
import type { SessionVerifyKeys } from "@kaiju/session-token";
import type { RunTokenSubject } from "@kaiju/db";
import type { Logger } from "pino";
import type { ByteBudget, CallLimiter, RequestRate } from "../limits.js";
import type { PrincipalCache } from "../principals.js";
import type { GatewayTracing } from "../trace-placement.js";
import type { ServerCallOptions } from "../server-call.js";
import type { CallGate, UsageSink } from "../seams.js";

/**
 * The model gateway shim (KOBE-40, spec D30; principle 2 "secrets never enter the sandbox"). The
 * only way a sandbox reaches a model:
 *
 * 1. the sandbox's `kobe.model-gateway` session token (EdDSA pinned, own public key; other
 *    audiences' tokens fail) in any header a model SDK uses for its API key;
 * 2. an inference path (routes.ts) — never Bifrost's admin API;
 * 3. the token's member and sandbox still live (principals.ts; cached ≤ a few seconds);
 * 4. run attribution: a run token (`x-kaiju-run-token`, KOBE-118: verified, recorded and active,
 *    bound to this team and sandbox, the run id comes from it), else the legacy advisory
 *    `x-kaiju-run-id` (must be leased to this sandbox) unless the token is mandatory;
 * 5. concurrency limits and the {@link CallGate} seam (KOBE-42);
 * 6. forwarded to Bifrost with only allowlisted headers plus `x-bf-vk: <member's virtual key>`,
 *    so Bifrost applies that member's team model allowlist (and, with KOBE-42, budgets);
 * 7. the response streamed back unbuffered; a client that goes away cancels the upstream call.
 *
 * Server calls (KOBE-234, server-call.ts) take the same path with their own identity: the
 * `x-kaiju-server-call` token instead of 1., the member without a sandbox in 3., the token's run
 * in 4., the contract's body and the token's model and cap, and the purpose's budget soft limit.
 */
export interface GatewayOptions {
  readonly verify: (token: string) => SessionTokenClaims;
  readonly principals: PrincipalCache;
  /** Whether `runId` is an active run leased to `sandboxId` in `teamId` (cached by the caller). */
  readonly isRunLeased: (teamId: string, runId: string, sandboxId: string) => Promise<boolean>;
  /** Run-bound tokens (KOBE-118). */
  readonly runTokens: {
    /** Public key(s) of the model-gateway pair (KOBE-521): the gateway verifies, never signs. */
    readonly keys: SessionVerifyKeys;
    /** The server's record: not revoked or expired, run active on that sandbox (cached by caller). */
    readonly isActive: (subject: RunTokenSubject) => Promise<boolean>;
    /** Enforcement: a call without a run token is refused (off for rollout). */
    readonly require: boolean;
  };
  /**
   * A run's recorded thinking level (KOBE-260; cached by the caller, it never changes). Absent:
   * calls use the model's default level.
   */
  readonly runThinking?: (
    teamId: string,
    runId: string,
  ) => Promise<ThinkingLevel | null | undefined>;
  /** Run traces (KOBE-274); absent: spans of sandbox calls hang under the run's root. */
  readonly tracing?: GatewayTracing;
  /** Server-originated calls (KOBE-234); without it every server-call token is refused. */
  readonly serverCalls?: ServerCallOptions;
  /**
   * Shared eval cases for a running Orbit eval Job (KOBE-276): `GET /kobe/eval-cases` with the
   * eval's own token answers its `cases.json` (null: not that member's running eval, or none).
   * Absent: the route is a 404.
   */
  readonly evalCases?: {
    readonly load: (teamId: string, userId: string, evalId: string) => Promise<string | null>;
  };
  readonly bifrostUrl: string;
  readonly limiter: CallLimiter;
  /** Request bytes held in memory, per sandbox and in total. */
  readonly bytes: ByteBudget;
  /** Requests per sandbox per second (before anything touches the database). */
  readonly rate: RequestRate;
  readonly gate: CallGate;
  readonly sink: UsageSink;
  /** Bifrost refused a virtual key Kaiju holds: ask the sync to re-push (NOTIFY `resync`). */
  readonly onBifrostForgotKey: () => void;
  readonly logger: Logger;
  readonly settings: { readonly maxBodyBytes: number; readonly idleTimeoutMs: number };
  readonly ready: () => boolean;
}
