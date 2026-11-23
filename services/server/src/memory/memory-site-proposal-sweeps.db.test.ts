import { randomUUID } from "node:crypto";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sweepMemoryReminders } from "../notifications/memory.js";
import { runRetentionPass } from "../retention/index.js";
import { openHarness, type Harness } from "../testing/harness.js";

/**
 * KOBE-653 (v1.3 SMC6; SM22, SM28): Site proposal sweeps. Open proposals past 30 days expire
 * (the proposer and the confirming Team admin told once); the current step's deciders get one
 * reminder 7 days after the step started (KOBE-666: one per step, never repeated), settled when it
 * ends; Site curators outside the proposing
 * Workspace hear in their own Workspace (relay). A Site-wide legal hold freezes it all; a hold on
 * the proposer keeps their proposals open.
 */
let h: Harness;
const log = pino({ level: "silent" });
const teamA = randomUUID();
const teamB = randomUUID();
const teamC = randomUUID();
const ids = { owner: "", admin: "", proposer: "", siteMember: "", siteAdmin: "", steward: "" };
let auditFloor = 0;

const db = () => h.deps.database.db;
const pass = () => runRetentionPass({ db: db(), logger: log });

beforeAll(async () => {
  h = await openHarness();
  ids.owner = await h.createUser("owner@sps.test", "owner");
  ids.admin = await h.createUser("admin@sps.test");
  ids.proposer = await h.createUser("proposer@sps.test");
  // A Site admin who is a member of the proposing Workspace (KOBE-403 tells them there).
  ids.siteMember = await h.createUser("site-member@sps.test", "admin");
  // A Site admin who belongs to B and C only (relayed to the one they last used: C).
  ids.siteAdmin = await h.createUser("site-admin@sps.test", "admin");
  ids.steward = await h.createUser("steward@sps.test");
  await h.admin.query(
    `INSERT INTO site_grants (user_id, "grant", granted_by) VALUES ($1, 'memory_steward', $2)`,
    [ids.steward, ids.owner],
  );
  await h.admin.query(
    `INSERT INTO teams (id, slug, name) VALUES ($1, 'sps-a', 'A'), ($2, 'sps-b', 'B'),
       ($3, 'sps-c', 'C')`,
    [teamA, teamB, teamC],
  );
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES
       ($1, $4, 'team_admin'), ($1, $5, 'member'), ($1, $6, 'member'),
       ($2, $7, 'member'), ($3, $7, 'member')`,
    [teamA, teamB, teamC, ids.admin, ids.proposer, ids.siteMember, ids.siteAdmin],
  );
  await h.admin.query(`INSERT INTO user_last_teams (user_id, team_id) VALUES ($1, $2)`, [
    ids.siteAdmin,
    teamC,
  ]);
});

afterAll(async () => {
  await h?.close();
});

beforeEach(async () => {
  await clearHolds();
  await h.admin.query(`DELETE FROM site_memory_proposals`);
  await h.admin.query(`DELETE FROM memory_reminders`);
  await h.admin.query(`DELETE FROM notifications`);
  const { rows } = await h.admin.query<{ seq: string }>(
    `SELECT coalesce(max(seq), 0) AS seq FROM audit_log`,
  );
  auditFloor = Number(rows[0]?.seq ?? 0);
});

type State = "awaiting_team" | "awaiting_site" | "changes_requested";

/** A proposal from A, created `age` days ago (expires 30 days after creation). */
async function proposal(state: State, age = 0, rounds = 0): Promise<string> {
  const confirmed = state === "awaiting_team" && rounds === 0 ? null : ids.admin;
  const decided = state === "changes_requested" ? ids.siteAdmin : null;
  const { rows } = await h.admin.query<{ id: string }>(
    `INSERT INTO site_memory_proposals (from_team_id, statement, kind, justification, state,
       rounds, proposer_id, team_confirmed_by, team_confirmed_at, decided_by, decided_at,
       created_at, expires_at)
     VALUES ($1, 'Invoices go out on the 3rd.', 'fact', 'Finance said so.', $2, $3, $4, $5,
       CASE WHEN $5::uuid IS NULL THEN NULL ELSE now() - make_interval(days => $7) END,
       $6, CASE WHEN $6::uuid IS NULL THEN NULL ELSE now() END,
       now() - make_interval(days => $7), now() - make_interval(days => $7) + interval '30 days')
     RETURNING id`,
    [teamA, state, rounds, ids.proposer, confirmed, decided, age],
  );
  return rows[0]?.id ?? "";
}

/** A KOBE-403 reminder in A (as `noticeAwaitingTeam` / `noticeConfirmed` register them). */
async function reminder(objectId: string, userId: string, kind: string, sentDaysAgo?: number) {
  await h.admin.query(
    `INSERT INTO memory_reminders (team_id, object_id, related_kind, user_id, due_at, sent_at)
     VALUES ($1, $2, $3, $4, now() + interval '7 days',
             CASE WHEN $5::int IS NULL THEN NULL ELSE now() - make_interval(days => $5) END)`,
    [teamA, objectId, kind, userId, sentDaysAgo ?? null],
  );
}

const stateOf = async (id: string) =>
  (
    await h.admin.query<{ state: string }>(
      `SELECT state FROM site_memory_proposals WHERE id = $1`,
      [id],
    )
  ).rows[0]?.state;
const notices = async (userId: string, objectId: string) =>
  (
    await h.admin.query<{ team_id: string; kind: string; related_kind: string | null }>(
      `SELECT team_id, kind, related_kind FROM notifications
        WHERE user_id = $1 AND memory_object_id = $2 ORDER BY created_at, id`,
      [userId, objectId],
    )
  ).rows;
const remindersOf = async (objectId: string) =>
  (
    await h.admin.query<{ team_id: string; user_id: string; sent: boolean }>(
      `SELECT team_id, user_id, sent_at IS NOT NULL AS sent FROM memory_reminders
        WHERE object_id = $1 ORDER BY user_id`,
      [objectId],
    )
  ).rows;
const makeDue = (objectId: string) =>
  h.admin.query(
    `UPDATE memory_reminders SET due_at = now() - interval '1 second' WHERE object_id = $1`,
    [objectId],
  );
async function audits(proposalId: string) {
  const { rows } = await h.admin.query<{ target: Record<string, unknown>; actor_kind: string }>(
    `SELECT target, actor_kind FROM audit_log
      WHERE action = 'memory.site_proposal.decided' AND target ->> 'proposalId' = $1 AND seq > $2`,
    [proposalId, auditFloor],
  );
  return rows;
}

async function placeHold(table: "legal_holds" | "site_legal_holds", userId?: string) {
  const { rows } =
    table === "legal_holds"
      ? await h.admin.query<{ id: string }>(
          `INSERT INTO legal_holds (team_id, user_id, reason, placed_by)
           VALUES ($1, $2, 'matter 653', $3) RETURNING id`,
          [teamA, userId ?? null, ids.siteMember],
        )
      : await h.admin.query<{ id: string }>(
          `INSERT INTO site_legal_holds (reason, placed_by) VALUES ('Site matter 653', $1)
           RETURNING id`,
          [ids.siteAdmin],
        );
  await h.admin.query(`UPDATE ${table} SET status = 'active', approved_by = $2 WHERE id = $1`, [
    rows[0]?.id,
    ids.owner,
  ]);
}

async function clearHolds(): Promise<void> {
  for (const table of ["legal_holds", "site_legal_holds"]) {
    const { rows } = await h.admin.query<{ id: string }>(
      `SELECT id FROM ${table} WHERE status = 'active'`,
    );
    for (const { id } of rows) {
      await h.admin.query(
        `UPDATE ${table} SET release_requested_by = $2, release_requested_at = now(),
           release_reason = 'matter closed' WHERE id = $1`,
        [id, ids.siteMember],
      );
      await h.admin.query(
        `UPDATE ${table} SET status = 'released', released_by = $2 WHERE id = $1`,
        [id, ids.owner],
      );
    }
  }
}

describe("expiry (ac-1, ac-3)", () => {
  it.each<[State, number]>([
    ["awaiting_team", 0],
    ["awaiting_site", 0],
    ["awaiting_team", 2],
    ["changes_requested", 1],
  ])(
    "expires %s (rounds %d) after 30 days and tells proposer and confirmer once",
    async (state, rounds) => {
      const due = await proposal(state, 31, rounds);
      const fresh = await proposal(state, 29, rounds);
      await reminder(due, ids.admin, "memory.site_proposal.received");
      await pass();
      expect(await stateOf(due)).toBe("expired");
      expect(await stateOf(fresh)).toBe(state);
      expect(await remindersOf(due)).toEqual([]);
      const confirmed = state !== "awaiting_team" || rounds > 0;
      expect((await notices(ids.proposer, due)).map((n) => n.kind)).toEqual([
        "memory.site_proposal.expired",
      ]);
      expect((await notices(ids.admin, due)).map((n) => n.kind)).toEqual(
        confirmed ? ["memory.site_proposal.expired"] : [],
      );
      expect(await notices(ids.proposer, fresh)).toEqual([]);
      expect(await audits(due)).toMatchObject([
        { target: { outcome: "expired", round: rounds, itemId: null }, actor_kind: "system" },
      ]);
      // Once: a second pass changes nothing and tells nobody again.
      await pass();
      expect(await notices(ids.proposer, due)).toHaveLength(1);
      expect(await audits(due)).toHaveLength(1);
    },
  );

  it("leaves decided and withdrawn proposals alone", async () => {
    const id = await proposal("awaiting_team", 40);
    await h.admin.query(`UPDATE site_memory_proposals SET state = 'withdrawn' WHERE id = $1`, [id]);
    await pass();
    expect(await stateOf(id)).toBe("withdrawn");
    expect(await notices(ids.proposer, id)).toEqual([]);
  });

  it("two runners at once expire and notify once", async () => {
    const id = await proposal("awaiting_site", 35);
    await Promise.all([pass(), pass()]);
    expect(await stateOf(id)).toBe("expired");
    expect(await notices(ids.proposer, id)).toHaveLength(1);
    expect(await notices(ids.admin, id)).toHaveLength(1);
    expect(await audits(id)).toHaveLength(1);
  });
});

describe("holds (ac-2)", () => {
  it("a Site-wide hold freezes expiry and reminders", async () => {
    const id = await proposal("awaiting_site", 31);
    await reminder(id, ids.siteMember, "memory.site_proposal.confirmed", 8);
    const team = await proposal("awaiting_team", 10);
    await reminder(team, ids.admin, "memory.site_proposal.received");
    await makeDue(team);
    await placeHold("site_legal_holds");
    await pass();
    await sweepMemoryReminders(db());
    expect(await stateOf(id)).toBe("awaiting_site");
    expect(await remindersOf(id)).toEqual([
      { team_id: teamA, user_id: ids.siteMember, sent: true },
    ]);
    expect(await remindersOf(team)).toEqual([{ team_id: teamA, user_id: ids.admin, sent: false }]);
    expect(await notices(ids.admin, team)).toEqual([]);
    expect(await notices(ids.siteAdmin, team)).toEqual([]);
    await clearHolds();
    await pass();
    expect(await stateOf(id)).toBe("expired");
    await sweepMemoryReminders(db());
    expect((await notices(ids.admin, team)).map((n) => n.kind)).toEqual(["memory.review.reminder"]);
  });

  it.each([["person"], ["Workspace"]])("a %s hold keeps the proposer's proposals", async (kind) => {
    const id = await proposal("awaiting_site", 31);
    await placeHold("legal_holds", kind === "person" ? ids.proposer : undefined);
    await pass();
    expect(await stateOf(id)).toBe("awaiting_site");
    expect(await notices(ids.proposer, id)).toEqual([]);
    await clearHolds();
    await pass();
    expect(await stateOf(id)).toBe("expired");
  });
});

describe("reminders (ac-1, ac-3)", () => {
  it("awaiting_team: the Team admins hear once, 7 days in, never again (KOBE-666)", async () => {
    const id = await proposal("awaiting_team", 10);
    await reminder(id, ids.admin, "memory.site_proposal.received");
    await makeDue(id);
    await sweepMemoryReminders(db());
    expect(await notices(ids.admin, id)).toMatchObject([
      {
        team_id: teamA,
        kind: "memory.review.reminder",
        related_kind: "memory.site_proposal.received",
      },
    ]);
    // Nothing more, however often the pass runs (or how many run at once)...
    await Promise.all([sweepMemoryReminders(db()), sweepMemoryReminders(db())]);
    expect(await notices(ids.admin, id)).toHaveLength(1);
    // ...nor a week (or three) later while the step still waits: one reminder per step.
    for (const days of [8, 15, 22]) {
      await h.admin.query(
        `UPDATE memory_reminders SET sent_at = now() - make_interval(days => $2)
          WHERE object_id = $1`,
        [id, days],
      );
      await sweepMemoryReminders(db());
    }
    expect(await notices(ids.admin, id)).toHaveLength(1);
    expect(await remindersOf(id)).toEqual([{ team_id: teamA, user_id: ids.admin, sent: true }]);
    // Confirmed: the Team step ended, its reminder is dropped at send.
    await h.admin.query(
      `UPDATE site_memory_proposals SET state = 'awaiting_site', team_confirmed_by = $2,
         team_confirmed_at = now() WHERE id = $1`,
      [id, ids.admin],
    );
    await h.admin.query(
      `UPDATE memory_reminders SET sent_at = NULL, due_at = now() - interval '1 second'
        WHERE object_id = $1`,
      [id],
    );
    await sweepMemoryReminders(db());
    expect(
      (await notices(ids.admin, id)).filter((n) => n.kind === "memory.review.reminder"),
    ).toHaveLength(1);
    expect((await remindersOf(id)).filter((r) => r.user_id === ids.admin)).toEqual([]);
  });

  it("awaiting_site: curators outside the Workspace hear in their own (relay)", async () => {
    const id = await proposal("awaiting_site", 1);
    await reminder(id, ids.siteMember, "memory.site_proposal.confirmed");
    await sweepMemoryReminders(db());
    // The Site admin in B and C hears in C (last used), once; no actor, ids only.
    expect(await notices(ids.siteAdmin, id)).toEqual([
      { team_id: teamC, kind: "memory.site_proposal.confirmed", related_kind: null },
    ]);
    const { rows } = await h.admin.query(
      `SELECT actor_user_id FROM notifications WHERE memory_object_id = $1 AND user_id = $2`,
      [id, ids.siteAdmin],
    );
    expect(rows).toEqual([{ actor_user_id: null }]);
    // The member Site admin is KOBE-403's (in A); the steward belongs nowhere (no bell).
    expect(await notices(ids.siteMember, id)).toEqual([]);
    expect(await notices(ids.steward, id)).toEqual([]);
    expect(await remindersOf(id)).toEqual(
      [
        { team_id: teamA, user_id: ids.siteMember, sent: false },
        { team_id: teamC, user_id: ids.siteAdmin, sent: false },
      ].sort((a, b) => a.user_id.localeCompare(b.user_id)),
    );
    // The relayed reminder is due 7 days after the step started (the confirmation), as KOBE-403's.
    const due = await h.admin.query<{ off: number }>(
      `SELECT abs(extract(epoch FROM r.due_at - (p.team_confirmed_at + interval '7 days')))::int
              AS off
         FROM memory_reminders r JOIN site_memory_proposals p ON p.id = r.object_id
        WHERE r.object_id = $1 AND r.user_id = $2`,
      [id, ids.siteAdmin],
    );
    expect(due.rows[0]?.off).toBeLessThan(5);
    // Again, and two at once: no second notice.
    await Promise.all([sweepMemoryReminders(db()), sweepMemoryReminders(db())]);
    expect(await notices(ids.siteAdmin, id)).toHaveLength(1);
    // 7 days in, both curators are reminded where they hear.
    await makeDue(id);
    await sweepMemoryReminders(db());
    const seen = async () => [
      (await notices(ids.siteAdmin, id)).map((n) => [n.team_id, n.kind]),
      (await notices(ids.siteMember, id)).map((n) => [n.team_id, n.kind]),
    ];
    const once = [
      [
        [teamC, "memory.site_proposal.confirmed"],
        [teamC, "memory.review.reminder"],
      ],
      [[teamA, "memory.review.reminder"]],
    ];
    expect(await seen()).toEqual(once);
    // A week later, still waiting: no second reminder (KOBE-666), and no second relay.
    await h.admin.query(
      `UPDATE memory_reminders SET sent_at = now() - interval '8 days' WHERE object_id = $1`,
      [id],
    );
    await sweepMemoryReminders(db());
    expect(await seen()).toEqual(once);
  });

  it("relays again for a new confirmation round and drops the old one's reminder", async () => {
    const id = await proposal("awaiting_site", 1);
    await sweepMemoryReminders(db());
    expect(await notices(ids.siteAdmin, id)).toHaveLength(1);
    // Sent back, confirmed again (KOBE-403 moves team_confirmed_at).
    await h.admin.query(
      `UPDATE memory_reminders SET created_at = now() - interval '1 day' WHERE object_id = $1`,
      [id],
    );
    await h.admin.query(
      `UPDATE site_memory_proposals SET rounds = 1, team_confirmed_at = now() - interval '1 hour'
        WHERE id = $1`,
      [id],
    );
    await sweepMemoryReminders(db());
    expect((await notices(ids.siteAdmin, id)).map((n) => n.kind)).toEqual([
      "memory.site_proposal.confirmed",
      "memory.site_proposal.confirmed",
    ]);
    expect(await remindersOf(id)).toEqual([
      { team_id: teamC, user_id: ids.siteAdmin, sent: false },
    ]);
  });

  it("drops a relayed reminder once the Site decided, and relays nothing after", async () => {
    const id = await proposal("awaiting_site", 1);
    await sweepMemoryReminders(db());
    await h.admin.query(
      `UPDATE site_memory_proposals SET state = 'rejected', decided_by = $2, decided_at = now(),
         reason = 'No.' WHERE id = $1`,
      [id, ids.siteMember],
    );
    await makeDue(id);
    await sweepMemoryReminders(db());
    expect((await notices(ids.siteAdmin, id)).map((n) => n.kind)).toEqual([
      "memory.site_proposal.confirmed",
    ]);
    expect(await remindersOf(id)).toEqual([]);
  });

  it("a reminder for an expired proposal is dropped, not sent", async () => {
    const id = await proposal("awaiting_site", 31);
    await reminder(id, ids.siteMember, "memory.site_proposal.confirmed");
    await makeDue(id);
    await sweepMemoryReminders(db());
    expect(await notices(ids.siteMember, id)).toEqual([]);
    expect(await notices(ids.siteAdmin, id)).toEqual([]);
    expect(await remindersOf(id)).toEqual([]);
  });
});
