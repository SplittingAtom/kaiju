import {
  SYSTEM_ACTOR,
  audit,
  createDb,
  lockSsoRequired,
  readSsoRequiredIn,
  storeSsoRequired,
} from "@kaiju/db";

/**
 * `kaiju sso allow-local-sign-in` (KOBE-774): the Site owner's break-glass for "Require single
 * sign-on". When the identity provider is down or misconfigured nobody can sign in through the
 * web, so this turns the setting off from outside it: it needs the owner role's database URL
 * (`KAIJU_DB_MIGRATE_URL`), i.e. cluster access. One transaction: the setting goes off and
 * `identity.sso.required.disabled` (`reason: break_glass`, the operator) joins the audit chain.
 * Password and passkey sign-in work again at once; nothing else changes.
 */
export async function allowLocalSignIn(
  databaseUrl: string,
  operator: string,
): Promise<{ readonly changed: boolean }> {
  const database = createDb(databaseUrl, { max: 1, applicationName: "kaiju-cli" });
  try {
    return await database.db.transaction(async (tx) => {
      await lockSsoRequired(tx);
      if (!(await readSsoRequiredIn(tx))) return { changed: false };
      await storeSsoRequired(tx, false);
      await audit(tx, {
        action: "identity.sso.required.disabled",
        actor: SYSTEM_ACTOR,
        target: { reason: "break_glass", operator },
      });
      return { changed: true };
    });
  } finally {
    await database.close();
  }
}
