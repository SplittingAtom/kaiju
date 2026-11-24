import { randomUUID } from "node:crypto";
import {
  and,
  connectorGrants,
  eq,
  isNull,
  lt,
  or,
  sql,
  withTeam,
  Envelope,
  SYSTEM_ACTOR,
  type KaijuDb,
} from "@kaiju/db";
import { logger } from "../logger.js";
import { recordAudit } from "../audit/record.js";
import { parseOauthBundle, serializeOauthBundle, type OauthBundle } from "./oauth/bundle.js";
import { sameUrl } from "./oauth/discovery.js";
import { OauthError, type OauthIo } from "./oauth/http.js";
import type { RefreshGate } from "./oauth/refresh-gate.js";
import { refreshAccessToken } from "./oauth/refresh.js";
import {
  grantContext,
  grantKey,
  isExpired,
  needsRefresh,
  openRow,
  readGrant,
  refusal,
  serveIfValid,
  type GrantRow,
  type RevealOutcome,
  type Subject,
} from "./grant-read.js";

/**
 * Refreshing an OAuth grant (KOBE-110), serialised across server replicas by a lease in the row
 * (KOBE-778). With rotating refresh tokens (and reuse detection at the authorization server) a
 * refresh token may be spent once, so only the holder of the lease calls the token endpoint:
 *
 * 1. the caller already read the grant (`stale`) in a short transaction;
 * 2. concurrent callers in this process share one refresh ({@link RefreshGate}, capped, with a
 *    backoff after transient failures);
 * 3. a short transaction takes the lease: `refresh_lease_until = now() + lease`, a random owner,
 *    only while the row still holds `stale` and no live lease exists. No connection or lock is
 *    held while the authorization server is called;
 * 4. a replica that does not get the lease never calls the token endpoint: it re-reads the row
 *    until the holder stored the rotated bundle (served), the grant is gone, or the lease expired
 *    (then it tries to take the lease itself, within its wait);
 * 5. the holder writes the result with compare-and-set on its own lease and `stale` (retried a
 *    few times: the refresh token is spent once it is sent), releasing the lease; a refresh the
 *    server rejects for good drops the grant, also only under its own lease.
 *
 * The lease outlives the token request's deadline, so it cannot expire while its holder still
 * waits for an answer. After a failure with an unknown outcome (timeout, reset) it is kept until
 * it expires; only a definite error answer releases it early.
 */
export interface RefreshSupport {
  readonly io: OauthIo;
  readonly gate: RefreshGate;
  /** How long a lease lasts (default: the token request's deadline plus 5 s). */
  readonly leaseMs?: number;
  /** How long a replica waits for another's lease (default: the lease). */
  readonly leaseWaitMs?: number;
}

/**
 * The token request's deadline for a refresh (KOBE-778, P2-29): well under the MCP proxy's
 * deadline for the whole grant call (`KOBE_MCP_GRANT_TIMEOUT_MS`, 25 s), which must also cover
 * waiting for another replica's lease (this plus 5 s) and the refresh after it.
 */
export const REFRESH_TIMEOUT_MS = 5_000;

/** A forced refresh (the upstream refused the token) is skipped for a grant written this recently. */
export const FORCED_REFRESH_MIN_AGE_MS = 30_000;
/** Refresh failures after which the refresh token was certainly not spent. */
const DEFINITE_FAILURES: ReadonlySet<string> = new Set([
  "token_endpoint_error",
  "oauth_unsupported",
]);
/** How often a waiting replica re-reads a leased grant. */
const LEASE_POLL_MS = 100;
const WRITE_ATTEMPTS = 3;
const WRITE_LOCK_TIMEOUT = sql`SET LOCAL lock_timeout = '2s'`;

const leaseMsOf = (support: RefreshSupport) => support.leaseMs ?? support.io.timeoutMs + 5_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** No live lease, or `owner`'s own: what a drop or a lease take requires. */
const leaseFree = (owner?: string) =>
  or(
    isNull(connectorGrants.refreshLeaseUntil),
    lt(connectorGrants.refreshLeaseUntil, sql`now()`),
    ...(owner === undefined ? [] : [eq(connectorGrants.refreshLeaseOwner, owner)]),
  );

/** Takes the lease if the row still holds `stale` and nobody else holds one. */
async function takeLease(
  db: KaijuDb,
  subject: Subject,
  stale: GrantRow,
  owner: string,
  leaseMs: number,
): Promise<boolean> {
  const taken = await withTeam(db, subject.teamId, async (tx) => {
    await tx.execute(WRITE_LOCK_TIMEOUT);
    return tx
      .update(connectorGrants)
      .set({
        refreshLeaseUntil: sql`now() + make_interval(secs => ${leaseMs / 1000})`,
        refreshLeaseOwner: owner,
      })
      .where(and(grantKey(subject), eq(connectorGrants.sealed, stale.sealed), leaseFree()))
      .returning({ id: connectorGrants.connectorId });
  });
  return taken.length > 0;
}

