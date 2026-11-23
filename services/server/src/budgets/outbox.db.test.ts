import { randomUUID } from "node:crypto";
import pg from "pg";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type KobeDatabase } from "@kobe/db";
import { createTestDatabase, testServerUrl, type TestDatabase } from "@kobe/db/testing";
import { runWithAuditContext } from "../audit/context.js";
import { MemoryMailer } from "../testing/mailer.js";
import {
  BUDGET_EMAILS_PER_RECIPIENT_PER_DAY,
  deliverBudgetEmails,
  reserveBudgetEmailSlot,
  sweepBudgetEmailCounts,
} from "./outbox.js";
import { setTeamBudget } from "./store.js";

/**
 * KOBE-786 against a real Postgres: the team pass claims its own emails even behind a backlog of
 * Site emails (P2-34a), the daily cap is per person across the Site and every Workspace and holds
 * across replicas (P2-34b, owner decision 2026-11-22), and two first saves of a team budget at once
 * do not fail (P2-33).
 */
const CAP = BUDGET_EMAILS_PER_RECIPIENT_PER_DAY;
const silent = pino({ level: "silent" });
let database: TestDatabase;
let replicas: KobeDatabase[];
let admin: pg.Client;

beforeAll(async () => {
  database = await createTestDatabase(testServerUrl());
  replicas = [createDb(database.appUrl), createDb(database.appUrl)];
  admin = new pg.Client({ connectionString: database.adminUrl });
  await admin.connect();
});
afterAll(async () => {
  for (const r of replicas ?? []) await r.close();
  await admin?.end();
  await database?.drop();
});

const db = () => (replicas[0] as KobeDatabase).db;

async function user(label: string): Promise<{ id: string; email: string }> {
  const email = `${label}-${randomUUID().slice(0, 8)}@budget-mail.test`;
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id`,
    [label, email],
  );
  return { id: rows[0]?.id ?? "", email };
}

async function team(): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO teams (slug, name) VALUES ($1, 'Budget mail') RETURNING id`,
    [`bm-${randomUUID().slice(0, 8)}`],
  );
  return rows[0]?.id ?? "";
}

/**
 * `count` due 100 % alerts (distinct subjects, so none supersedes another) in `teamId`'s context
 * (null: the Site), each with one email to `recipient`. The guard triggers are bypassed: the
 * alerts' own verification has its tests (budgets.db.test.ts).
 */
let subjects = 0;

async function queue(
  teamId: string | null,
  recipients: readonly string[],
  count: number,
  createdAt = "now()",
): Promise<void> {
  await admin.query("SET session_replication_role = replica");
  try {
    for (const recipient of recipients) {
      await admin.query(
        `WITH a AS (
           INSERT INTO budget_alerts (team_id, user_id, scope, period, period_start, threshold, unit,
                                      limit_amount, spent_amount, created_at)
           SELECT $1::uuid, CASE WHEN $1::uuid IS NULL THEN NULL ELSE gen_random_uuid() END,
                  CASE WHEN $1::uuid IS NULL THEN 'site' ELSE 'user' END, 'day',
                  DATE '2000-01-01' + $4::int + g, 100, 'usd', 10, 10, ${createdAt}
             FROM generate_series(1, $3::int) g
           RETURNING id, created_at)
         INSERT INTO budget_alert_emails (alert_id, recipient_id, created_at)
         SELECT id, $2::uuid, created_at FROM a`,
        [teamId, recipient, count, subjects],
      );
      subjects += count;
    }
  } finally {
    await admin.query("SET session_replication_role = DEFAULT");
  }
}

async function statuses(recipient: string): Promise<Record<string, number>> {
  const { rows } = await admin.query<{ status: string; last_error: string | null; n: string }>(
    `SELECT status, last_error, count(*) AS n FROM budget_alert_emails
      WHERE recipient_id = $1 GROUP BY status, last_error`,
    [recipient],
  );
  return Object.fromEntries(
    rows.map((r) => [r.last_error ? `${r.status}:${r.last_error}` : r.status, Number(r.n)]),
  );
}

const deliver = (replica: KobeDatabase, mailer: MemoryMailer) =>
  deliverBudgetEmails({ db: replica.db, mailer, publicUrl: "http://kobe.test", logger: silent });

