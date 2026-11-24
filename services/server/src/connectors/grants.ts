import {
  and,
  connectorGrants,
  connectors,
  eq,
  sql,
  withTeam,
  Envelope,
  listMemberships,
  teams,
  type ConnectorGrantKind,
  type KaijuDb,
} from "@kaiju/db";
import { z } from "zod";
import { recordAudit } from "../audit/record.js";
import {
  enabledConnector,
  grantContext,
  needsRefresh,
  isExpired,
  openRow,
  readGrant,
  refusal,
  UNAVAILABLE,
  type GrantRow,
  type RevealOutcome,
  type Subject,
} from "./grant-read.js";
import {
  FORCED_REFRESH_MIN_AGE_MS,
  refreshAndReveal,
  type RefreshSupport,
} from "./grant-refresh.js";
import { maskHint } from "./mask.js";
import { parseOauthBundle } from "./oauth/bundle.js";
import { sameUrl } from "./oauth/discovery.js";
import { revealSiteKey } from "./site-key.js";

export {
  enabledConnector,
  grantContext,
  REFRESH_SKEW_MS,
  type RevealedCredential,
  type RevealedSource,
  type RevealOutcome,
  type Subject,
} from "./grant-read.js";
export type { RefreshSupport } from "./grant-refresh.js";

/**
 * Per-user API-key grants (KOBE-108, D27: no shared team credentials; OAuth tokens KOBE-109). A user stores their own key
 * for an `api_key` connector their team enabled. The key is sealed with the site envelope
 * (KOBE-107, bound to team + user + connector) before it reaches Postgres, is never returned by
 * any API (callers get {@link GrantSummary}: a masked hint and timestamps), and is decrypted only
 * by {@link revealCredential}, which the internal API hands to the MCP proxy for the run's own user.
 * Neither the key nor its hint is audited or logged. A connector in `site` mode (KOBE-303) has
 * no member grants: {@link revealCredential} serves its site-wide key (`site-key.ts`) after the
 * same liveness checks, and members cannot store their own.
 */
export const API_KEY_MAX = 2048;
export const API_KEY_MIN = 8;
/** Visible ASCII only: the key becomes an HTTP header value, so no whitespace or control bytes. */
export const apiKeySchema = z
  .string()
  .min(API_KEY_MIN)
  .max(API_KEY_MAX)
  .regex(/^[\x21-\x7e]+$/);

export const putGrantSchema = z.strictObject({ api_key: apiKeySchema });

