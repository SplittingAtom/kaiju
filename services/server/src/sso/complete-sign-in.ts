import type { GenericEndpointContext } from "better-auth";
import { getSessionFromCtx } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { eq, sessions, sessionSsoContexts, type KobeDb } from "@kobe/db";
import { recordAuditAfter } from "../audit/record.js";
import type { VerifiedIdentity } from "./claims.js";
import type { SsoProvider } from "./oidc-flow.js";

async function capSessionExpiry<S extends { id: string; expiresAt: Date }>(
  db: KobeDb,
  session: S,
  hours: number | null,
): Promise<S> {
  if (hours === null) return session;
  const cap = new Date(Date.now() + hours * 3_600_000);
  if (session.expiresAt.getTime() <= cap.getTime()) return session;
  await db.update(sessions).set({ expiresAt: cap }).where(eq(sessions.id, session.id));
  return { ...session, expiresAt: cap };
}

/**
 * The end of a successful SSO callback (KOBE-628, spec sso-oidc-scim §9): replaces the browser's
 * session with a new one, caps it at the provider's `max_session_hours`, records its
 * `session_sso_contexts` row, sets the cookie and audits the sign-in.
 */
export async function completeSsoSignIn(
  ctx: GenericEndpointContext,
  db: KobeDb,
  s: {
    readonly provider: SsoProvider;
    readonly userId: string;
    readonly identity: VerifiedIdentity;
    /** What proved MFA (`mfaEvidence`), or null. */
    readonly mfa: string | null;
    /** Let in on a site role despite a groups overage (KOBE-775): audited as such. */
    readonly groupsOverage?: boolean;
  },
): Promise<void> {
  const adapter = ctx.context.internalAdapter;
  // A new session id at every sign-in; the browser's previous session ends (fixation).
  const prior = await getSessionFromCtx(ctx).catch(() => null);
  if (prior) await adapter.deleteSession(prior.session.token);
  const created = await adapter.createSession(s.userId);
  const user = await adapter.findUserById(s.userId);
  if (!created || !user) throw new Error("session not created");
  // max_session_hours caps the expiry (§9, review finding 9a); requireSession also ends
  // the session once the hours have passed since sign-in, whatever a refresh did.
  const session = await capSessionExpiry(db, created, s.provider.maxSessionHours);
  try {
    await db.insert(sessionSsoContexts).values({
      sessionId: session.id,
      providerId: s.provider.id,
      mfaSatisfied: s.mfa !== null,
      amr: [...s.identity.amr],
      acr: s.identity.acr,
      authTime: s.identity.authTime,
    });
  } catch (err) {
    await adapter.deleteSession(session.token);
    throw err;
  }
  await setSessionCookie(ctx, { session, user });
  await recordAuditAfter(db, {
    action: "auth.sign_in.succeeded",
    actor: { kind: "user", id: s.userId },
    // What proved MFA (review L3; the session row has no acrs column).
    target: {
      method: "sso",
      ...(s.mfa === null ? {} : { mfa: s.mfa }),
      ...(s.groupsOverage === true ? { groupsOverage: true as const } : {}),
    },
  });
}
