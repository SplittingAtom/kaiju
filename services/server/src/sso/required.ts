import {
  SYSTEM_ACTOR,
  and,
  eq,
  lockSsoRequired,
  readSsoRequiredIn,
  sessionSsoContexts,
  sessions,
  sql,
  ssoProviders,
  storeSsoRequired,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import { currentAuditContext } from "../audit/context.js";
import { recordAudit } from "../audit/record.js";
import { listSignInProviders } from "./oidc-flow.js";
import type { SsoSettings } from "./settings.js";

/**
 * "Require single sign-on" (KOBE-774, Chris 2026-11-21): a Site setting that turns password and
 * passkey sign-in off while an identity provider is configured.
 *
 * - **On** only from a session signed in through an enabled provider: that proves a working
 *   provider and that the admin turning it on can come back. Turning it on ends every session
 *   not signed in through a provider, in the same transaction.
 * - **In force** while stored on, the chart's kill switch (`auth.sso.enabled`) is on, and at least
 *   one provider can finish a sign-in (the sign-in page's list). Otherwise password sign-in works
 *   as before, so a provider that is gone or switched off in the chart never locks the Site out.
 * - **While in force** Better Auth refuses password sign-in, password reset (request and
 *   confirm), password sign-up (sign-up and invitation acceptance) and passkey sign-in
 *   (`auth.ts`), and a session not signed in through a provider ends at its next check
 *   (`session.ts`). API keys and SCIM tokens are not sessions and are unaffected.
 * - **Off** by the Owner, by the last enabled provider being disabled or deleted (same
 *   transaction, audited, site admins emailed: {@link releaseIfNoProvider}), or with cluster access
 *   by `kobe sso allow-local-sign-in` (packages/cli).
 */

export { REQUIRE_SSO_KEY } from "@kobe/db";

/** The stored setting. */
export async function readSsoRequired(db: KobeDb): Promise<boolean> {
  return readSsoRequiredIn(db);
}

/** Whether the setting is in force now (see the module comment). */
export async function ssoRequired(db: KobeDb, settings: SsoSettings): Promise<boolean> {
  if (!settings.enabled) return false;
  if (!(await readSsoRequired(db))) return false;
  return storedSettingInForce(db, settings);
}

/**
 * With the setting already read as on (the session check folds that read into its own query):
 * whether it is in force, i.e. single sign-on is on in the chart and a provider can finish a
 * sign-in.
 */
export async function storedSettingInForce(db: KobeDb, settings: SsoSettings): Promise<boolean> {
  if (!settings.enabled) return false;
  return (await listSignInProviders(db, settings.helmSecrets)).length > 0;
}

/** The session was signed in through a provider that is enabled now. */
export async function signedInThroughEnabledProvider(
  db: KobeDb | KobeTx,
  sessionId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: ssoProviders.id })
    .from(sessionSsoContexts)
    .innerJoin(ssoProviders, eq(ssoProviders.id, sessionSsoContexts.providerId))
    .where(and(eq(sessionSsoContexts.sessionId, sessionId), eq(ssoProviders.enabled, true)));
  return row !== undefined;
}

/** Deletes every session not signed in through a provider; returns how many ended. */
async function endLocalSessions(tx: KobeTx): Promise<number> {
  const gone = await tx
    .delete(sessions)
    .where(
      sql`NOT EXISTS (SELECT 1 FROM ${sessionSsoContexts} c WHERE c.session_id = ${sessions.id})`,
    )
    .returning({ id: sessions.id });
  return gone.length;
}

/**
 * Active accounts with no identity at an enabled provider (review H1): they could not sign in
 * while the setting is on. Counts only, never who. `owners` must be 0 to turn it on: an Owner
 * can't be linked by **Expect SSO link** (SSO10) and only the Owner turns the setting off.
 */
export interface UnlinkedCounts {
  readonly owners: number;
  readonly siteRoles: number;
  readonly users: number;
}

export async function unlinkedCounts(db: KobeDb | KobeTx): Promise<UnlinkedCounts> {
  const res = await db.execute<{ owners: number; site_roles: number; users: number }>(sql`
    SELECT count(*) FILTER (WHERE r.role = 'owner')::int AS owners,
           count(r.role)::int AS site_roles,
           count(*)::int AS users
      FROM users u
      LEFT JOIN site_roles r ON r.user_id = u.id
     WHERE u.deactivated_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM sso_identities i JOIN sso_providers p ON p.id = i.provider_id
          WHERE i.user_id = u.id AND p.enabled)`);
  const row = res.rows[0];
  return {
    owners: Number(row?.owners ?? 0),
    siteRoles: Number(row?.site_roles ?? 0),
    users: Number(row?.users ?? 0),
  };
}

/**
 * The invariant (second review): while the setting is stored on, every active Owner has an
 * identity at an enabled provider. Every write that could break it takes {@link lockSsoRequired}
 * before changing anything and calls {@link assertOwnerKeepsSignIn} after: turning it on, disabling
 * or deleting a provider, transferring ownership, unlinking an identity. Thrown to roll the change
 * back; callers turn it into a 409.
 */