export interface GrantSummary {
  readonly connectorId: string;
  /** Masked: never more than the last four characters, and none for a short key. */
  readonly hint: string;
  readonly kind: ConnectorGrantKind;
  /** OAuth access-token expiry; null for API keys. */
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type PutOutcome =
  | { readonly ok: true; readonly replaced: boolean; readonly grant: GrantSummary }
  | {
      readonly ok: false;
      /** `provided_by_site`: the connector uses its site-wide key (KOBE-303); no own keys. */
      readonly failure: "not_available" | "not_api_key" | "provided_by_site";
    };

export { maskHint } from "./mask.js";

const summaryColumns = {
  connectorId: connectorGrants.connectorId,
  hint: connectorGrants.hint,
  kind: connectorGrants.kind,
  expiresAt: connectorGrants.expiresAt,
  createdAt: connectorGrants.createdAt,
  updatedAt: connectorGrants.updatedAt,
};

/**
 * The caller's grants (masked) plus, for each OAuth grant, whether Kaiju can renew it by itself
 * (KOBE-835): it holds a refresh token and `canRefresh` (this server has an OAuth client wired).
 * The sealed bundle is opened only to read that one fact; nothing from it is returned.
 */
export async function listGrantsWithRefresh(
  db: KaijuDb,
  envelope: Envelope | undefined,
  teamId: string,
  userId: string,
  canRefresh: boolean,
): Promise<(GrantSummary & { readonly refreshable: boolean })[]> {
  const rows = await withTeam(db, teamId, (tx) =>
    tx
      .select({ ...summaryColumns, sealed: connectorGrants.sealed })
      .from(connectorGrants)
      .where(and(eq(connectorGrants.teamId, teamId), eq(connectorGrants.userId, userId))),
  );
  return rows.map(({ sealed, ...summary }) => ({
    ...summary,
    refreshable:
      canRefresh &&
      summary.kind === "oauth" &&
      envelope !== undefined &&
      hasRefreshToken(envelope, teamId, userId, summary.connectorId, sealed),
  }));
}

function hasRefreshToken(
  envelope: Envelope,
  teamId: string,
  userId: string,
  connectorId: string,
  sealed: string,
): boolean {
  try {
    const plaintext = envelope.openString(sealed, grantContext(teamId, userId, connectorId));
    return parseOauthBundle(plaintext).refresh_token !== undefined;
  } catch {
    return false;
  }
}

/** What a stored grant is made of, before sealing. */
export interface GrantMaterial {
  readonly kind: ConnectorGrantKind;
  /** The secret text to seal: the API key, or the OAuth token bundle as JSON. */
  readonly plaintext: string;
  readonly hint: string;
  readonly expiresAt?: Date;
  /**
   * OAuth: the resource (connector URL) the tokens were issued for. Stored only while the
   * connector still has that URL, so a callback that arrives after a site admin changed it is
   * refused instead of storing a grant every reveal would refuse (KOBE-784, P2-27).
   */
  readonly resource?: string;
}

/**
 * Seals and upserts a grant for a connector the team enabled whose `auth_kind` matches the
 * material's kind. Shared by API keys (KOBE-108) and OAuth tokens (KOBE-109).
 */
export async function storeGrant(
  db: KaijuDb,
  envelope: Envelope,
  subject: Subject,
  material: GrantMaterial,
): Promise<PutOutcome> {
  const sealed = envelope.seal(
    material.plaintext,
    grantContext(subject.teamId, subject.userId, subject.connectorId),
  );
  const values = {
    teamId: subject.teamId,
    userId: subject.userId,
    connectorId: subject.connectorId,
    kind: material.kind,
    sealed,
    keyId: Envelope.keyIdOf(sealed),
    hint: material.hint,
    expiresAt: material.expiresAt ?? null,
  };
  return withTeam(db, subject.teamId, async (tx): Promise<PutOutcome> => {
    const connector = await enabledConnector(tx, subject, true);
    if (!connector) return { ok: false, failure: "not_available" };
    if (connector.authKind !== material.kind) return { ok: false, failure: "not_api_key" };
    if (connector.credentialSource === "site") return { ok: false, failure: "provided_by_site" };
    if (material.resource !== undefined && !sameUrl(material.resource, connector.url)) {
      return { ok: false, failure: "not_available" };
    }
    const [existing] = await tx
      .select({ connectorId: connectorGrants.connectorId })
      .from(connectorGrants)
      .where(
        and(
          eq(connectorGrants.teamId, subject.teamId),
          eq(connectorGrants.userId, subject.userId),
          eq(connectorGrants.connectorId, subject.connectorId),
        ),
      )
      .for("update");
    const [grant] = await tx
      .insert(connectorGrants)
      .values(values)
      .onConflictDoUpdate({
        target: [connectorGrants.teamId, connectorGrants.userId, connectorGrants.connectorId],
        set: {
          kind: values.kind,
          sealed: values.sealed,
          keyId: values.keyId,
          hint: values.hint,
          expiresAt: values.expiresAt,
          // A reconnect replaces the bundle: any refresh lease on the old one is void (KOBE-778).
          refreshLeaseUntil: null,
          refreshLeaseOwner: null,
          updatedAt: sql`now()`,
        },
      })
      .returning(summaryColumns);
    if (!grant) throw new Error("grant upsert returned nothing");
    const replaced = existing !== undefined;
    await recordAudit(tx, {
      action: replaced ? "mcp.grant.replaced" : "mcp.grant.added",
      teamId: subject.teamId,
      target: { connectorId: subject.connectorId, name: connector.name },
    });
    return { ok: true, replaced, grant };
  });
}

/** Adds or replaces the caller's key for a connector. */
export function putGrant(
  db: KaijuDb,
  envelope: Envelope,
  subject: Subject,
  apiKey: string,
): Promise<PutOutcome> {
  return storeGrant(db, envelope, subject, {
    kind: "api_key",
    plaintext: apiKey,
    hint: maskHint(apiKey),
  });
}

/** Removes the caller's key; false when there was none. */
export function removeGrant(db: KaijuDb, subject: Subject): Promise<boolean> {
  return withTeam(db, subject.teamId, async (tx) => {
    const removed = await tx
      .delete(connectorGrants)
      .where(
        and(
          eq(connectorGrants.teamId, subject.teamId),
          eq(connectorGrants.userId, subject.userId),
          eq(connectorGrants.connectorId, subject.connectorId),
        ),
      )
      .returning({ connectorId: connectorGrants.connectorId });
    if (removed.length === 0) return false;
    const [connector] = await tx
      .select({ name: connectors.name })
      .from(connectors)
      .where(eq(connectors.id, subject.connectorId));
    await recordAudit(tx, {
      action: "mcp.grant.removed",
      teamId: subject.teamId,
      target: { connectorId: subject.connectorId, name: connector?.name ?? "unknown" },
    });
    return true;
  });
}

/**
 * Decrypts the grant of (team, user, connector) for the MCP proxy. Only the internal API calls
 * this, with `userId` taken from the verified sandbox token, never from the request. Fails
 * closed: an unreadable ciphertext (wrong key, tampering) is `unavailable`, with nothing about
 * why; a grant whose kind no longer matches the connector's auth kind is `not_connected`. An
 * OAuth access token at or near expiry is refreshed first ({@link refreshAndReveal}); without
 * `refresh` (no OAuth client wired) it is `unavailable`.
 *
 * `force` (KOBE-778, P2-28): the upstream refused the access token although it had not expired
 * (revoked early, or issued without a real expiry), so refresh it now; skipped for a grant
 * written in the last {@link FORCED_REFRESH_MIN_AGE_MS}, so a server that refuses every token
 * cannot make each call spend a refresh.
 */
export async function revealCredential(
  db: KaijuDb,
  envelope: Envelope,
  subject: Subject,
  now: Date = new Date(),
  refresh?: RefreshSupport,
  options: { readonly force?: boolean } = {},
): Promise<RevealOutcome> {
  const row = await readGrant(db, subject);
  if (row === "site_key") return revealSiteCredential(db, envelope, subject.connectorId);
  const refused = await refusal(db, subject, row);
  if (refused) return refused;
  const grant = row as GrantRow;
  try {
    if (needsRefresh(grant, now) || (options.force === true && forceable(grant, now, refresh))) {
      if (!refresh)
        return isExpired(grant, now) ? UNAVAILABLE : await openRow(db, envelope, subject, grant);
      return await refreshAndReveal(db, envelope, subject, now, refresh, grant);
    }
    return await openRow(db, envelope, subject, grant);
  } catch {
    return UNAVAILABLE;
  }
}

const forceable = (grant: GrantRow, now: Date, refresh: RefreshSupport | undefined): boolean =>
  refresh !== undefined &&
  grant.kind === "oauth" &&
  now.getTime() - grant.updatedAt.getTime() >= FORCED_REFRESH_MIN_AGE_MS;

/**
 * The site-wide key, for a member whose whole chain was just checked (KOBE-303). Read and opened
 * per call, so a replaced or removed key takes effect on the next call. No key set (or one that
 * does not open) is `not_connected`: the site admin has not provided one.
 */
async function revealSiteCredential(
  db: KaijuDb,
  envelope: Envelope,
  connectorId: string,
): Promise<RevealOutcome> {
  const apiKey = await revealSiteKey(db, envelope, connectorId);
  return apiKey === undefined
    ? { ok: false, failure: "not_connected" }
    : { ok: true, credential: { kind: "api_key", apiKey }, source: "site" };
}

/**
 * The site admin's OWN credential for a connector, for a probe (pins are site-wide trust, so only
 * an admin's action may probe with a grant, and only with that admin's grant): their API key, or
 * their OAuth access token (KOBE-784, refreshed through the leased refresh when `refresh` is
 * given). Looks through the admin's teams; never another user's. Undefined when they have none.
 * The value is for `initialize` / `tools/list`-type probes only, never for a tool call.
 */
export async function adminProbeGrant(
  db: KaijuDb,
  envelope: Envelope | undefined,
  adminUserId: string,
  connectorId: string,
  kind: "api_key" | "oauth",
  refresh?: RefreshSupport,
): Promise<string | undefined> {
  if (!envelope) return undefined;
  for (const team of await listMemberships(db, adminUserId)) {
    const found = await revealCredential(
      db,
      envelope,
      { teamId: team.teamId, userId: adminUserId, connectorId },
      new Date(),
      refresh,
    );
    if (!found.ok || found.source !== "member") continue;
    const credential = found.credential;
    if (kind === "api_key" && credential.kind === "api_key") return credential.apiKey;
    if (kind === "oauth" && credential.kind === "oauth") return credential.accessToken;
  }
  return undefined;
}

/**
 * Drops every user's grants for a connector, in every team, one `withTeam()` transaction per team
 * (RLS: no query sees two teams). Used when the connector is removed (KOBE-454) or its URL or
 * credential mode changes: a credential issued for one server must never reach another, and users
 * reconnect or re-enter their key. Audits one `mcp.grant.removed` per grant, in its team.
 *
 * The caller holds the connector row `FOR UPDATE` in its own (still open) transaction, so no grant
 * can be stored meanwhile ({@link storeGrant} takes a share lock), and must not have written an
 * audit row yet: that transaction would hold the audit chain lock these team transactions need.
 * Each team's delete commits on its own; if the caller then rolls back, the grants stay deleted
 * (users re-enter them), never the other way round.
 */
export async function dropConnectorGrants(
  db: KaijuDb,
  connectorId: string,
  name: string,
): Promise<number> {
  const all = await db.select({ id: teams.id }).from(teams);
  let dropped = 0;
  for (const team of all) {
    dropped += await withTeam(db, team.id, async (tx) => {
      const removed = await tx
        .delete(connectorGrants)
        .where(
          and(eq(connectorGrants.teamId, team.id), eq(connectorGrants.connectorId, connectorId)),
        )
        .returning({ userId: connectorGrants.userId });
      for (const _ of removed) {
        await recordAudit(tx, {
          action: "mcp.grant.removed",
          teamId: team.id,
          target: { connectorId, name },
        });
      }
      return removed.length;
    });
  }
  return dropped;
}
