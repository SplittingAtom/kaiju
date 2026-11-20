import { setTimeout as sleep } from "node:timers/promises";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  APP_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  APP_STATEMENT_TIMEOUT_MS,
  createDb,
  type KobeDatabase,
} from "./client.js";
import { createTestDatabase, testServerUrl, type TestDatabase } from "./test-support/database.js";

// KOBE-732 (review STO-2): every app-role connection carries a statement timeout and an
// idle-in-transaction timeout, so a client stuck on a network call inside a transaction is cut
// by Postgres instead of pinning its locks and its pool connection.

let db: TestDatabase | undefined;
const database = (): TestDatabase => {
  if (!db) throw new Error("database not created");
  return db;
};
const opened: KobeDatabase[] = [];
const open = (options: Parameters<typeof createDb>[1] = {}): KobeDatabase => {
  const d = createDb(database().appUrl, { max: 2, ...options });
  opened.push(d);
  return d;
};

beforeAll(async () => {
  db = await createTestDatabase(testServerUrl());
}, 120_000);

afterAll(async () => {
  for (const d of opened) await d.close();
  await db?.drop();
});

const setting = async (d: KobeDatabase, name: string): Promise<string> => {
  const { rows } = await d.pool.query<{ v: string }>(`SELECT current_setting($1) AS v`, [name]);
  return rows[0]?.v ?? "";
};

describe("app-role connection timeouts (KOBE-732)", () => {
  it("sets the defaults on every connection", async () => {
    const d = open();
    expect(APP_STATEMENT_TIMEOUT_MS).toBe(120_000);
    expect(APP_IDLE_IN_TRANSACTION_TIMEOUT_MS).toBe(300_000);
    expect(await setting(d, "statement_timeout")).toBe("2min");
    expect(await setting(d, "idle_in_transaction_session_timeout")).toBe("5min");
  });

  it("cuts a statement that runs past the statement timeout", async () => {
    const d = open({ statementTimeoutMs: 200 });
    await expect(d.pool.query("SELECT pg_sleep(2)")).rejects.toMatchObject({ code: "57014" });
    // SET LOCAL still overrides it for a job that needs longer.
    await d.db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = '5s'`));
      await tx.execute(sql`SELECT pg_sleep(0.4)`);
    });
  });

  it("ends a transaction left idle past the timeout, without crashing the process", async () => {
    const d = open({ idleInTransactionTimeoutMs: 300 });
    const run = d.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1`);
      await sleep(1_500);
      await tx.execute(sql`SELECT 1`);
    });
    await expect(run).rejects.toThrow();
    // The pool drops the dead connection and serves the next caller.
    const { rows } = await d.pool.query<{ one: number }>("SELECT 1 AS one");
    expect(rows[0]?.one).toBe(1);
  });

  it("can be switched off (0) for a caller that holds transactions open on purpose", async () => {
    const d = open({ statementTimeoutMs: 0, idleInTransactionTimeoutMs: 0 });
    expect(await setting(d, "statement_timeout")).toBe("0");
    expect(await setting(d, "idle_in_transaction_session_timeout")).toBe("0");
  });
});