export class OwnerWouldLoseSignInError extends Error {
  constructor() {
    super("the Owner would have no identity at an enabled provider");
    this.name = "OwnerWouldLoseSignInError";
  }
}

/** Active Owners without an identity at an enabled provider. */
async function unlinkedOwners(tx: KobeTx): Promise<number> {
  const res = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM site_roles r JOIN users u ON u.id = r.user_id
     WHERE r.role = 'owner' AND u.deactivated_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM sso_identities i JOIN sso_providers p ON p.id = i.provider_id
          WHERE i.user_id = u.id AND p.enabled)`);
  return Number(res.rows[0]?.n ?? 0);
}

/** Under the lock, after the change: throws {@link OwnerWouldLoseSignInError} if it broke the rule. */
export async function assertOwnerKeepsSignIn(tx: KobeTx): Promise<void> {
  if (!(await readSsoRequiredIn(tx))) return;
  if ((await unlinkedOwners(tx)) > 0) throw new OwnerWouldLoseSignInError();
}

/**
 * The chart's providers (start-up) can't be refused: when they leave an Owner without an identity
 * at an enabled provider, the setting turns off instead (system, `owner_unlinked`). True if so.
 */
export async function releaseIfOwnerUnlinked(
  tx: KobeTx,
  provider: { readonly providerId: string; readonly slug: string },
): Promise<boolean> {
  await lockSsoRequired(tx);
  if (!(await readSsoRequiredIn(tx))) return false;
  if ((await unlinkedOwners(tx)) === 0) return false;
  await storeSsoRequired(tx, false);
  await recordAudit(tx, {
    actor: SYSTEM_ACTOR,
    action: "identity.sso.required.disabled",
    target: { reason: "owner_unlinked", ...provider },
  });
  return true;
}

export type TurnOnOutcome =
  | { readonly ok: true; readonly sessionsEnded: number }
  | { readonly ok: false; readonly failure: "sso_session_required" }
  | { readonly ok: false; readonly failure: "owners_not_linked"; readonly owners: number };

/**
 * Turns the setting on from `sessionId`, which must be an SSO session of an enabled provider,
 * while every active Owner has an identity at an enabled provider (checked under the lock).
 */
export function turnOnSsoRequired(db: KobeDb, sessionId: string): Promise<TurnOnOutcome> {
  return db.transaction(async (tx): Promise<TurnOnOutcome> => {
    await lockSsoRequired(tx);
    if (!(await signedInThroughEnabledProvider(tx, sessionId))) {
      return { ok: false, failure: "sso_session_required" };
    }
    const { owners } = await unlinkedCounts(tx);
    if (owners > 0) return { ok: false, failure: "owners_not_linked", owners };
    if (await readSsoRequiredIn(tx)) return { ok: true, sessionsEnded: 0 };
    await storeSsoRequired(tx, true);
    const sessionsEnded = await endLocalSessions(tx);
    await recordAudit(tx, { action: "identity.sso.required.enabled", target: { sessionsEnded } });
    return { ok: true, sessionsEnded };
  });
}

/** The Owner turns the setting off. */
export function turnOffSsoRequired(db: KobeDb): Promise<void> {
  return db.transaction(async (tx) => {
    await lockSsoRequired(tx);
    if (!(await readSsoRequiredIn(tx))) return;
    await storeSsoRequired(tx, false);
    await recordAudit(tx, {
      action: "identity.sso.required.disabled",
      target: { reason: "admin" },
    });
  });
}

/**
 * After a provider was disabled or deleted in `tx`: when the setting is on and no enabled provider
 * is left, turns it off in the same transaction and audits it (the system actor when `system`,
 * e.g. the chart's providers applied at start-up). True when it was turned off: the caller then
 * emails the site admins ({@link notifySsoRequiredOff}) after the commit.
 */
export async function releaseIfNoProvider(
  tx: KobeTx,
  provider: { readonly providerId: string; readonly slug: string },
  options: { readonly system?: boolean } = {},
): Promise<boolean> {
  const actor = currentAuditContext()?.actor;
  const byUserId = !options.system && actor?.kind === "user" ? actor.id : null;
  await lockSsoRequired(tx);
  if (!(await readSsoRequiredIn(tx))) return false;
  const [left] = await tx
    .select({ id: ssoProviders.id })
    .from(ssoProviders)
    .where(eq(ssoProviders.enabled, true))
    .limit(1);
  if (left) return false;
  await storeSsoRequired(tx, false);
  await recordAudit(tx, {
    ...(options.system ? { actor: SYSTEM_ACTOR } : {}),
    action: "identity.sso.required.disabled",
    // The acting admin is named in the target too (review M2): disabling the last provider is
    // the one way an Admin, not only the Owner, ends the requirement (a deliberate safety valve).
    target: {
      reason: "last_provider",
      ...provider,
      ...(byUserId ? { byUserId } : {}),
    },
  });
  return true;
}
