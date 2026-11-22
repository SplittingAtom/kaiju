import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { eq, sessionSsoContexts, users, type KobeDb } from "@kobe/db";
import { passkeyIsLastSignIn } from "../sso/linking.js";
import { ssoRequired } from "../sso/required.js";
import { SSO_OFF, type SsoSettings } from "../sso/settings.js";
import { hasLocalPassword } from "./reset-links.js";
import type { SessionRotation } from "./rotation.js";
import { isUserVerified } from "./webauthn-flags.js";

/**
 * Endpoints that add a local credential or factor to the signed-in account (SSO9, review finding 3):
 * refused for a user with no `credential` account (made by SSO JIT or SCIM), who signs in only
 * through the identity provider, so an IdP-side disable can never be outlived by a local passkey
 * or password. TOTP enrolment is refused too (it would be a Kobe factor the IdP doesn't govern).
 */
const LOCAL_CREDENTIAL_PATHS = new Set([
  "/passkey/generate-register-options",
  "/passkey/verify-registration",
  "/passkey/register",
  "/change-password",
  "/two-factor/enable",
]);

const SSO_ONLY_ACCOUNT = {
  code: "SSO_ONLY_ACCOUNT",
  message:
    "This account signs in through your organization's identity provider and can't have a Kobe password, passkey or authenticator app.",
};

/**
 * Endpoints that add a credential or second factor (TOTP secret, its confirmation, backup codes,
 * a passkey, a new password): refused from an SSO session whose sign-in did not prove MFA (spec
 * sso-oidc-scim §8, SSO7, KOBE-629 and its review M1), so a stolen IdP password can never mint a
 * factor that later passes `require_2fa` through a local sign-in. A local session, or an SSO
 * session that proved MFA, is unaffected; the TOTP sign-in challenge carries no session.
 */
const MFA_GUARDED_PATHS = new Set([
  ...LOCAL_CREDENTIAL_PATHS,
  // Removing a factor too (KOBE-630 review M2): it would also rotate the session.
  "/two-factor/disable",
  "/two-factor/get-totp-uri",
  "/two-factor/verify-totp",
  "/two-factor/generate-backup-codes",
]);

const SSO_MFA_REQUIRED = {
  code: "SSO_MFA_REQUIRED",
  message:
    "Your organization's sign-in did not include multi-factor authentication, so this session can't add a passkey, password or authenticator app. Sign in again with multi-factor authentication (your administrator sets it up with Conditional Access).",
};

/** The session is a single sign-on session whose sign-in did not prove MFA. */
async function ssoSessionWithoutMfa(db: KobeDb, sessionId: string): Promise<boolean> {
  const [row] = await db
    .select({ mfaSatisfied: sessionSsoContexts.mfaSatisfied })
    .from(sessionSsoContexts)
    .where(eq(sessionSsoContexts.sessionId, sessionId));
  return row !== undefined && !row.mfaSatisfied;
}

/**
 * Endpoints that remove a local credential or factor: refused from an SSO session of the setup Owner
 * (SSO10, KOBE-630), so no single sign-on path can take away the break-glass identity's password
 * or passkey. From a local session the Owner manages them as before.
 */
const LOCAL_CREDENTIAL_REMOVAL_PATHS = new Set([
  "/passkey/delete-passkey",
  "/unlink-account",
  // Its second factor too (review L3).
  "/two-factor/disable",
]);

const SETUP_OWNER_LOCAL_ONLY = {
  code: "SETUP_OWNER_LOCAL_ONLY",
  message:
    "The setup Owner's password, passkeys and authenticator app can only be removed from a session signed in with them, not through single sign-on.",
};

/** The session is an SSO session of the setup Owner. */
async function setupOwnerSsoSession(
  db: KobeDb,
  session: { readonly id: string; readonly userId: string },
): Promise<boolean> {
  const [row] = await db
    .select({ setupOwner: users.setupOwner })
    .from(sessionSsoContexts)
    .innerJoin(users, eq(users.id, session.userId))
    .where(eq(sessionSsoContexts.sessionId, session.id));
  return row?.setupOwner === true;
}

