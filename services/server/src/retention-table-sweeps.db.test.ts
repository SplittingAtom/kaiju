import { randomUUID } from "node:crypto";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTeam, sql } from "@kobe/db";
import { runWithAuditContext } from "./audit/context.js";
import { runRetentionPass } from "./retention/job.js";
import {
  DEFAULT_TABLE_SWEEPS,
  NO_TABLE_SWEEPS,
  sweepTable,
  sweepTables,
} from "./retention/table-sweeps.js";
import { createTeamWithAdmin } from "./teams/members.js";
import { openHarness, type Harness } from "./testing/harness.js";

/** KOBE-741: the retention pass's table sweeps against a real Postgres (RLS, triggers, holds). */
let h: Harness;
let teamA = "";
let teamB = "";
let owner = "";
let member = "";
let siteAdmin = "";
const logger = pino({ level: "silent" });

const daysAgo = (d: number) => `now() - interval '${d} days'`;
const monthsAgo = (m: number) => `now() - interval '${m} months'`;

async function event(
  team: string,
  ageSql: string,
  status = "processed",
  kind = "egress.blocked",
  schedule?: { id: string; dueAgeSql: string },
): Promise<string> {
  const ref = schedule ? { schedule_id: schedule.id } : {};
  const { rows } = await h.admin.query<{ id: string }>(
    `INSERT INTO events (team_id, kind, status, ref, created_at, schedule_id, due_at)
     VALUES ($1, $2, $3, $4, ${ageSql}, $5, ${schedule ? schedule.dueAgeSql : status === "scheduled" ? "now()" : "NULL"})
     RETURNING id`,
    [team, kind, status, JSON.stringify(ref), schedule?.id ?? null],
  );
  return rows[0]?.id ?? "";
}

async function notification(team: string, user: string, readSql: string | null): Promise<string> {
  const { rows } = await h.admin.query<{ id: string }>(
    `INSERT INTO notifications (team_id, user_id, kind, actor_user_id, created_at, read_at)
     VALUES ($1, $2, 'team.member.added', $3, now() - interval '400 days', ${readSql ?? "NULL"})
     RETURNING id`,
    [team, user, owner],
  );
  return rows[0]?.id ?? "";
}

async function usage(team: string, user: string, ageSql: string): Promise<string> {
  const { rows } = await h.admin.query<{ id: string }>(
    `INSERT INTO run_usage (team_id, user_id, sandbox_id, kind, route, model, status, usage_source,
       duration_ms, at)
     VALUES ($1, $2, $3, 'run', 'openai', 'p/m', 200, 'reported', 5, ${ageSql}) RETURNING id`,
    [team, user, randomUUID()],
  );
  return rows[0]?.id ?? "";
}

async function evalRow(
  team: string,
  agent: string,
  ageSql: string,
  opts: { status?: string; version?: number } = {},
): Promise<string> {
  const status = opts.status ?? "blocked";
  const { rows } = await h.admin.query<{ id: string }>(
    `INSERT INTO orbit_evals (team_id, agent_id, agent_scope, agent_slug, requested_by,
       draft_revision, definition, model, threshold, status, attack_success_rate, error,
       finished_at, created_at, version)
     VALUES ($1, $2, 'team', 's', $3, 1, '{}', 'm', 0.2, $4,
       ${status === "errored" ? "NULL" : "0.5"}, ${status === "errored" ? "'boom'" : "NULL"},
       ${status === "running" ? "NULL" : ageSql}, ${ageSql}, $5)
     RETURNING id`,
    [team, agent, member, status, opts.version ?? null],
  );
  return rows[0]?.id ?? "";
}

/** The Postgres error behind drizzle's "Failed query" wrapper. */
async function pgError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    const e = err as { message?: string; cause?: { message?: string } };
    return e.cause?.message ?? e.message ?? String(err);
  }
  return "no error";
}