/** Gives the lease back after a transient failure (the stored grant is unchanged). */
async function releaseLease(db: KaijuDb, subject: Subject, owner: string): Promise<void> {
  try {
    await withTeam(db, subject.teamId, (tx) =>
      tx
        .update(connectorGrants)
        .set({ refreshLeaseUntil: null, refreshLeaseOwner: null })
        .where(and(grantKey(subject), eq(connectorGrants.refreshLeaseOwner, owner))),
    );
  } catch (err) {
    // It expires on its own.
    logger.warn({ err, connectorId: subject.connectorId }, "oauth refresh lease not released");
  }
}

export function refreshAndReveal(
  db: KaijuDb,
  envelope: Envelope,
  subject: Subject,
  now: Date,
  support: RefreshSupport,
  stale: GrantRow,
): Promise<RevealOutcome> {
  const key = `${subject.teamId}:${subject.userId}:${subject.connectorId}`;
  if (support.gate.inBackoff(key)) return serveIfValid(db, envelope, subject, stale, now);
  return support.gate.run(key, () => refreshOnce(db, envelope, subject, now, support, stale, key));
}

async function refreshOnce(
  db: KaijuDb,
  envelope: Envelope,
  subject: Subject,
  now: Date,
  support: RefreshSupport,
  stale: GrantRow,
  key: string,
): Promise<RevealOutcome> {
  const context = grantContext(subject.teamId, subject.userId, subject.connectorId);
  const bundle = parseOauthBundle(envelope.openString(stale.sealed, context));
  if (!sameUrl(bundle.resource, stale.connectorUrl)) return openRow(db, envelope, subject, stale);
  if (bundle.refresh_token === undefined) {
    return isExpired(stale, now)
      ? dropIfUnchanged(db, envelope, subject, now, stale, "no_refresh_token")
      : openRow(db, envelope, subject, stale);
  }
  const owner = randomUUID();
  const leaseMs = leaseMsOf(support);
  const waitUntil = Date.now() + (support.leaseWaitMs ?? leaseMs);
  let current = stale;
  for (;;) {
    if (await takeLease(db, subject, current, owner, leaseMs)) {
      return refreshHolding(db, envelope, subject, now, support, current, key, owner);
    }
    if (Date.now() >= waitUntil) return serveIfValid(db, envelope, subject, current, now);
    await sleep(LEASE_POLL_MS);
    const row = await readGrant(db, subject);
    const refused = await refusal(db, subject, row);
    if (refused) return refused;
    const fresh = row as GrantRow;
    // Another replica stored a rotated bundle: serve it (refreshing only if it is stale too).
    if (fresh.sealed !== current.sealed) {
      return needsRefresh(fresh, now)
        ? serveIfValid(db, envelope, subject, fresh, now)
        : openRow(db, envelope, subject, fresh);
    }
    current = fresh;
  }
}

/** Calls the token endpoint under the lease `owner` holds, and stores or drops the grant. */
async function refreshHolding(
  db: KaijuDb,
  envelope: Envelope,
  subject: Subject,
  now: Date,
  support: RefreshSupport,
  stale: GrantRow,
  key: string,
  owner: string,
): Promise<RevealOutcome> {
  const context = grantContext(subject.teamId, subject.userId, subject.connectorId);
  const bundle = parseOauthBundle(envelope.openString(stale.sealed, context));
  let tokens;
  try {
    tokens = await refreshAccessToken(support.io, bundle, now);
  } catch (error) {
    if (error instanceof OauthError && error.code === "refresh_rejected") {
      // Nobody else spent this refresh token through Kaiju: we hold the lease.
      return dropIfUnchanged(db, envelope, subject, now, stale, "rejected", owner);
    }
    // Release the lease only after a definite answer (an error status, or a URL refused before
    // anything was sent). After a timeout or a reset the server may already have rotated the
    // refresh token: the lease then stays until it expires, so no other replica replays the old
    // one at once (with reuse detection that revokes the whole family; review F2).
    if (error instanceof OauthError && DEFINITE_FAILURES.has(error.code)) {
      await releaseLease(db, subject, owner);
    }
    support.gate.markFailed(key);
    logger.warn(
      {
        connectorId: subject.connectorId,
        code: error instanceof OauthError ? error.code : "error",
      },
      "oauth grant refresh failed; keeping the grant",
    );
    return serveIfValid(db, envelope, subject, stale, now);
  }
  const sealed = envelope.seal(
    serializeOauthBundle({
      ...bundleWithoutVersion(bundle),
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken ?? bundle.refresh_token,
      ...(tokens.scope === undefined ? {} : { scope: tokens.scope }),
    }),
    context,
  );
  const saved = await writeRefreshed(db, subject, stale, owner, {
    sealed,
    expiresAt: tokens.expiresAt ?? defaultExpiry(now),
  });
  support.gate.clear(key);
  if (saved === "lost") return afterLostRace(db, envelope, subject, now, stale);
  // Stored, or (the database failing after the token endpoint rotated) at least served.
  return {
    ok: true,
    credential: { kind: "oauth", accessToken: tokens.accessToken },
    source: "member",
  };
}

