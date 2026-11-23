import type { SandboxIdentity } from "./auth.js";
import type { ConnectionReason, ConnectionRecord, GitTraffic } from "./connection-audit.js";
import type { ConnectionBytes, ProxyDeps } from "./proxy-deps.js";

export interface UpgradeAttempt {
  readonly identity: SandboxIdentity;
  readonly host: string | undefined;
  readonly port: number | undefined;
  readonly started: number;
  /** A git smart-HTTP request (KOBE-763): audited with the repository and service. */
  readonly git?: GitTraffic;
}

export interface UpgradeContext {
  readonly deps: ProxyDeps;
  /** Counts the request in the connection audit and logs it (proxy-outcome.ts `finishAttempt`). */
  finish(
    a: UpgradeAttempt,
    outcome: ConnectionRecord["outcome"],
    reason: ConnectionReason | undefined,
    bytes?: ConnectionBytes,
    upgraded?: boolean,
  ): void;
  /** Records an `egress.blocked` event (blocked-reporter). */
  report(a: UpgradeAttempt, reason: ConnectionReason, requestAccess: boolean): void;
  /** Rate-limited log of a refused authentication. */
  authRefused(source: string, reason: string): void;
}
