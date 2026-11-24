import { SYSTEM_ACTOR, sql, withTeam, type KaijuTx } from "@kaiju/db";
import type { Context } from "hono";
import { recordAudit, type ServerAuditEvent } from "../../audit/record.js";
import { createRateLimiter } from "../../sandbox/rate-limit.js";
import type { SandboxCaller } from "../auth.js";
import { resolveLimits } from "../quota.js";
import {
  AUDIT_EVERY_MS,
  Busy,
  FINISH_RETRIES,
  INTEGRITY_AUDIT_EVERY_MS,
  MAX_JSON_BYTES,
  Slots,
  WORKSPACE_DB_LIMITS,
  WORKSPACE_META_RATE,
  WORKSPACE_RATE,
  error,
  isTimeout,
  type WorkspaceRoutesDeps,
} from "./shared.js";

export type WorkspaceKit = ReturnType<typeof workspaceKit>;

/**
 * What the workspace sync route groups share, made once per router: the rate limiters, the
 * per-sandbox and per-replica slots, the throttled audit and the bounded team transactions.
 */
export function workspaceKit(deps: WorkspaceRoutesDeps) {
  const { db, objects, prefix, quota, log } = deps;
  const limits = resolveLimits(deps.limits);
  const dbLimits = { ...WORKSPACE_DB_LIMITS, ...deps.dbLimits };
  const limiter = deps.limiter ?? createRateLimiter(WORKSPACE_RATE);
  const metaLimiter = createRateLimiter(WORKSPACE_META_RATE);
  const reported = new Map<string, number>();
  const transfers = new Slots();
  const commits = new Slots();
  const others = new Slots();
  const replica = new Slots();
  const finishing = new Slots();
  const finishOwn = new Slots();
  const audited = new Map<string, number>();
  const integrity = new Map<string, { failures: number; at: number }>();

  const audit = (teamId: string, event: ServerAuditEvent) =>
    void withTeam(db, teamId, (tx) => recordAudit(tx, event)).catch((err: unknown) =>
      log.error({ err, action: event.action }, "could not record a workspace audit event"),
    );
  const throttledAudit = (key: string, teamId: string, event: ServerAuditEvent) => {
    const last = audited.get(key) ?? 0;
    if (Date.now() - last < AUDIT_EVERY_MS) return;
    if (audited.size > 10_000) audited.clear();
    audited.set(key, Date.now());
    audit(teamId, event);
  };
  const auditLimit = (
    caller: SandboxCaller,
    limit: "workspace_bytes" | "workspace_files" | "workspace_file_size",
  ) =>
    throttledAudit(`${caller.sandboxId}:${limit}`, caller.teamId, {
      action: "sandbox.limit_exceeded",
      actor: SYSTEM_ACTOR,
      teamId: caller.teamId,
      target: { sandboxId: caller.sandboxId, userId: caller.userId, limit },
    });
  /** Every mismatch counts; a row at most once a minute carries the count since the last one. */
  const auditIntegrity = (caller: SandboxCaller) => {
    const seen = integrity.get(caller.sandboxId) ?? { failures: 0, at: 0 };
    const failures = seen.failures + 1;
    if (Date.now() - seen.at < INTEGRITY_AUDIT_EVERY_MS) {
      integrity.set(caller.sandboxId, { failures, at: seen.at });
      return;
    }
    if (integrity.size > 10_000) integrity.clear();
    integrity.set(caller.sandboxId, { failures: 0, at: Date.now() });
    audit(caller.teamId, {
      action: "workspace.integrity_failed",
      actor: SYSTEM_ACTOR,
      teamId: caller.teamId,
      target: { sandboxId: caller.sandboxId, userId: caller.userId, failures },
    });
  };

  /**
   * One bounded team transaction for a sandbox: per-sandbox and per-replica in-flight caps
   * (throws {@link Busy}), and lock/statement timeouts so a queue on one workspace's row lock
   * can't pin pool connections.
   */
  const bounded = <T>(teamId: string, lockMs: number, fn: (tx: KaijuTx) => Promise<T>): Promise<T> =>
    withTeam(db, teamId, async (t) => {
      await t.execute(sql`
        SELECT set_config('lock_timeout', ${String(lockMs)}, true),
               set_config('statement_timeout', ${String(dbLimits.statementTimeoutMs)}, true)`);
      return fn(t);
    });
  /**
   * `commit` takes the sandbox's one commit slot and may wait `lockTimeoutMs` for the workspace
   * lock; `other` (everything else, downloads' lookups included) takes one of its short slots and
   * waits at most `shortLockTimeoutMs`.
   */
  const tx = async <T>(
    caller: SandboxCaller,
    kind: "commit" | "other",
    fn: (tx: KaijuTx) => Promise<T>,
  ): Promise<T> => {
    const mine =
      kind === "commit"
        ? commits.take(caller.sandboxId, dbLimits.commitsPerSandbox)
        : others.take(caller.sandboxId, dbLimits.othersPerSandbox);
    if (!mine) throw new Busy(429);
    const pool = await replica.wait("db", dbLimits.dbInFlight, dbLimits.slotWaitMs);
    if (!pool) {
      mine();
      throw new Busy(503);
    }
    try {
      const lockMs = kind === "commit" ? dbLimits.lockTimeoutMs : dbLimits.shortLockTimeoutMs;
      return await bounded(caller.teamId, lockMs, fn);
    } finally {
      pool();
      mine();
    }
  };
  /**
   * Ending an upload (record the content, release the reservation) waits rather than being
   * refused: one finish per sandbox at a time (its own queue), a few per replica, the short lock
   * timeout, and retries with backoff on a lock timeout — releasing both slots while it backs off,
   * so a sandbox whose own commit holds its workspace lock never holds a shared slot meanwhile.
   */
  const finishTx = async <T>(caller: SandboxCaller, fn: (tx: KaijuTx) => Promise<T>) => {
    for (let attempt = 0; ; attempt++) {
      const own = await finishOwn.wait(caller.sandboxId, 1, 60_000);
      if (!own) throw new Busy(503);
      const slot = await finishing.wait("db", dbLimits.finishInFlight, 60_000);
      if (!slot) {
        own();
        throw new Busy(503);
      }
      try {
        return await bounded(caller.teamId, dbLimits.shortLockTimeoutMs, fn);
      } catch (err) {
        if (!isTimeout(err) || attempt >= FINISH_RETRIES) throw err;
      } finally {
        slot();
        own();
      }
      await new Promise((r) => setTimeout(r, Math.min(200 * 2 ** attempt, 5_000)));
    }
  };

  const busy = (c: Context, status: 429 | 503, message: string) => {
    c.header("Retry-After", "1");
    return error(c, status, status === 429 ? "rate_limited" : "busy", message);
  };
  const metaAllowed = (caller: SandboxCaller, c: Context): Response | undefined => {
    const wait = metaLimiter.take(caller.sandboxId);
    if (wait <= 0) return undefined;
    c.header("Retry-After", String(Math.ceil(wait / 1000)));
    return error(c, 429, "rate_limited", "Too many requests.");
  };

  const readJson = async (c: Context): Promise<unknown> => {
    const length = Number(c.req.header("content-length") ?? "NaN");
    if (!Number.isInteger(length) || length > MAX_JSON_BYTES) return undefined;
    try {
      return await c.req.json();
    } catch {
      return undefined;
    }
  };

  return {
    deps,
    db,
    objects,
    prefix,
    quota,
    log,
    limits,
    limiter,
    reported,
    transfers,
    audited,
    auditLimit,
    auditIntegrity,
    tx,
    finishTx,
    busy,
    metaAllowed,
    readJson,
  };
}