async function ids(table: string, team: string): Promise<string[]> {
  const { rows } = await h.admin.query<{ id: string }>(
    `SELECT id FROM ${table} WHERE team_id = $1 ORDER BY id`,
    [team],
  );
  return rows.map((r) => r.id);
}

async function hold(team: string, userId: string | null): Promise<void> {
  const { rows } = await h.admin.query<{ id: string }>(
    `INSERT INTO legal_holds (team_id, user_id, reason, placed_by) VALUES ($1, $2, 'matter', $3)
     RETURNING id`,
    [team, userId, siteAdmin],
  );
  await h.admin.query(`UPDATE legal_holds SET status = 'active', approved_by = $2 WHERE id = $1`, [
    rows[0]?.id,
    owner,
  ]);
}

async function makeTeam(slug: string): Promise<string> {
  return (
    await runWithAuditContext(
      { actor: { kind: "user", id: owner }, ip: null, userAgent: null },
      () => createTeamWithAdmin(h.deps.database.db, { slug, name: slug }, owner),
    )
  ).id;
}

beforeAll(async () => {
  h = await openHarness();
  owner = await h.createUser("owner@sweeps.test", "owner");
  siteAdmin = await h.createUser("admin@sweeps.test", "admin");
  member = await h.createUser("member@sweeps.test");
  teamA = await makeTeam("sweeps-a");
  teamB = await makeTeam("sweeps-b");
  for (const team of [teamA, teamB]) {
    await h.admin.query(
      `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`,
      [team, member],
    );
  }
}, 120_000);

afterAll(() => h?.close());

beforeEach(async () => {
  await h.admin.query(`DELETE FROM legal_holds`);
  await h.admin.query(`DELETE FROM events`);
  await h.admin.query(`DELETE FROM notifications`);
  await h.admin.query(`DELETE FROM orbit_evals`);
  // run_usage is append-only; the owner connection may drop the test rows.
  await h.admin.query(`ALTER TABLE run_usage DISABLE TRIGGER run_usage_append_only`);
  await h.admin.query(`DELETE FROM run_usage`);
  await h.admin.query(`ALTER TABLE run_usage ENABLE TRIGGER run_usage_append_only`);
});

describe("events", () => {
  it("deletes old processed and failed events only, in the swept team only", async () => {
    const oldDone = await event(teamA, daysAgo(40));
    const oldFailed = await event(teamA, daysAgo(40), "failed");
    const oldPending = await event(teamA, daysAgo(40), "pending");
    const oldScheduled = await event(teamA, daysAgo(40), "scheduled", "reminder.due");
    const recent = await event(teamA, daysAgo(5));
    const otherTeam = await event(teamB, daysAgo(40));

    const counts = await sweepTables(h.deps.database.db, teamA, DEFAULT_TABLE_SWEEPS);

    expect(counts.events).toBe(2);
    const left = await ids("events", teamA);
    expect(left).not.toContain(oldDone);
    expect(left).not.toContain(oldFailed);
    expect(left).toEqual(expect.arrayContaining([oldPending, oldScheduled, recent]));
    expect(await ids("events", teamB)).toEqual([otherTeam]);
  });

  it("keeps each schedule's latest fire or skip (the scheduler's dedupe reads it)", async () => {
    const schedule = randomUUID();
    const s = (age: number) => ({ id: schedule, dueAgeSql: daysAgo(age) });
    const older = await event(teamA, daysAgo(90), "processed", "schedule.fire", s(90));
    const olderSkip = await event(teamA, daysAgo(80), "processed", "schedule.skip", s(80));
    const latest = await event(teamA, daysAgo(60), "processed", "schedule.skip", s(60));
    const lone = randomUUID();
    const loneLatest = await event(teamA, daysAgo(200), "processed", "schedule.fire", {
      id: lone,
      dueAgeSql: daysAgo(200),
    });

    await sweepTables(h.deps.database.db, teamA, DEFAULT_TABLE_SWEEPS);

    const left = await ids("events", teamA);
    expect(left).not.toContain(older);
    expect(left).not.toContain(olderSkip);
    expect(left).toEqual(expect.arrayContaining([latest, loneLatest]));
  });

  it("keeps every event while any hold is active in the team (events name no member)", async () => {
    const old = await event(teamA, daysAgo(40));
    await hold(teamA, member);
    await sweepTables(h.deps.database.db, teamA, DEFAULT_TABLE_SWEEPS);
    expect(await ids("events", teamA)).toEqual([old]);
  });
});

