import {
  and,
  eq,
  inArray,
  sessions,
  sessionSsoContexts,
  siteRoles,
  users,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";

/**
 * Deletes the sessions signed in through `providerId` (§9): every one when the provider is turned
 * off, deleted or its rule moves; only `userId`'s when that person is unlinked or SCIM refuses to
 * deactivate them. Local sessions are never touched. Returns how many ended.
 */
export async function endSsoSessions(
  db: KobeDb | KobeTx,
  scope: { readonly providerId: string; readonly userId?: string },
): Promise<number> {
  const ofProvider = eq(sessionSsoContexts.providerId, scope.providerId);
  const ids = db
    .select({ id: sessionSsoContexts.sessionId })
    .from(sessionSsoContexts)
    .innerJoin(sessions, eq(sessions.id, sessionSsoContexts.sessionId))
    .where(
      scope.userId === undefined ? ofProvider : and(ofProvider, eq(sessions.userId, scope.userId)),
    );
  const gone = await db
    .delete(sessions)
    .where(inArray(sessions.id, ids))
    .returning({ id: sessions.id });
  return gone.length;
}

/**
 * The Owner, a site Admin, or the Owner the setup flow created (even after a transfer; the durable
 * `users.setup_owner` flag, no audit row needed). Identity-provider data never changes them: SCIM
 * never changes whether they are active (SSO8, SSO10), and they are never the target of an
 * expected link (review M3), since that would hand the account to whoever controls the IdP account.
 */
export async function isProtectedUser(db: KobeDb | KobeTx, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ role: siteRoles.role, setupOwner: users.setupOwner })
    .from(users)
    .leftJoin(siteRoles, eq(siteRoles.userId, users.id))
    .where(eq(users.id, userId));
  return row !== undefined && (row.setupOwner || row.role !== null);
}
