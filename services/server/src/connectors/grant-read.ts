import {
  and,
  connectorGrants,
  connectors,
  eq,
  isNull,
  teamConnectors,
  teamMembers,
  users,
  withTeam,
  SYSTEM_ACTOR,
  type ConnectorGrantKind,
  type Envelope,
  type KaijuDb,
  type KaijuTx,
} from "@kaiju/db";
import { recordAudit } from "../audit/record.js";
import { parseOauthBundle } from "./oauth/bundle.js";
import { sameUrl } from "./oauth/discovery.js";

/**
 * Reading a member's grant for a reveal (KOBE-108/109/110): the liveness chain, the row, and
 * opening it. Shared by {@link revealCredential} (grants.ts) and the OAuth refresh
 * (grant-refresh.ts), so neither has to import the other.
 */
export interface Subject {
  readonly teamId: string;
  readonly userId: string;
  readonly connectorId: string;
}

/** Envelope binding: a sealed key opens only for this team, user and connector. */
export function grantContext(teamId: string, userId: string, connectorId: string) {
  return { teamId, kind: "connector_grant", recordId: `${userId}:${connectorId}` } as const;
}

export const grantKey = (s: Subject) =>
  and(
    eq(connectorGrants.teamId, s.teamId),
    eq(connectorGrants.userId, s.userId),
    eq(connectorGrants.connectorId, s.connectorId),
  );

/**
 * The connector, if the team enabled it and it is active and not removed. `lock` takes a share lock
 * on the connector row until the caller's transaction ends (storing a grant): a removal or URL
 * change, which holds the row for update while it drops the grants, then either runs first (and
 * this sees it removed) or waits until the grant is stored (and drops it) (KOBE-454).
 */
export async function enabledConnector(tx: KaijuTx, s: Subject, lock = false) {
  const query = tx
    .select({
      name: connectors.name,
      url: connectors.url,
      authKind: connectors.authKind,
      credentialSource: connectors.credentialSource,
      status: connectors.status,
    })
    .from(teamConnectors)
    .innerJoin(connectors, eq(connectors.id, teamConnectors.connectorId))
    .where(
      and(
        eq(teamConnectors.teamId, s.teamId),
        eq(teamConnectors.connectorId, s.connectorId),
        isNull(connectors.deletedAt),
      ),
    );
  const [row] = lock ? await query.for("share", { of: connectors }) : await query;
  return row && row.status === "active" ? row : undefined;
}

/** A credential decrypted for the MCP proxy. */
export type RevealedCredential =
  | { readonly kind: "api_key"; readonly apiKey: string }
  | { readonly kind: "oauth"; readonly accessToken: string };

/** Whose credential was revealed (KOBE-449): the member's own grant or the site-wide key. */
export type RevealedSource = "member" | "site";

export type RevealOutcome =
  | {
      readonly ok: true;
      readonly credential: RevealedCredential;
      readonly source: RevealedSource;
    }
  | { readonly ok: false; readonly failure: "not_available" | "not_connected" | "unavailable" };

export const UNAVAILABLE: RevealOutcome = { ok: false, failure: "unavailable" };

/** An access token is refreshed this long before it expires, so a call never races the expiry. */
export const REFRESH_SKEW_MS = 60_000;

export interface GrantRow {
  readonly sealed: string;
  readonly kind: ConnectorGrantKind;
  readonly expiresAt: Date | null;
  readonly updatedAt: Date;
  readonly connectorUrl: string;
  readonly connectorName: string;
}
/** `site_key`: the chain is live and the connector uses its site-wide key (KOBE-303). */
export type GrantLookup =
  GrantRow | "not_available" | "not_connected" | "user_inactive" | "site_key";

/**
 * The grant, if the whole chain is live right now: the connector enabled for the team and active,
 * the user not deactivated (KOBE-13) and still a member of the team, the grant present and of the
 * connector's kind. Checked on every reveal, so a deactivation, removal, suspension or revoke
 * needs no sweep to take effect.
 */
