import { eq, sql } from "drizzle-orm";
import type { KobeTx } from "./client.js";
import { siteSettings } from "./schema/index.js";

/**
 * The Site setting "Require single sign-on" (KOBE-774), a `site_settings` row: `"true"` while
 * password and passkey sign-in are off. Shared by the server (which enforces it) and the operator
 * CLI's break-glass command (`kobe sso allow-local-sign-in`), which turns it off with cluster
 * access when nobody can sign in through the web.
 */
export const REQUIRE_SSO_KEY = "require_sso";

/**
 * Serializes every change that could leave the setting on without an enabled provider: turning it
 * on, and disabling or deleting a provider. Transaction-scoped.
 */
export async function lockSsoRequired(tx: KobeTx): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('kobe.sso.required'))`);
}

/** The stored value (false when unset). */
export async function readSsoRequiredIn(tx: Pick<KobeTx, "select">): Promise<boolean> {
  const [row] = await tx
    .select({ value: siteSettings.value })
    .from(siteSettings)
    .where(eq(siteSettings.key, REQUIRE_SSO_KEY));
  return row?.value === "true";
}

/** Stores the value; the caller audits. */
export async function storeSsoRequired(tx: KobeTx, value: boolean): Promise<void> {
  await tx
    .insert(siteSettings)
    .values({ key: REQUIRE_SSO_KEY, value: String(value) })
    .onConflictDoUpdate({
      target: siteSettings.key,
      set: { value: String(value), updatedAt: new Date() },
    });
}
