import {
  SYSTEM_ACTOR,
  and,
  connectors,
  eq,
  isNull,
  siteRoles,
  sql,
  users,
  type Envelope,
  type KaijuDb,
} from "@kaiju/db";
import { recordAuditAfter } from "../audit/record.js";
import { adminProbeGrant, type RefreshSupport } from "./grants.js";
import type { ProbeCredentialKind } from "./probe.js";
import { revealSiteKey } from "./site-key.js";

/**
 * Which credential probes a connector's `tools/list` (KOBE-431, decision (a) of 2026-10-19; the
 * site-wide key of KOBE-303 first). Pins are site-wide trust, so a probe uses, in this order:
 *
 * 1. the connector's site-wide API key, when it has one (KOBE-303);
 * 2. the own API key of one site admin: for the periodic refresh the admin who last pinned or
 *    re-approved the connector (`connectors.pinned_by`), for an admin's own action that admin;
 *    only while they are active and still a site admin;
 * 3. nothing: a server that wants a credential answers `auth_required`.
 *
 * An `oauth` connector (KOBE-784, owner decision 2026-11-22) has no site key: it is probed with
 * the same admin's own OAuth access token (`admin_oauth`), revealed (and refreshed, through the
 * leased refresh) like a member's, and sent to the proxy's probe only, as a bearer token for the
 * `initialize` / `tools/list` / template reads of a probe, never for a tool call or a sandbox.
 *
 * Never a member's key. One function for every probe (registration, pin, refresh, KOBE-430's
 * Re-probe button), so the rule lives in one place. The value is returned to the caller only, for
 * the one probe; {@link auditProbeCredential} records the choice without it.
 */
export type ProbeCredentialSource = "site_key" | "admin_key" | "admin_oauth" | "none";

export interface ProbeCredential {
  readonly source: ProbeCredentialSource;
  /** The admin whose key or token it is (`admin_key`, `admin_oauth`). */
  readonly adminId?: string;
  /** For the probe only: never stored, logged or audited. */
  readonly apiKey?: string;
  /** `admin_oauth`: the admin's OAuth access token, for the probe only (never stored or logged). */
  readonly accessToken?: string;
}

/** What a probe sends the proxy: the secret and how it is labelled (both become a bearer token). */
export interface ProbeSecret {
  readonly value: string;
  readonly kind: ProbeCredentialKind;
}

export function probeSecret(choice: ProbeCredential): ProbeSecret | undefined {
  if (choice.accessToken !== undefined) return { value: choice.accessToken, kind: "access_token" };
  if (choice.apiKey !== undefined) return { value: choice.apiKey, kind: "api_key" };
  return undefined;
}

const NONE: ProbeCredential = { source: "none" };

/** Active (not deactivated) and holding a site role, so trusted with site-wide pins. */
async function isActiveSiteAdmin(db: KaijuDb, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(siteRoles, eq(siteRoles.userId, users.id))
    .where(and(eq(users.id, userId), isNull(users.deactivatedAt)));
  return row !== undefined;
}

export async function chooseProbeCredential(
  db: KaijuDb,
  envelope: Envelope | undefined,
  connectorId: string,
  /** The admin acting now, or `"pinned_by"` for the admin who last pinned or approved it. */
  admin: string | "pinned_by",
  /** Refreshes an admin's expired OAuth token (this process's gate, KOBE-778/784). */
  refresh?: RefreshSupport,
): Promise<ProbeCredential> {
  const [row] = await db
    .select({ authKind: connectors.authKind, pinnedBy: connectors.pinnedBy })
    .from(connectors)
    .where(eq(connectors.id, connectorId));
  if (!row || row.authKind === "none" || !envelope) return NONE;
  const adminId = admin === "pinned_by" ? row.pinnedBy : admin;
  if (row.authKind === "oauth") {
    const accessToken = await usableAdminGrant(
      db,
      envelope,
      connectorId,
      adminId,
      "oauth",
      refresh,
    );
    return accessToken === undefined || adminId === null
      ? NONE
      : { source: "admin_oauth", adminId, accessToken };
  }
  const siteKey = await revealSiteKey(db, envelope, connectorId);
  if (siteKey !== undefined) return { source: "site_key", apiKey: siteKey };
  const apiKey = await usableAdminGrant(db, envelope, connectorId, adminId, "api_key");
  return apiKey === undefined || adminId === null ? NONE : { source: "admin_key", adminId, apiKey };
}

