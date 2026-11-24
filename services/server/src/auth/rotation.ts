import { createAuthMiddleware, isAPIError } from "better-auth/api";
import { and, eq, gt, sessions, sessionSsoContexts, type KaijuDb } from "@kaiju/db";
import { revokeResetLinks } from "./reset-links.js";

/**
 * Endpoints after which Better Auth replaces the session with a new one (new id, old one deleted):
 * an SSO session's `session_sso_contexts` row is carried over to the new session (KOBE-630 review
 * M2), so unlink, the kill switch, max hours and the MFA and setup-Owner guards keep applying.
 */
const SESSION_ROTATING_PATHS = new Set([
  "/two-factor/enable",
  "/two-factor/disable",
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
  "/two-factor/verify-otp",
  "/change-password",
]);

type SsoContextRow = typeof sessionSsoContexts.$inferSelect;

async function ssoContextOf(db: KaijuDb, sessionId: string): Promise<SsoContextRow | undefined> {
  const [row] = await db
    .select()
    .from(sessionSsoContexts)
    .where(eq(sessionSsoContexts.sessionId, sessionId));
  return row;
}

/** The session a request started from, as `getSessionFromCtx` returns it (or null). */
type CurrentSession = {
  readonly user: { readonly id: string };
  readonly session: { readonly id: string; readonly createdAt: Date | string };
} | null;

export type SessionRotation = ReturnType<typeof sessionRotation>;

/**
 * Session rotation and what follows a credential change: `capture` (from the before hook) remembers
 * the SSO context of the session a rotating endpoint started from, keyed by the shared Request;
 * `after` (Better Auth's after hook) carries it over to the new session and applies the
 * post-change revocations.
 */
export function sessionRotation(db: KaijuDb) {
  const rotatingFrom = new WeakMap<
    object,
    { userId: string; createdAt: Date; context: SsoContextRow }
  >();
  return {
    rotates: (path: string): boolean => SESSION_ROTATING_PATHS.has(path),

    async capture(request: object, current: CurrentSession): Promise<void> {
      const context = current ? await ssoContextOf(db, current.session.id) : undefined;
      if (current && context) {
        rotatingFrom.set(request, {
          userId: current.user.id,
          createdAt: new Date(current.session.createdAt),
          context,
        });
      }
    },

    after: createAuthMiddleware(async (ctx) => {
      // Carry an SSO session's context over to the session Better Auth replaced it with.
      const from = ctx.request ? rotatingFrom.get(ctx.request) : undefined;
      const next = ctx.context.newSession;
      if (
        from &&
        next &&
        next.user.id === from.userId &&
        next.session.id !== from.context.sessionId
      ) {
        await db
          .insert(sessionSsoContexts)
          .values({ ...from.context, sessionId: next.session.id })
          .onConflictDoNothing();
        // max_session_hours counts from the original sign-in, not from the rotation.
        await db
          .update(sessions)
          .set({ createdAt: from.createdAt })
          .where(and(eq(sessions.id, next.session.id), gt(sessions.createdAt, from.createdAt)));
      }
      // A changed password also kills any reset link still in a mailbox.
      if (
        ctx.path === "/change-password" &&
        ctx.context.session &&
        !isAPIError(ctx.context.returned)
      ) {
        await revokeResetLinks(db, ctx.context.session.user.id);
      }
      // Turning 2FA off also ends every other session.
      if (ctx.path === "/two-factor/disable" && ctx.context.session) {
        const { user, session } = ctx.context.session;
        const others = (await ctx.context.internalAdapter.listSessions(user.id))
          .map((s) => s.token)
          .filter((t) => t !== session.token);
        if (others.length > 0) await ctx.context.internalAdapter.deleteSessions(others);
      }
    }),
  };
}
