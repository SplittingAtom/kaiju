import { createDb, verifyAuditChain } from "@kaiju/db";
import { createTestDatabase, testServerUrl, type TestDatabase } from "@kaiju/db/testing";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allowLocalSignIn } from "./sso-break-glass.js";

/**
 * `kaiju sso allow-local-sign-in` (KOBE-774): the Site owner's break-glass when "Require single
 * sign-on" locks everyone out (the identity provider is down or misconfigured). Needs the owner
 * role's URL, i.e. cluster access, never the web UI. Turns the setting off and records
 * `identity.sso.required.disabled` (`break_glass`, the operator) in the audit chain.
 */
let db: TestDatabase | undefined;
const url = (): string => {
  if (!db) throw new Error("no database");
  return db.adminUrl;
};

async function query<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: url() });
  await c.connect();
  try {
    return (await c.query<T>(sql, params)).rows;
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  db = await createTestDatabase(testServerUrl());
});
afterAll(async () => {
  await db?.drop();
});

describe("allowLocalSignIn", () => {
  it("turns the setting off and audits it with the operator", async () => {
    await query(
      `INSERT INTO site_settings (key, value) VALUES ('require_sso', 'true')
       ON CONFLICT (key) DO UPDATE SET value = 'true'`,
    );
    expect(await allowLocalSignIn(url(), "ops@corp")).toEqual({ changed: true });
    expect(await query(`SELECT value FROM site_settings WHERE key = 'require_sso'`)).toEqual([
      { value: "false" },
    ]);
    const audit = await query<{ action: string; actor_kind: string; target: unknown }>(
      `SELECT action, actor_kind, target FROM audit_log
        WHERE action LIKE 'identity.sso.required.%' ORDER BY seq`,
    );
    expect(audit).toEqual([
      {
        action: "identity.sso.required.disabled",
        actor_kind: "system",
        target: { reason: "break_glass", operator: "ops@corp" },
      },
    ]);
    const check = createDb(url(), { max: 1 });
    try {
      expect(await verifyAuditChain(check.db)).toMatchObject({ ok: true });
    } finally {
      await check.close();
    }
  });

  it("changes nothing and records nothing when it is already off", async () => {
    const before = await query(`SELECT count(*)::int AS n FROM audit_log`);
    expect(await allowLocalSignIn(url(), "ops@corp")).toEqual({ changed: false });
    expect(await query(`SELECT count(*)::int AS n FROM audit_log`)).toEqual(before);
  });
});