describe("notifications", () => {
  it("deletes notifications read longer ago than the period; unread ones stay", async () => {
    const readLongAgo = await notification(teamA, member, daysAgo(200));
    const readRecently = await notification(teamA, member, daysAgo(10));
    const unread = await notification(teamA, member, null);
    const otherTeam = await notification(teamB, member, daysAgo(200));

    const counts = await sweepTables(h.deps.database.db, teamA, DEFAULT_TABLE_SWEEPS);

    expect(counts.notifications).toBe(1);
    const left = await ids("notifications", teamA);
    expect(left).not.toContain(readLongAgo);
    expect(left).toEqual(expect.arrayContaining([readRecently, unread]));
    expect(await ids("notifications", teamB)).toEqual([otherTeam]);
  });

  it("keeps a held member's notifications and sweeps everyone else's", async () => {
    const held = await notification(teamA, member, daysAgo(200));
    const free = await notification(teamA, owner, daysAgo(200));
    await hold(teamA, member);
    await sweepTables(h.deps.database.db, teamA, DEFAULT_TABLE_SWEEPS);
    const left = await ids("notifications", teamA);
    expect(left).toContain(held);
    expect(left).not.toContain(free);
  });
});

describe("run_usage", () => {
  it("deletes usage rows older than the period and keeps the rest", async () => {
    const old = await usage(teamA, member, monthsAgo(14));
    const kept = await usage(teamA, member, monthsAgo(12));
    const otherTeam = await usage(teamB, member, monthsAgo(14));

    const counts = await sweepTables(h.deps.database.db, teamA, DEFAULT_TABLE_SWEEPS);

    expect(counts.run_usage).toBe(1);
    expect(await ids("run_usage", teamA)).toEqual([kept]);
    expect(await ids("run_usage", teamA)).not.toContain(old);
    expect(await ids("run_usage", teamB)).toEqual([otherTeam]);
  });

  it("stays append-only for the app role outside the sweep, and for young rows within it", async () => {
    const old = await usage(teamA, member, monthsAgo(14));
    const young = await usage(teamA, member, daysAgo(30));
    const db = h.deps.database.db;
    expect(
      await pgError(
        withTeam(db, teamA, (tx) => tx.execute(sql`DELETE FROM run_usage WHERE id = ${old}`)),
      ),
    ).toMatch(/append-only/);
    expect(
      await pgError(
        withTeam(db, teamA, async (tx) => {
          await tx.execute(sql`SELECT set_config('kobe.run_usage_retention', 'on', true)`);
          await tx.execute(sql`DELETE FROM run_usage WHERE id = ${young}`);
        }),
      ),
    ).toMatch(/append-only/);
    expect(
      await pgError(
        withTeam(db, teamA, async (tx) => {
          await tx.execute(sql`SELECT set_config('kobe.run_usage_retention', 'on', true)`);
          await tx.execute(sql`UPDATE run_usage SET status = 500`);
        }),
      ),
    ).toMatch(/append-only/);
    expect(await ids("run_usage", teamA)).toEqual([old, young].sort());
  });

  it("keeps a held member's usage", async () => {
    const held = await usage(teamA, member, monthsAgo(14));
    await hold(teamA, member);
    await sweepTables(h.deps.database.db, teamA, DEFAULT_TABLE_SWEEPS);
    expect(await ids("run_usage", teamA)).toEqual([held]);
  });
});