export async function loadGrant(tx: KaijuTx, s: Subject): Promise<GrantLookup> {
  const connector = await enabledConnector(tx, s);
  if (!connector || connector.authKind === "none") return "not_available";
  const [account] = await tx
    .select({ deactivatedAt: users.deactivatedAt })
    .from(users)
    .where(eq(users.id, s.userId));
  const [member] = await tx
    .select({ userId: teamMembers.userId })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, s.teamId), eq(teamMembers.userId, s.userId)));
  if (!account || account.deactivatedAt !== null || !member) return "user_inactive";
  if (connector.credentialSource === "site") return "site_key";
  const [grant] = await tx
    .select({
      sealed: connectorGrants.sealed,
      kind: connectorGrants.kind,
      expiresAt: connectorGrants.expiresAt,
      updatedAt: connectorGrants.updatedAt,
    })
    .from(connectorGrants)
    .where(grantKey(s));
  return grant && grant.kind === connector.authKind
    ? { ...grant, connectorUrl: connector.url, connectorName: connector.name }
    : "not_connected";
}

export const readGrant = (db: KaijuDb, s: Subject): Promise<GrantLookup> =>
  withTeam(db, s.teamId, (tx) => loadGrant(tx, s));

export const needsRefresh = (row: GrantRow, now: Date): boolean =>
  row.kind === "oauth" &&
  row.expiresAt !== null &&
  row.expiresAt.getTime() - REFRESH_SKEW_MS <= now.getTime();
export const isExpired = (row: GrantRow, now: Date): boolean =>
  row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime();

export async function auditRefusal(
  db: KaijuDb,
  subject: Subject,
  name: string,
  reason: "resource_mismatch" | "user_inactive",
): Promise<void> {
  try {
    await withTeam(db, subject.teamId, (tx) =>
      recordAudit(tx, {
        action: "mcp.grant.refused",
        actor: SYSTEM_ACTOR,
        teamId: subject.teamId,
        target: { connectorId: subject.connectorId, name, reason },
      }),
    );
  } catch {
    // The refusal stands even if the audit write fails; the caller gets "unavailable".
  }
}

/** Opens the sealed material; the token was issued for one server and must not go elsewhere. */
export async function openRow(
  db: KaijuDb,
  envelope: Envelope,
  subject: Subject,
  row: GrantRow,
): Promise<RevealOutcome> {
  const plaintext = envelope.openString(
    row.sealed,
    grantContext(subject.teamId, subject.userId, subject.connectorId),
  );
  if (row.kind !== "oauth") {
    return { ok: true, credential: { kind: "api_key", apiKey: plaintext }, source: "member" };
  }
  const bundle = parseOauthBundle(plaintext);
  if (!sameUrl(bundle.resource, row.connectorUrl)) {
    await auditRefusal(db, subject, row.connectorName, "resource_mismatch");
    return UNAVAILABLE;
  }
  return {
    ok: true,
    credential: { kind: "oauth", accessToken: bundle.access_token },
    source: "member",
  };
}

/** Serves the row's token when it is still valid; otherwise the grant is unavailable. */
export const serveIfValid = (
  db: KaijuDb,
  envelope: Envelope,
  subject: Subject,
  row: GrantRow,
  now: Date,
): Promise<RevealOutcome> =>
  isExpired(row, now) ? Promise.resolve(UNAVAILABLE) : openRow(db, envelope, subject, row);

/** A lookup that is not a usable grant row, as a reveal outcome (undefined for a row). */
export async function refusal(
  db: KaijuDb,
  subject: Subject,
  row: GrantLookup,
): Promise<RevealOutcome | undefined> {
  if (typeof row !== "string") return undefined;
  // Only OAuth grants come back here after a refresh race; a site key is never refreshed.
  if (row === "site_key") return { ok: false, failure: "not_connected" };
  if (row === "user_inactive") {
    await auditRefusal(db, subject, "connector", "user_inactive");
    return { ok: false, failure: "not_available" };
  }
  return { ok: false, failure: row };
}