describe("budget email outbox (KOBE-786)", () => {
  it("a team's emails are claimed in its own pass even behind more than two batches of Site emails", async () => {
    const siteAdmins = await Promise.all(Array.from({ length: 110 }, (_, i) => user(`site${i}`)));
    await queue(
      null,
      siteAdmins.map((u) => u.id),
      1,
      "now() - interval '1 hour'",
    );
    const teamAdmin = await user("team-admin");
    await queue(await team(), [teamAdmin.id], 1);
    const mailer = new MemoryMailer();
    await deliver(replicas[0] as KobeDatabase, mailer);
    expect(mailer.to(teamAdmin.email)).toHaveLength(1);
  });

  it("an admin of three Workspaces and the Site gets at most the cap a day in total, across two replicas", async () => {
    const both = await user("both");
    const other = await user("other");
    const teams = [await team(), await team(), await team()];
    for (const t of teams) await queue(t, [both.id], 10);
    await queue(null, [both.id], 5);
    await queue(teams[0] as string, [other.id], 3);
    const mailers = [new MemoryMailer(), new MemoryMailer()];
    await Promise.all(replicas.map((r, i) => deliver(r, mailers[i] as MemoryMailer)));
    const sent = mailers.flatMap((m) => m.to(both.email));
    expect(sent).toHaveLength(CAP);
    expect(await statuses(both.id)).toEqual({ sent: CAP, "skipped:daily_limit": 35 - CAP });
    // Someone else's cap is their own.
    expect(mailers.flatMap((m) => m.to(other.email))).toHaveLength(3);
    const { rows } = await admin.query<{ sent: number }>(
      `SELECT sent FROM budget_email_daily_counts WHERE recipient_id = $1`,
      [both.id],
    );
    expect(rows).toEqual([{ sent: CAP }]);
  });

  it("a failed send gives its slot back", async () => {
    const who = await user("flaky");
    await queue(await team(), [who.id], 1);
    const mailer = new MemoryMailer();
    mailer.failNext = new Error("smtp down");
    await deliver(replicas[0] as KobeDatabase, mailer);
    const { rows } = await admin.query<{ sent: number }>(
      `SELECT sent FROM budget_email_daily_counts WHERE recipient_id = $1`,
      [who.id],
    );
    expect(rows.map((r) => r.sent)).toEqual([0]);
  });

  it("concurrent reservations never pass the cap", async () => {
    const who = await user("busy");
    const tries = Array.from({ length: CAP + 15 }, (_, i) =>
      reserveBudgetEmailSlot((replicas[i % 2] as KobeDatabase).db, who.id),
    );
    const days = await Promise.all(tries);
    expect(days.filter((d) => d !== null)).toHaveLength(CAP);
  });

  it("counts per UTC day, whatever the session's time zone, and the retention sweep drops old days", async () => {
    const who = await user("rollover");
    const url = new URL(database.appUrl);
    url.searchParams.set("options", "-c TimeZone=Pacific/Kiritimati");
    const far = createDb(url.toString());
    try {
      const { rows } = await admin.query<{ today: string; yesterday: string }>(
        `SELECT (now() AT TIME ZONE 'UTC')::date::text AS today,
                ((now() AT TIME ZONE 'UTC')::date - 1)::text AS yesterday`,
      );
      const { today, yesterday } = rows[0] as { today: string; yesterday: string };
      await admin.query(
        `INSERT INTO budget_email_daily_counts (recipient_id, day, sent)
         VALUES ($1, $2::date, $3), ($1, $2::date - 5, $3)`,
        [who.id, yesterday, CAP],
      );
      // Yesterday's full count does not hold today's emails back.
      expect(await reserveBudgetEmailSlot(far.db, who.id)).toBe(today);
      await admin.query(
        `UPDATE budget_email_daily_counts SET sent = $3 WHERE recipient_id = $1 AND day = $2::date`,
        [who.id, today, CAP],
      );
      expect(await reserveBudgetEmailSlot(far.db, who.id)).toBeNull();
      expect(await sweepBudgetEmailCounts(db())).toBeGreaterThanOrEqual(1);
      const left = await admin.query<{ day: string }>(
        `SELECT day::text AS day FROM budget_email_daily_counts WHERE recipient_id = $1 ORDER BY day`,
        [who.id],
      );
      expect(left.rows.map((r) => r.day)).toEqual([yesterday, today]);
    } finally {
      await far.close();
    }
  });
});

describe("team budget first save (KOBE-786, P2-33)", () => {
  /** Waits until a session of the app role waits on a lock (the second insert, here). */
  async function someoneWaits(): Promise<void> {
    await expect
      .poll(async () => {
        const { rows } = await admin.query<{ n: string }>(
          `SELECT count(*) AS n FROM pg_stat_activity
            WHERE usename = $1 AND wait_event_type = 'Lock'`,
          [database.appRole],
        );
        return Number(rows[0]?.n);
      })
      .toBeGreaterThan(0);
  }

  /** A first team budget saved by someone else, committed while `save` waits on it. */
  async function racedFirstSave<T>(teamId: string, actor: string, save: () => Promise<T>) {
    const other = new pg.Client({ connectionString: database.adminUrl });
    await other.connect();
    try {
      await other.query("BEGIN");
      await other.query(
        `INSERT INTO team_budgets (team_id, monthly_usd, updated_by) VALUES ($1, 50, $2)`,
        [teamId, actor],
      );
      const pending = runWithAuditContext(
        { actor: { kind: "user", id: actor }, ip: null, userAgent: null },
        save,
      );
      await someoneWaits();
      await other.query("COMMIT");
      return await pending;
    } finally {
      await other.end();
    }
  }

  it("a plain save applies on top of a first save made meanwhile", async () => {
    const actor = await user("budget-admin");
    const t = await team();
    const result = await racedFirstSave(t, actor.id, () =>
      setTeamBudget(db(), t, { daily_usd: 5 }, actor.id),
    );
    expect(result).toBe("ok");
    const { rows } = await admin.query<{ monthly_usd: string; daily_usd: string }>(
      `SELECT monthly_usd, daily_usd FROM team_budgets WHERE team_id = $1 AND user_id IS NULL`,
      [t],
    );
    expect(rows.map((r) => [Number(r.monthly_usd), Number(r.daily_usd)])).toEqual([[50, 5]]);
  });

  it("an approved save of 'no budget yet' answers changed_since_approval", async () => {
    const actor = await user("budget-admin");
    const t = await team();
    const none = {
      monthly_usd: null,
      daily_usd: null,
      monthly_tokens: null,
      daily_tokens: null,
      user_requests_per_minute: null,
    };
    const result = await racedFirstSave(t, actor.id, () =>
      setTeamBudget(db(), t, { daily_usd: 5 }, actor.id, none),
    );
    expect(result).toBe("changed_since_approval");
  });
});
