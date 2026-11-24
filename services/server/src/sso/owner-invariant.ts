import { readSsoRequiredIn, sql, type KaijuDb, type KaijuTx } from "@kaiju/db";

/*
 * The "Require single sign-on" Owner invariant (KOBE-774), on its own so the routes that enforce it
 * (ownership transfer, deactivation, unlinking) need not import `required.ts`, which reads sessions
 * (turn-on ends local sessions and checks the caller's): catalog routes must not depend on the
 * session (kaiju-mcp/session-contract.test.ts). Nothing here touches a session.
 */

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

/**
 * Owners who could not sign in through single sign-on: deactivated, or without an identity at an
 * enabled provider (third review: a deactivated Owner fails the invariant too).
 */
export async function unlinkedOwners(tx: KaijuDb | KaijuTx): Promise<number> {
  const res = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM site_roles r JOIN users u ON u.id = r.user_id
     WHERE r.role = 'owner'
       AND (u.deactivated_at IS NOT NULL OR NOT EXISTS (
         SELECT 1 FROM sso_identities i JOIN sso_providers p ON p.id = i.provider_id
          WHERE i.user_id = u.id AND p.enabled))`);
  return Number(res.rows[0]?.n ?? 0);
}

/** Under the lock, after the change: throws {@link OwnerWouldLoseSignInError} if it broke the rule. */
export async function assertOwnerKeepsSignIn(tx: KaijuTx): Promise<void> {
  if (!(await readSsoRequiredIn(tx))) return;
  if ((await unlinkedOwners(tx)) > 0) throw new OwnerWouldLoseSignInError();
}
