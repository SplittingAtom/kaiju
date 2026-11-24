import {
  KAIJU_BUILTIN_CONNECTOR_ID,
  siteSettings,
  sql,
  type KaijuDb,
  type KaijuTx,
} from "@kaiju/db";
import { recordAudit } from "../audit/record.js";

/**
 * Per-person Kaiju admin limits (KOBE-619, spec §6): admin reads per minute and admin writes per
 * hour, site settings with defaults 60 and 30. Counted from the person's allowed `mcp.tool_call`
 * rows for the built-in connector in the audit log, so the limit holds across server replicas and
 * restarts; the window is found by `at` (indexed) and the person's rows by `(actor_id, seq)`.
 * Calls of the docs tools (`mcp__<kobe>__docs_*`, KOBE-620) are not admin calls and never count.
 */
export const KAIJU_READS_PER_MINUTE_KEY = "kobe_mcp.reads_per_minute";
export const KAIJU_WRITES_PER_HOUR_KEY = "kobe_mcp.writes_per_hour";
export const KAIJU_READS_PER_MINUTE_DEFAULT = 60;
export const KAIJU_WRITES_PER_HOUR_DEFAULT = 30;
/** Bounds of both limits (the Site settings API validates against them). */
export const KAIJU_LIMIT_MIN = 1;
export const KAIJU_LIMIT_MAX = 10_000;
const LIMIT_MAX = KAIJU_LIMIT_MAX;

const limitOf = (value: string | null | undefined, fallback: number): number => {
  if (value === null || value === undefined || !/^[0-9]{1,5}$/.test(value)) return fallback;
  return Math.min(Math.max(Number(value), 1), LIMIT_MAX);
};

export interface KaijuLimits {
  readonly readsPerMinute: number;
  readonly writesPerHour: number;
}

/** The limits in force (stored value, else the default); read on every call, so never stale. */
export async function readKaijuLimits(db: Pick<KaijuTx, "execute">): Promise<KaijuLimits> {
  const res = await db.execute<{ key: string; value: string }>(sql`
    SELECT key, value FROM public.site_settings
     WHERE key IN (${KAIJU_READS_PER_MINUTE_KEY}, ${KAIJU_WRITES_PER_HOUR_KEY})`);
  const byKey = new Map(res.rows.map((r) => [r.key, r.value]));
  return {
    readsPerMinute: limitOf(byKey.get(KAIJU_READS_PER_MINUTE_KEY), KAIJU_READS_PER_MINUTE_DEFAULT),
    writesPerHour: limitOf(byKey.get(KAIJU_WRITES_PER_HOUR_KEY), KAIJU_WRITES_PER_HOUR_DEFAULT),
  };
}

/** Stores one limit in `tx`, audited as `site.settings.updated` when the effective value changed. */
export async function storeKaijuLimit(
  tx: KaijuTx,
  kind: "read" | "write",
  value: number,
): Promise<void> {
  const current = await readKaijuLimits(tx);
  if ((kind === "read" ? current.readsPerMinute : current.writesPerHour) === value) return;
  const key = kind === "read" ? KAIJU_READS_PER_MINUTE_KEY : KAIJU_WRITES_PER_HOUR_KEY;
  await tx
    .insert(siteSettings)
    .values({ key, value: String(value) })
    .onConflictDoUpdate({
      target: siteSettings.key,
      set: { value: String(value), updatedAt: new Date() },
    });
  await recordAudit(tx, {
    action: "site.settings.updated",
    target: {
      setting: kind === "read" ? "kobe_reads_per_minute" : "kobe_writes_per_hour",
      value,
    },
  });
}

/** Whether the person may make one more admin read (or write) now. Fails closed on errors. */
export async function withinKaijuLimit(
  db: KaijuDb,
  userId: string,
  kind: "read" | "write",
): Promise<boolean> {
  const key = kind === "read" ? KAIJU_READS_PER_MINUTE_KEY : KAIJU_WRITES_PER_HOUR_KEY;
  const window = kind === "read" ? "1 minute" : "1 hour";
  const res = await db.execute<{ used: number; limit_value: string | null }>(sql`
    WITH boundary AS (
      SELECT min(a.seq) AS seq FROM public.audit_log a
       WHERE a.at > now() - ${window}::interval)
    SELECT
      (SELECT count(*)::int FROM public.audit_log a, boundary b
        WHERE a.actor_id = ${userId} AND a.seq >= b.seq
          AND a.action = 'mcp.tool_call'
          AND a.target ->> 'connectorId' = ${KAIJU_BUILTIN_CONNECTOR_ID}
          AND a.target ->> 'decision' = 'allowed'
          -- The docs tools (KOBE-620) are no admin reads: they never count.
          AND a.target ->> 'tool' !~ '__docs_[a-z_]+$'
          AND (a.target ->> 'risk' = 'read') = ${kind === "read"}) AS used,
      (SELECT s.value FROM public.site_settings s WHERE s.key = ${key}) AS limit_value`);
  const row = res.rows[0];
  if (row === undefined) return false;
  const limit = limitOf(
    row.limit_value,
    kind === "read" ? KAIJU_READS_PER_MINUTE_DEFAULT : KAIJU_WRITES_PER_HOUR_DEFAULT,
  );
  return row.used < limit;
}

const LOCK_ATTEMPTS = 100;
const LOCK_RETRY_MS = 100;

/**
 * Runs `fn` (a Kaiju admin decision: limit count, then the `mcp.tool_call` row that counts) while
 * holding the person's limit lock, a transaction-level advisory lock, so two replicas cannot both
 * pass the count before either records its call (review L5). The lock's transaction stays open
 * while `fn` runs on other connections; waiting uses try-and-retry with the connection released
 * between attempts, so waiters never hold pool connections the holder needs. Undefined when the
 * lock was not obtained in about 10 s.
 */
export async function withKaijuPersonLock<T>(
  db: KaijuDb,
  userId: string,
  fn: () => Promise<T>,
): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false }> {
  return withAdvisoryLockRetry(db, `kobe_mcp.limit:${userId}`, fn);
}

/**
 * Runs `fn` while holding the transaction-level advisory lock `key` (try-and-retry, about 10 s;
 * see {@link withKaijuPersonLock}). Also used by the git host tools' writes (KOBE-762), which hold
 * the member's git write lock across the idempotency check, the host call and the audit row.
 */
export async function withAdvisoryLockRetry<T>(
  db: KaijuDb,
  key: string,
  fn: () => Promise<T>,
): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false }> {
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    const outcome = await db.transaction(async (tx) => {
      const res = await tx.execute<{ locked: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS locked`,
      );
      if (res.rows[0]?.locked !== true) return { ok: false as const };
      return { ok: true as const, value: await fn() };
    });
    if (outcome.ok) return outcome;
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
  }
  return { ok: false };
}