/** An access token issued without `expires_in` is treated as valid this long (KOBE-778, P2-28). */
export const DEFAULT_TOKEN_LIFETIME_MS = 3600_000;
export const defaultExpiry = (now: Date): Date =>
  new Date(now.getTime() + DEFAULT_TOKEN_LIFETIME_MS);

/**
 * Compare-and-set on the lease and the bundle that was read, releasing the lease. Retried: the old
 * refresh token is already spent, so giving up on a transient database error loses the grant.
 */
async function writeRefreshed(
  db: KaijuDb,
  subject: Subject,
  stale: GrantRow,
  owner: string,
  next: { readonly sealed: string; readonly expiresAt: Date },
): Promise<"saved" | "lost" | "failed"> {
  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt += 1) {
    try {
      const saved = await withTeam(db, subject.teamId, async (tx) => {
        await tx.execute(WRITE_LOCK_TIMEOUT);
        return tx
          .update(connectorGrants)
          .set({
            sealed: next.sealed,
            keyId: Envelope.keyIdOf(next.sealed),
            expiresAt: next.expiresAt,
            refreshLeaseUntil: null,
            refreshLeaseOwner: null,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              grantKey(subject),
              eq(connectorGrants.sealed, stale.sealed),
              eq(connectorGrants.refreshLeaseOwner, owner),
            ),
          )
          .returning({ id: connectorGrants.connectorId });
      });
      return saved.length > 0 ? "saved" : "lost";
    } catch (err) {
      logger.warn(
        { err, connectorId: subject.connectorId, attempt },
        "oauth refreshed grant not stored yet",
      );
      if (attempt < WRITE_ATTEMPTS) await sleep(200 * attempt);
    }
  }
  logger.error({ connectorId: subject.connectorId }, "oauth refreshed grant could not be stored");
  return "failed";
}

function bundleWithoutVersion(bundle: OauthBundle): Omit<OauthBundle, "v"> {
  const { v: _v, ...rest } = bundle;
  return rest;
}

/**
 * The compare-and-set matched nothing: the grant was revoked or replaced, the user was
 * deactivated, or another replica refreshed. Re-read (liveness included) and serve what is stored.
 */
async function afterLostRace(
  db: KaijuDb,
  envelope: Envelope,
  subject: Subject,
  now: Date,
  stale: GrantRow,
): Promise<RevealOutcome> {
  const row = await readGrant(db, subject);
  const refused = await refusal(db, subject, row);
  if (refused) return refused;
  const current = row as GrantRow;
  if (current.sealed === stale.sealed || needsRefresh(current, now)) {
    return serveIfValid(db, envelope, subject, current, now);
  }
  return openRow(db, envelope, subject, current);
}

/**
 * Drops a dead grant (audited, one transaction), unless it changed since it was read or another
 * replica holds a live refresh lease on it (`owner`: the caller's own lease, which does not count).
 */
async function dropIfUnchanged(
  db: KaijuDb,
  envelope: Envelope,
  subject: Subject,
  now: Date,
  stale: GrantRow,
  reason: "rejected" | "no_refresh_token",
  owner?: string,
): Promise<RevealOutcome> {
  const dropped = await withTeam(db, subject.teamId, async (tx) => {
    await tx.execute(WRITE_LOCK_TIMEOUT);
    const removed = await tx
      .delete(connectorGrants)
      .where(and(grantKey(subject), eq(connectorGrants.sealed, stale.sealed), leaseFree(owner)))
      .returning({ id: connectorGrants.connectorId });
    if (removed.length === 0) return false;
    await recordAudit(tx, {
      action: "mcp.grant.refresh_failed",
      actor: SYSTEM_ACTOR,
      teamId: subject.teamId,
      target: { connectorId: subject.connectorId, name: stale.connectorName, reason },
    });
    return true;
  });
  if (dropped) return { ok: false, failure: "not_connected" };
  return afterLostRace(db, envelope, subject, now, stale);
}
