import type { BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthMiddleware,
  getIP,
  getSessionFromCtx,
  isAPIError,
} from "better-auth/api";
import { eq, users, type KobeDb } from "@kobe/db";
import { recordAuditAfter } from "../audit/record.js";
import type { BackgroundTasks } from "../background.js";
import type { ClientIpWatch } from "./client-ip-watch.js";
import {
  normalizeSignInEmail,
  signInAccountKey,
  THROTTLED_MESSAGE,
  type SignInAttempt,
  type SignInThrottle,
} from "./sign-in-throttle.js";

type AuthCtx = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];
type Kind = "password" | "second_factor" | "session_password";

const PASSWORD_SIGN_IN = "/sign-in/email";
/** The second step of a password sign-in (no session yet: the two-factor cookie names the user). */
const SECOND_FACTOR = new Set([
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
  "/two-factor/verify-otp",
]);
/** Signed-in endpoints that check the account's password (a stolen session guessing it). */
const SESSION_PASSWORD = new Set([
  "/change-password",
  "/two-factor/enable",
  "/two-factor/disable",
  "/two-factor/get-totp-uri",
  "/two-factor/generate-backup-codes",
]);
/** The error codes that are a wrong secret, per kind; every other outcome is refunded. */
const COUNTED: Readonly<Record<Kind, ReadonlySet<string>>> = {
  password: new Set(["INVALID_EMAIL_OR_PASSWORD"]),
  second_factor: new Set(["INVALID_CODE", "INVALID_BACKUP_CODE", "OTP_HAS_EXPIRED"]),
  session_password: new Set(["INVALID_PASSWORD"]),
};
/**
 * Endpoints whose success is a sign-in that proves something a guesser lacks: it clears the
 * account's throttle. Not passkey sign-in: whoever holds a session can register a passkey and sign
 * in with it, which would hand a stolen session fresh password guesses (KOBE-812 review L2); a
 * passkey sign-in is never refused by the throttle anyway.
 */
const SIGN_IN_ENDS = new Set([
  PASSWORD_SIGN_IN,
  ...SECOND_FACTOR,
  "/invitation/accept",
  "/sso/callback/:slug",
]);

/** The SSO callback ends with a redirect, which Better Auth carries as an APIError (FOUND). */
function isRedirect(returned: unknown): boolean {
  const status = (returned as { statusCode?: unknown }).statusCode;
  return typeof status === "number" && status >= 300 && status < 400;
}

interface Target {
  readonly kind: Kind;
  readonly account: string;
  /** Known for second-factor and signed-in attempts; looked up by email only when needed. */
  readonly userId?: string;
  /** Made from a signed-in session (its success proves nothing new: refunded, never clears). */
  readonly session?: true;
  readonly email?: string;
}

interface Pending extends Target {
  readonly attempt: SignInAttempt;
}

function codeOf(returned: unknown): string {
  const code = (returned as { body?: { code?: unknown } }).body?.code;
  return typeof code === "string" ? code : "";
}

/**
 * The per-account sign-in throttle on Better Auth's endpoints (KOBE-812). Before a password or
 * second factor is checked, one attempt is reserved for the account (keyed by a keyed hash of the
 * normalized email, the same for addresses with and without an account); a throttled account is
 * answered 429 with a retry hint before its secret is looked at, so a correct password is refused
 * too until the next allowed attempt. After the endpoint, a wrong secret keeps the reservation,
 * any other outcome gives it back, and a completed password or SSO sign-in clears the account. The
 * first failure that throttles an account in a window is audited (`auth.sign_in.throttled`) and
 * listed in the Site console. Passkeys and single sign-on are not counted (nothing to guess); a
 * passkey sign-in does not clear (see SIGN_IN_ENDS). `/verify-password` and `/delete-user` are
 * disabled in auth.ts (`disabledPaths`), so every password or code check passes through here.
 *
 * Register after the two-factor and SSO-link plugins (their after hooks decide whether a sign-in
 * completed) and before the audit plugin. `onRequest` also reports requests whose client address
 * Better Auth can't resolve (its own limiter then shares one bucket per path).
 */