/**
 * Local sign-in and its credentials' recovery (KOBE-774): refused while the Site requires single
 * sign-on (`sso/required.ts`): password sign-in, password reset (request and confirm), password
 * sign-up (Better Auth's, off anyway, and invitation acceptance, which sets a password) and
 * passkey sign-in. A session such a path minted before the switch ends at its next check.
 */
const LOCAL_SIGN_IN_PATHS = new Set([
  "/sign-in/email",
  "/sign-in/username",
  "/request-password-reset",
  "/forget-password",
  "/reset-password",
  "/sign-up/email",
  "/invitation/accept",
  "/passkey/generate-authenticate-options",
  "/passkey/verify-authentication",
]);

const SSO_REQUIRED = {
  code: "SSO_REQUIRED",
  message: "This site requires single sign-on. Sign in with your organization's identity provider.",
};

const LAST_SIGN_IN_METHOD = {
  code: "LAST_SIGN_IN_METHOD",
  message: "This passkey is your only way to sign in to Kobe, so it can't be removed.",
};

const PASSKEY_VERIFY_PATHS = new Set([
  "/passkey/verify-registration",
  "/passkey/verify-authentication",
]);

/**
 * Better Auth's before hook: the checks every auth endpoint passes first (local sign-in while
 * single sign-on is required, credentials of SSO-only accounts, MFA of SSO sessions, the session
 * rotation capture, the last passkey, the setup Owner's local credentials, passkey user
 * verification), and a password change revoking the other sessions.
 */
export function authGuards(o: {
  readonly db: KobeDb;
  readonly ssoSettings: SsoSettings | undefined;
  readonly rotation: SessionRotation;
}) {
  const { db, rotation } = o;
  return createAuthMiddleware(async (ctx) => {
    if (LOCAL_SIGN_IN_PATHS.has(ctx.path) && (await ssoRequired(db, o.ssoSettings ?? SSO_OFF))) {
      throw new APIError("FORBIDDEN", SSO_REQUIRED);
    }
    if (LOCAL_CREDENTIAL_PATHS.has(ctx.path)) {
      const current = await getSessionFromCtx(ctx).catch(() => null);
      if (current && !(await hasLocalPassword(db, current.user.id))) {
        throw new APIError("FORBIDDEN", SSO_ONLY_ACCOUNT);
      }
    }
    if (MFA_GUARDED_PATHS.has(ctx.path)) {
      const current = await getSessionFromCtx(ctx).catch(() => null);
      if (current && (await ssoSessionWithoutMfa(db, current.session.id))) {
        throw new APIError("FORBIDDEN", SSO_MFA_REQUIRED);
      }
    }
    if (rotation.rotates(ctx.path) && ctx.request) {
      const current = await getSessionFromCtx(ctx).catch(() => null);
      await rotation.capture(ctx.request, current);
    }
    if (ctx.path === "/passkey/delete-passkey") {
      const current = await getSessionFromCtx(ctx).catch(() => null);
      const id = (ctx.body as { id?: unknown } | undefined)?.id;
      if (
        current &&
        typeof id === "string" &&
        (await passkeyIsLastSignIn(db, current.user.id, id))
      ) {
        throw new APIError("FORBIDDEN", LAST_SIGN_IN_METHOD);
      }
    }
    if (LOCAL_CREDENTIAL_REMOVAL_PATHS.has(ctx.path)) {
      const current = await getSessionFromCtx(ctx).catch(() => null);
      if (current && (await setupOwnerSsoSession(db, current.session))) {
        throw new APIError("FORBIDDEN", SETUP_OWNER_LOCAL_ONLY);
      }
    }
    // A passkey counts as a strong factor only with user verification (PIN/biometric).
    if (
      PASSKEY_VERIFY_PATHS.has(ctx.path) &&
      !isUserVerified((ctx.body as { response?: unknown })?.response)
    ) {
      throw new APIError("FORBIDDEN", {
        message: "Passkeys must use user verification (PIN or biometric).",
      });
    }
    // A changed password ends every other session (a stolen cookie must not survive it).
    if (ctx.path === "/change-password") {
      return {
        context: { ...ctx, body: { ...(ctx.body as object), revokeOtherSessions: true } },
      };
    }
    return undefined;
  });
}