describe("orbit_evals", () => {
  it("deletes old finished evals but an agent's latest and those that published a version", async () => {
    const agent = randomUUID();
    const oldBlocked = await evalRow(teamA, agent, monthsAgo(20));
    const oldErrored = await evalRow(teamA, agent, monthsAgo(19), { status: "errored" });
    const published = await evalRow(teamA, agent, monthsAgo(18), { status: "passed", version: 3 });
    const latest = await evalRow(teamA, agent, monthsAgo(15));
    const otherAgentLatest = await evalRow(teamA, randomUUID(), monthsAgo(30));
    const otherTeam = await evalRow(teamB, agent, monthsAgo(20));

    const counts = await sweepTables(h.deps.database.db, teamA, DEFAULT_TABLE_SWEEPS);

    expect(counts.orbit_evals).toBe(2);
    const left = await ids("orbit_evals", teamA);
    expect(left).not.toContain(oldBlocked);
    expect(left).not.toContain(oldErrored);
    expect(left).toEqual(expect.arrayContaining([published, latest, otherAgentLatest]));
    expect(await ids("orbit_evals", teamB)).toEqual([otherTeam]);
  });
});

describe("batches, switches and the pass", () => {
  it("deletes in bounded batches, capped per pass, audited per batch with counts only", async () => {
    for (let i = 0; i < 5; i++) await event(teamA, daysAgo(40 + i));
    const db = h.deps.database.db;
    const first = await sweepTable(db, teamA, "events", DEFAULT_TABLE_SWEEPS, {
      batch: 2,
      maxBatches: 2,
    });
    expect(first).toBe(4);
    expect(await ids("events", teamA)).toHaveLength(1);
    const audits = await h.admin.query<{ target: { table: string; rows: number } }>(
      `SELECT target FROM audit_log WHERE action = 'retention.table_swept' AND team_id = $1
        ORDER BY seq DESC LIMIT 2`,
      [teamA],
    );
    expect(audits.rows.map((r) => r.target)).toEqual([
      { table: "events", rows: 2 },
      { table: "events", rows: 2 },
    ]);
    // The next pass goes on where this one stopped.
    expect(await sweepTable(db, teamA, "events", DEFAULT_TABLE_SWEEPS, { batch: 2 })).toBe(1);
  });

  it("does nothing for a sweep switched off, or for a pass without sweep settings", async () => {
    const old = await event(teamA, daysAgo(400));
    const read = await notification(teamA, member, daysAgo(400));
    const db = h.deps.database.db;
    await sweepTables(db, teamA, { ...DEFAULT_TABLE_SWEEPS, eventsDays: null });
    expect(await ids("events", teamA)).toEqual([old]);
    expect(await ids("notifications", teamA)).toEqual([]);
    await notification(teamA, member, daysAgo(400));
    await sweepTables(db, teamA, NO_TABLE_SWEEPS);
    await runRetentionPass({ db, logger });
    expect(await ids("events", teamA)).toEqual([old]);
    expect(await ids("notifications", teamA)).toHaveLength(1);
    expect(read).toBeTruthy();
  });

  it("runs for every team from the nightly pass when configured", async () => {
    const a = await event(teamA, daysAgo(40));
    const b = await event(teamB, daysAgo(40));
    const result = await runRetentionPass({
      db: h.deps.database.db,
      logger,
      tableSweeps: DEFAULT_TABLE_SWEEPS,
    });
    expect(result.teams.every((t) => !t.failed)).toBe(true);
    const swept = result.teams.filter((t) => t.tables.events > 0).map((t) => t.teamId);
    expect(swept).toEqual(expect.arrayContaining([teamA, teamB]));
    expect(await ids("events", teamA)).not.toContain(a);
    expect(await ids("events", teamB)).not.toContain(b);
  });
});