export function signInThrottlePlugin(o: {
  readonly db: KobeDb;
  readonly secret: string;
  readonly throttle: SignInThrottle;
  readonly background: BackgroundTasks;
  readonly clientIps?: ClientIpWatch | undefined;
}) {
  const { db, secret, throttle, background } = o;
  const keyOf = (email: string) => signInAccountKey(secret, email);
  // Keyed by the incoming Request, which before and after hooks share; GC'd with it.
  const pending = new WeakMap<object, Pending>();

  async function targetOf(ctx: AuthCtx): Promise<Target | null> {
    if (ctx.path === PASSWORD_SIGN_IN) {
      const email = (ctx.body as { email?: unknown } | undefined)?.email;
      if (typeof email !== "string" || email.length > 320) return null;
      return { kind: "password", account: keyOf(email), email };
    }
    if (SECOND_FACTOR.has(ctx.path)) {
      // With a session this is enrolment or a re-check, not a sign-in: still a code guess, counted.
      const session = await getSessionFromCtx(ctx).catch(() => null);
      if (session) {
        const { id, email } = session.user;
        return { kind: "second_factor", account: keyOf(email), userId: id, session: true };
      }
      const user = await twoFactorUser(ctx);
      return user ? { kind: "second_factor", account: keyOf(user.email), userId: user.id } : null;
    }
    if (SESSION_PASSWORD.has(ctx.path)) {
      const session = await getSessionFromCtx(ctx).catch(() => null);
      if (!session) return null;
      const { id, email } = session.user;
      return { kind: "session_password", account: keyOf(email), userId: id, session: true };
    }
    return null;
  }

  /** Announces a newly throttled account once per window: audit event (and the Site notice). */
  async function announce(target: Target, until: number): Promise<void> {
    const userId = target.userId ?? (await userIdByEmail(db, target.email));
    // An address without an account is throttled the same way, with nobody to tell.
    if (!userId) return;
    if (!(await throttle.markThrottled(userId, until))) return;
    await recordAuditAfter(db, {
      action: "auth.sign_in.throttled",
      actor: { kind: "user", id: null },
      target: { userId, until: new Date(until).toISOString() },
    });
  }

  async function settle(ctx: AuthCtx): Promise<void> {
    const p = ctx.request ? pending.get(ctx.request) : undefined;
    const returned = ctx.context.returned;
    if (isAPIError(returned) && !isRedirect(returned)) {
      if (!p) return;
      if (!COUNTED[p.kind].has(codeOf(returned))) return throttle.refund(p.account, p.attempt);
      const until = await throttle.failed(p.account, p.attempt);
      if (until !== null) {
        background.run("sign-in throttle notice failed", () => announce(p, until));
      }
      return;
    }
    const user = ctx.context.newSession?.user;
    if (SIGN_IN_ENDS.has(ctx.path) && user && !p?.session) {
      return throttle.clear(keyOf(user.email), user.id);
    }
    // A changed password proves the account holder as much as a reset does.
    if (ctx.path === "/change-password" && p) return throttle.clear(p.account, p.userId);
    if (p) await throttle.refund(p.account, p.attempt);
  }

  return {
    id: "kobe-sign-in-throttle",
    onRequest: async (request, ctx) => {
      if (o.clientIps && getIP(request, ctx.options) === null) o.clientIps.unknown("sign-in");
      return undefined;
    },
    hooks: {
      before: [
        {
          matcher: (ctx) =>
            ctx.path === PASSWORD_SIGN_IN ||
            SECOND_FACTOR.has(ctx.path ?? "") ||
            SESSION_PASSWORD.has(ctx.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            const target = await targetOf(ctx);
            if (!target) return;
            const verdict = await throttle.begin(target.account);
            if (!verdict.allowed) {
              const seconds = String(verdict.retryAfterSeconds);
              throw new APIError(
                "TOO_MANY_REQUESTS",
                { message: THROTTLED_MESSAGE },
                { "X-Retry-After": seconds, "Retry-After": seconds },
              );
            }
            if (ctx.request) pending.set(ctx.request, { ...target, attempt: verdict });
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) =>
            SIGN_IN_ENDS.has(ctx.path ?? "") || SESSION_PASSWORD.has(ctx.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            await settle(ctx);
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}

/** The user the pending two-factor challenge belongs to (Better Auth's signed `two_factor` cookie). */
async function twoFactorUser(ctx: AuthCtx): Promise<{ id: string; email: string } | null> {
  const cookie = ctx.context.createAuthCookie("two_factor");
  const identifier = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
  if (!identifier) return null;
  const challenge = await ctx.context.internalAdapter.findVerificationValue(identifier);
  if (!challenge || new Date(challenge.expiresAt).getTime() <= Date.now()) return null;
  const user = await ctx.context.internalAdapter.findUserById(challenge.value);
  return user ? { id: user.id, email: user.email } : null;
}

async function userIdByEmail(db: KobeDb, email: string | undefined): Promise<string | null> {
  if (!email) return null;
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, normalizeSignInEmail(email)));
  return row?.id ?? null;
}
