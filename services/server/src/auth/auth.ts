import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { twoFactor } from "better-auth/plugins";
import {
  accounts,
  passkeys,
  rateLimits,
  sessions,
  twoFactors,
  users,
  verifications,
  type KobeDb,
} from "@kobe/db";
import type { AuthAttemptAudit } from "../audit/attempts.js";
import { auditPlugin } from "../audit/auth-plugin.js";
import { recordAuditAfter } from "../audit/record.js";
import type { BackgroundTasks } from "../background.js";
import type { Mailer } from "../mail/mailer.js";
import { passwordResetMessage } from "../mail/messages.js";
import { readAppName } from "../branding/settings.js";
import { isDeactivated } from "../users/deactivation.js";
import { invitationPlugin, PASSWORD_MAX, PASSWORD_MIN } from "./invitation-plugin.js";
import {
  claimResetLinkSend,
  hasLocalPassword,
  releaseResetLinkClaim,
  revokeResetLinks,
} from "./reset-links.js";
import { authGuards } from "./guards.js";
import type { ClientIpWatch } from "./client-ip-watch.js";
import { sessionRotation } from "./rotation.js";
import { signInAccountKey, type SignInThrottle } from "./sign-in-throttle.js";
import { signInThrottlePlugin } from "./sign-in-throttle-plugin.js";
import { ssoLinkPlugin } from "./sso-link-plugin.js";
import { ssoPlugin, SSO_RATE_LIMITS, type SsoRuntime } from "./sso-plugin.js";

export interface AuthOptions {
  readonly db: KobeDb;
  /** Public origin of the install, e.g. https://kobe.example.com (WebAuthn RP origin). */
  readonly publicUrl: string;
  /**
   * Signs cookies and encrypts TOTP secrets and backup codes (>= 32 chars).
   * Rotating it without Better Auth's `secrets` versioning makes enrolled 2FA unusable.
   */
  readonly secret: string;
  /** Proxy CIDRs whose X-Forwarded-For entries are trusted (Traefik/LB); used for rate limits. */
  readonly trustedProxies: readonly string[];
  /** Sends password-reset emails (SMTP in production, in memory in tests). */
  readonly mailer: Mailer;
  /** Audit of unauthenticated attempts, aggregated per window (KOBE-15). */
  readonly attempts: AuthAttemptAudit;
  /** Runs the reset email and its audit off the request path. */
  readonly background: BackgroundTasks;
  /** OIDC single sign-on (KOBE-628); unset: no SSO routes at all. */
  readonly sso?: SsoRuntime;
  /** Per-account throttle of failed password and second-factor attempts (KOBE-812). */
  readonly signInThrottle: SignInThrottle;
  /** Reports requests without a resolvable client IP (KOBE-812). */
  readonly clientIps?: ClientIpWatch;
}

/** Password-reset links work once, for 30 minutes. */
export const RESET_TOKEN_TTL_SECONDS = 30 * 60;

const ACCOUNT_DEACTIVATED = {
  code: "ACCOUNT_DEACTIVATED",
  message: "This account is deactivated. Ask a site admin to reactivate it.",
};

/**
 * Better Auth embedded in the server (spec D7): invite-only email + password (no sign-up),
 * WebAuthn passkeys with required user verification and TOTP 2FA (no JWTs: the jwt plugin had no
 * consumer, KOBE-785; the `jwks` table stays until a migration drops it). Sessions live in
 * Postgres and are looked up on every request (no cookie cache), so revocation is immediate. Rate
 * limits are stored in Postgres so every replica shares them.
 */
