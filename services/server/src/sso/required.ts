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

export type TurnOnOutcome =
  { readonly ok: true; readonly sessionsEnded: number } | { readonly ok: false };

/** Turns the setting on from `sessionId`, which must be an SSO session of an enabled provider. */
export function turnOnSsoRequired(db: KobeDb, sessionId: string): Promise<TurnOnOutcome> {
  return db.transaction(async (tx): Promise<TurnOnOutcome> => {
    await lockSsoRequired(tx);
    if (!(await signedInThroughEnabledProvider(tx, sessionId))) return { ok: false };
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
    target: { reason: "last_provider", ...provider },
  });
  return true;
}