/** The admin's own key or token, while they are an active site admin; never anyone else's. */
async function usableAdminGrant(
  db: KaijuDb,
  envelope: Envelope,
  connectorId: string,
  adminId: string | null,
  kind: "api_key" | "oauth",
  refresh?: RefreshSupport,
): Promise<string | undefined> {
  if (adminId === null || !(await isActiveSiteAdmin(db, adminId))) return undefined;
  return adminProbeGrant(db, envelope, adminId, connectorId, kind, refresh);
}

/**
 * Who `connectors.pinned_by` should name after `adminId` pins or re-approves the connector
 * (KOBE-431 review M1): `adminId` when their own key can probe it, or when the admin named now
 * has no usable key either (null, deactivated, demoted or keyless); otherwise unchanged
 * (undefined), so an approval by a keyless admin never stops the refresh of a connector another
 * admin's key still checks.
 */
export async function nextPinnedBy(
  db: KaijuDb,
  envelope: Envelope | undefined,
  connectorId: string,
  adminId: string,
  refresh?: RefreshSupport,
): Promise<string | undefined> {
  const [row] = await db
    .select({ authKind: connectors.authKind, pinnedBy: connectors.pinnedBy })
    .from(connectors)
    .where(eq(connectors.id, connectorId));
  if (!row) return undefined;
  if (row.pinnedBy === adminId) return undefined;
  if (row.authKind === "none" || !envelope) return adminId;
  const kind = row.authKind === "oauth" ? "oauth" : "api_key";
  const usable = (id: string | null) =>
    usableAdminGrant(db, envelope, connectorId, id, kind, refresh);
  if ((await usable(adminId)) !== undefined) return adminId;
  const current = await usable(row.pinnedBy);
  return current === undefined ? adminId : undefined;
}

export type ProbePurpose = "pin" | "refresh";

const auditTarget = (
  connectorId: string,
  name: string,
  purpose: ProbePurpose,
  choice: ProbeCredential,
) => ({
  connectorId,
  name,
  purpose,
  credential: choice.source,
  ...(choice.adminId === undefined ? {} : { adminId: choice.adminId }),
});

/** The refresh's last recorded choice, to audit only a change. */
async function lastRefreshChoice(
  db: KaijuDb,
  connectorId: string,
): Promise<Record<string, unknown> | undefined> {
  const rows = await db.execute<{ target: Record<string, unknown> }>(sql`
    SELECT target FROM audit_log
     WHERE action = 'mcp.connector.probe_credential'
       AND target->>'connectorId' = ${connectorId} AND target->>'purpose' = 'refresh'
     ORDER BY seq DESC LIMIT 1`);
  return rows.rows[0]?.target;
}

/**
 * Records the choice, never the value: every pin (an admin's action, as that admin), and the
 * refresh (system actor) only when its choice differs from the last one recorded.
 */
export async function auditProbeCredential(
  db: KaijuDb,
  connector: { readonly id: string; readonly name: string },
  purpose: ProbePurpose,
  choice: ProbeCredential,
): Promise<void> {
  const target = auditTarget(connector.id, connector.name, purpose, choice);
  if (purpose === "refresh") {
    const last = await lastRefreshChoice(db, connector.id);
    if (
      last &&
      last.credential === target.credential &&
      last.adminId === (target as { adminId?: string }).adminId
    ) {
      return;
    }
  }
  await recordAuditAfter(db, {
    action: "mcp.connector.probe_credential",
    ...(purpose === "refresh" ? { actor: SYSTEM_ACTOR } : {}),
    target,
  });
}

/**
 * The credential of a pin an admin asked for (registration, a new URL, the pin endpoint, KOBE-430's
 * Re-probe): chosen with that admin as the fallback, and audited as theirs.
 */
export function adminPinCredential(
  db: KaijuDb,
  envelope: Envelope | undefined,
  adminId: string,
  refresh?: RefreshSupport,
): (connector: { readonly id: string; readonly name: string }) => Promise<ProbeSecret | undefined> {
  return async (connector) => {
    const choice = await chooseProbeCredential(db, envelope, connector.id, adminId, refresh);
    await auditProbeCredential(db, connector, "pin", choice);
    return probeSecret(choice);
  };
}