export function createAuth({
  db,
  publicUrl,
  secret,
  trustedProxies,
  mailer,
  attempts,
  background,
  sso,
  signInThrottle,
  clientIps,
}: AuthOptions) {
  const origin = new URL(publicUrl);
  const rotation = sessionRotation(db);

  /**
   * Mails a reset link, off the request path: the response (and its timing) is the same whether or
   * not the address has an account. Deactivated accounts get nothing; while a link mailed in the last
   * few minutes is still valid no other is sent (mail bombing through many IPs). The token travels in the URL fragment, which browsers never send to
   * servers or proxies (no token in access logs). An account without a local password (provisioned
   * by SCIM or SSO, SSO9) gets nothing, and the unsent token is dropped: resetting would create a
   * password and get round the identity provider.
   */
  async function mailResetLink(user: { id: string; email: string }, token: string) {
    if (await isDeactivated(db, user.id)) return;
    // A user made by SSO (JIT) or SCIM has no password: a reset must not give them one, or the
    // mailbox could outlive the identity provider's disable (spec sso-oidc-scim §6, SSO9).
    if (!(await hasLocalPassword(db, user.id))) {
      await revokeResetLinks(db, user.id);
      return;
    }
    // Not awaited: the email must not wait on the audit write. Aggregated: anyone can request
    // resets for an address in any number.
    background.run("password reset audit failed", () =>
      attempts.record({ action: "auth.password.reset_requested", userId: user.id }),
    );
    // A recent link is still usable: don't send another (soft; never blocks a later request).
    if (!(await claimResetLinkSend(db, user.id, token))) return;
    try {
      await mailer.send(
        passwordResetMessage({
          appName: await readAppName(db),
          to: user.email,
          link: `${origin.origin}/reset-password#token=${token}`,
          expiresInMinutes: RESET_TOKEN_TTL_SECONDS / 60,
        }),
      );
    } catch (err) {
      // Only a delivered email counts.
      await releaseResetLinkClaim(db, user.id, token);
      throw err;
    }
  }

  return betterAuth({
    appName: "Kobe",
    baseURL: origin.origin,
    basePath: "/api/auth",
    secret,
    trustedOrigins: [origin.origin],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: users,
        session: sessions,
        account: accounts,
        verification: verifications,
        twoFactor: twoFactors,
        passkey: passkeys,
        rateLimit: rateLimits,
      },
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: PASSWORD_MIN,
      maxPasswordLength: PASSWORD_MAX,
      // Single-use (consumed atomically), short-lived, and a reset ends every session.
      resetPasswordTokenExpiresIn: RESET_TOKEN_TTL_SECONDS,
      revokeSessionsOnPasswordReset: true,
      // The used link is consumed; any other mailed link dies with it.
      onPasswordReset: async ({ user }) => {
        await revokeResetLinks(db, user.id);
        // A reset proves the mailbox: the account's sign-in throttle ends (KOBE-812).
        await signInThrottle.clear(signInAccountKey(secret, user.email), user.id);
        await recordAuditAfter(db, {
          action: "auth.password.reset",
          actor: { kind: "user", id: user.id },
          target: { userId: user.id },
        });
      },
      sendResetPassword: async ({ user, token }) => {
        background.run("password reset email failed", () => mailResetLink(user, token), {
          userId: user.id,
        });
      },
    },
    // Reset tokens, 2FA and passkey challenges are stored as SHA-256 hashes, never in plain text.
    verification: { storeIdentifier: "hashed" },
    session: { cookieCache: { enabled: false } },
    rateLimit: {
      enabled: true,
      storage: "database",
      customRules: {
        "/request-password-reset": { window: 60, max: 3 },
        "/reset-password": { window: 60, max: 5 },
        "/invitation/lookup": { window: 60, max: 10 },
        "/invitation/accept": { window: 60, max: 5 },
        ...SSO_RATE_LIMITS,
      },
    },
    databaseHooks: {
      session: {
        create: {
          // Every sign-in method (password, TOTP, passkey, invitation) ends in a new session: refuse
          // it for deactivated users. A trigger on `sessions` backs this up against races.
          before: async (session) => {
            if (await isDeactivated(db, session.userId)) {
              throw new APIError("FORBIDDEN", ACCOUNT_DEACTIVATED);
            }
            return undefined;
          },
        },
      },
    },
    advanced: {
      database: { generateId: "uuid" },
      useSecureCookies: origin.protocol === "https:",
      ipAddress: { ipAddressHeaders: ["x-forwarded-for"], trustedProxies: [...trustedProxies] },
    },
    // Endpoints Kobe doesn't use that check a password outside the sign-in throttle (KOBE-812
    // review M1): `/verify-password` is only labelled server-scoped and answers over HTTP;
    // `/delete-user` is off anyway (user.deleteUser not enabled).
    disabledPaths: ["/verify-password", "/delete-user"],
    telemetry: { enabled: false },
    hooks: {
      before: authGuards({ db, ssoSettings: sso?.settings, rotation }),
      after: rotation.after,
    },
    plugins: [
      invitationPlugin({ db, publicOrigin: origin.origin }),
      ssoPlugin({ db, publicOrigin: origin.origin, secret, attempts, sso }),
      // Better Auth's own account lockout (10 failed codes, then 15 minutes refused even with the
      // right code) is off: the owner decided on a growing delay, never a lockout (KOBE-812), and
      // the sign-in throttle below counts second-factor failures with the password's.
      twoFactor({ issuer: "Kobe", accountLockout: { enabled: false } }),
      passkey({
        rpID: origin.hostname,
        rpName: "Kobe",
        origin: origin.origin,
        authenticatorSelection: { userVerification: "required", residentKey: "required" },
      }),
      // After the two-factor and passkey plugins: it must see whether a sign-in completed.
      ssoLinkPlugin({ db, publicOrigin: origin.origin, secret, settings: sso?.settings }),
      // After two-factor and SSO-link (whether a sign-in completed), before audit (KOBE-812).
      signInThrottlePlugin({ db, secret, throttle: signInThrottle, background, clientIps }),
      // Last: its after hook must see the session state the other plugins leave (KOBE-15).
      auditPlugin({ db, attempts }),
    ],
  });
}

export type KobeAuth = ReturnType<typeof createAuth>;
