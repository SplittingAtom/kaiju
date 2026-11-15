import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, testServerUrl, type TestDatabase } from "@kobe/db/testing";
import { createApp } from "./app.js";
import { sweepBreakGlass } from "./break-glass/sweeper.js";
import { createServerDeps, type ServerDeps } from "./deps.js";
import { TestBrowser } from "./testing/browser.js";
import { MemoryMailer } from "./testing/mailer.js";

// KOBE-648 (SM28; amends D10): Site-level break-glass on one person's portable memories, end to
// end: request, two-person approval, notifications per the break-glass rule, reads refused without
// an active grant and allowed (read-only) with one, every read audited in the Site log and in each
// of the person's Workspaces, revocation and expiry.
const PUBLIC_URL = "http://kobe.test";
const PASSWORD = "a long enough password";

const PEOPLE = ["owner", "investigator", "alice", "bob", "dave", "erin"] as const;
type Person = (typeof PEOPLE)[number];
const ids = Object.fromEntries(PEOPLE.map((p) => [p, ""])) as Record<Person, string>;
const email = (who: Person) => `${who}@sbg.test`;

let database: TestDatabase;
let deps: ServerDeps;
let mailer: MemoryMailer;
let app: ReturnType<typeof createApp>;
let admin: pg.Client;
let as: Record<Person, TestBrowser>;
// finance: alice team_admin, bob member. marketing: dave team_admin, bob member. ops: erin only.
let finance = "";
let marketing = "";
let ops = "";
let bobItem = "";
let aliceItem = "";

async function signIn(who: Person): Promise<TestBrowser> {
  const b = new TestBrowser(app, PUBLIC_URL);
  const res = await b.post("/api/auth/sign-in/email", { email: email(who), password: PASSWORD });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return b;
}

async function activate(b: TestBrowser, teamId: string): Promise<void> {
  const res = await b.put("/v1/me/teams/active", { teamId });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  b.team = teamId;
}

async function addMember(by: TestBrowser, who: Person): Promise<void> {
  const res = await by.post("/v1/team/invites", { email: email(who), role: "member" });
  expect(res.status, JSON.stringify(res.json)).toBe(202);
  const accepted = await as[who].post(`/v1/me/invites/${by.team}/accept`);
  expect(accepted.status, JSON.stringify(accepted.json)).toBe(200);
}

async function portable(owner: Person, statement: string): Promise<string> {
  await admin.query("BEGIN");
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO portable_memory_items (owner_user_id, kind) VALUES ($1, 'preference') RETURNING id`,
    [ids[owner]],
  );
  const id = rows[0]?.id ?? "";
  await admin.query(
    `INSERT INTO portable_memory_item_versions (item_id, version, statement, actor_kind, actor_user_id)
     VALUES ($1, 1, $2, 'user', $3)`,
    [id, statement, ids[owner]],
  );
  await admin.query("COMMIT");
  return id;
}

const BASE = "/v1/site/portable-break-glass";

async function requestGrant(
  body: { subjectUserId?: string; legalHold?: boolean; durationMinutes?: number } = {},
  by: Person = "investigator",
): Promise<string> {
  const res = await as[by].post(BASE, {
    subjectUserId: ids.bob,
    reason: "HR case 12: harassment complaint",
    ...body,
  });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return res.json.grant.id as string;
}

async function activeGrant(body: { legalHold?: boolean } = {}): Promise<string> {
  const id = await requestGrant(body);
  const res = await as.owner.post(`${BASE}/${id}/approve`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return id;
}

async function auditFor(grantId: string) {
  const { rows } = await admin.query<{
    action: string;
    team_id: string | null;
    actor_id: string | null;
    target: Record<string, unknown>;
  }>(
    `SELECT action, team_id, actor_id, target FROM audit_log WHERE target->>'grantId' = $1 ORDER BY seq`,
    [grantId],
  );
  return rows;
}

async function mailTo(who: Person, count: number) {
  const deadline = Date.now() + 5_000;
  while (mailer.to(email(who)).length < count && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  return mailer.to(email(who));
}

const settled = () => new Promise((r) => setTimeout(r, 300));

async function backdate(id: string): Promise<void> {
  await admin.query(`SET session_replication_role = replica`);
  await admin.query(
    `UPDATE site_break_glass_grants SET starts_at = now() - interval '2 hours',
       expires_at = now() - interval '1 hour', request_expires_at = now() - interval '1 hour'
     WHERE id = $1`,
    [id],
  );
  await admin.query(`SET session_replication_role = origin`);
}

beforeAll(async () => {
  database = await createTestDatabase(testServerUrl());
  admin = new pg.Client({ connectionString: database.adminUrl });
  await admin.connect();
  mailer = new MemoryMailer();
  deps = createServerDeps({
    databaseUrl: database.appUrl,
    publicUrl: PUBLIC_URL,
    authSecret: "c".repeat(48),
    setupToken: "setup-token-for-site-break-glass",
    trustedProxies: ["127.0.0.1/32"],
    mailer,
  });
  app = createApp(deps);
  for (const who of PEOPLE) {
    const siteRole = who === "owner" ? "owner" : who === "investigator" ? "admin" : undefined;
    const user = await deps.createUserWithPassword(
      { email: email(who), name: who, password: PASSWORD },
      siteRole ? { siteRole } : {},
    );
    ids[who] = user.id;
  }
  as = Object.fromEntries(
    await Promise.all(PEOPLE.map(async (w) => [w, await signIn(w)])),
  ) as Record<Person, TestBrowser>;
  const create = async (slug: string, adminUser: Person) => {
    const res = await as.owner.post("/v1/site/teams", {
      slug,
      name: slug,
      adminUserId: ids[adminUser],
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    return res.json.team.id as string;
  };
  finance = await create("finance", "alice");
  marketing = await create("marketing", "dave");
  ops = await create("ops", "erin");
  await activate(as.alice, finance);
  await addMember(as.alice, "bob");
  await activate(as.dave, marketing);
  await addMember(as.dave, "bob");
  await activate(as.erin, ops);
  bobItem = await portable("bob", "Bob prefers short answers");
  await portable("bob", "Bob writes in British English");
  aliceItem = await portable("alice", "Alice likes tables");
});

afterEach(async () => {
  await admin.query(`SET session_replication_role = replica`);
  await admin.query(
    `UPDATE site_break_glass_grants SET status = 'revoked', decided_by = admin_id, decided_at = now(),
       ended_at = now() WHERE status IN ('pending', 'approved')`,
  );
  await admin.query(`SET session_replication_role = origin`);
  await admin.query(`DELETE FROM rate_limits WHERE key LIKE 'kobe:site-break-glass-%'`);
});

afterAll(async () => {
  await settled();
  await deps?.close();
  await admin?.end();
  await database?.drop();
});

describe("requesting and approving (POST /v1/site/portable-break-glass)", () => {
  it("records a pending request in the Site log and asks the other site admins, never the person", async () => {
    const before = mailer.to(email("bob")).length;
    const id = await requestGrant();
    const rows = await auditFor(id);
    expect(rows).toEqual([
      expect.objectContaining({
        action: "governance.site_break_glass.requested",
        team_id: null,
        actor_id: ids.investigator,
        target: expect.objectContaining({ subjectUserId: ids.bob, legalHold: false }),
      }),
    ]);
    const owner = await mailTo("owner", 1);
    expect(owner.at(-1)?.subject).toMatch(/bob's portable memories needs a second admin/);
    await settled();
    expect(mailer.to(email("bob")).length).toBe(before);
  });

  it("validates the body and is for site admins only", async () => {
    const bad = await as.investigator.post(BASE, { subjectUserId: ids.bob, reason: "short" });
    expect(bad.status).toBe(400);
    const self = await as.investigator.post(BASE, {
      subjectUserId: ids.investigator,
      reason: "looking at my own memories",
    });
    expect(self.status).toBe(400);
    for (const who of ["alice", "bob"] as const) {
      expect((await as[who].get(BASE)).status).toBe(403);
      expect(
        (await as[who].post(BASE, { subjectUserId: ids.erin, reason: "a reason long enough" }))
          .status,
      ).toBe(403);
    }
  });

  it("needs a second site admin; approval notifies the person and the site admins, never Workspace admins", async () => {
    const id = await requestGrant();
    const self = await as.investigator.post(`${BASE}/${id}/approve`);
    expect(self.status).toBe(403);
    expect(self.json.code).toBe("self_approval_forbidden");
    const counts = {
      bob: mailer.to(email("bob")).length,
      alice: mailer.to(email("alice")).length,
      dave: mailer.to(email("dave")).length,
      erin: mailer.to(email("erin")).length,
    };
    const res = await as.owner.post(`${BASE}/${id}/approve`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.grant.status).toBe("active");
    expect(res.json.notified).not.toHaveProperty("teamAdmins");
    const bob = await mailTo("bob", counts.bob + 1);
    expect(bob.at(-1)?.subject).toMatch(/your portable memories was approved/);
    await settled();
    // Workspace admins of the person's Workspaces (alice, dave) are not emailed (Chris 2026-11-14).
    expect(mailer.to(email("alice")).length).toBe(counts.alice);
    expect(mailer.to(email("dave")).length).toBe(counts.dave);
    expect(mailer.to(email("erin")).length).toBe(counts.erin);
    const approved = (await auditFor(id)).find(
      (r) => r.action === "governance.site_break_glass.approved",
    );
    expect(approved).toMatchObject({ team_id: null, target: { selfApproved: false } });
  });

  it("legal hold: the person is not told and no audit row names them", async () => {
    const before = mailer.to(email("bob")).length;
    const id = await activeGrant({ legalHold: true });
    const read = await as.investigator.get(`${BASE}/${id}/items`);
    expect(read.status).toBe(200);
    await settled();
    expect(mailer.to(email("bob")).length).toBe(before);
    for (const row of await auditFor(id)) {
      expect(row.target, row.action).not.toHaveProperty("subjectUserId");
    }
  });
});

describe("reading portable memories under a grant", () => {
  it("is refused without an active grant, and by anyone but the requester", async () => {
    const id = await requestGrant();
    const pending = await as.investigator.get(`${BASE}/${id}/items`);
    expect(pending.status).toBe(403);
    expect(pending.json.code).toBe("grant_not_active");
    await as.owner.post(`${BASE}/${id}/approve`);
    expect((await as.owner.get(`${BASE}/${id}/items`)).status).toBe(404);
    expect((await as.bob.get(`${BASE}/${id}/items`)).status).toBe(403);
    expect((await auditFor(id)).filter((r) => r.action.endsWith(".read"))).toHaveLength(0);
  });

  it("returns only the person's portable memories, read-only, and audits each read everywhere", async () => {
    const id = await activeGrant();
    const res = await as.investigator.get(`${BASE}/${id}/items`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.grant).toMatchObject({ subject_user_id: ids.bob, workspaces: 2 });
    expect(res.json.items.map((i: { statement: string }) => i.statement).sort()).toEqual([
      "Bob prefers short answers",
      "Bob writes in British English",
    ]);
    const one = await as.investigator.get(`${BASE}/${id}/items/${bobItem}`);
    expect(one.status).toBe(200);
    expect(one.json.versions).toHaveLength(1);
    // Another person's item is outside the grant, and the refused read leaves no audit row.
    const reads = () => auditFor(id).then((r) => r.filter((x) => x.action.endsWith(".read")));
    const before = (await reads()).length;
    expect((await as.investigator.get(`${BASE}/${id}/items/${aliceItem}`)).status).toBe(404);
    expect((await reads()).length).toBe(before);
    // Two reads: each in the Site log and in finance and marketing, never in ops.
    const rows = await reads();
    expect(rows.map((r) => r.team_id).sort()).toEqual(
      [null, null, finance, finance, marketing, marketing].sort(),
    );
    // The Workspace admins see them in their audit views.
    const view = await as.alice.get("/v1/team/audit");
    expect(view.status).toBe(200);
    expect(
      view.json.events.filter(
        (e: { action: string; target: { grantId?: string } }) =>
          e.action === "governance.site_break_glass.read" && e.target.grantId === id,
      ),
    ).toHaveLength(2);
    // No write route exists under a grant.
    expect((await as.investigator.post(`${BASE}/${id}/items`, {})).status).toBe(404);
    expect((await as.investigator.delete(`${BASE}/${id}/items/${bobItem}`)).status).toBe(404);
  });

  it("ends at once on revocation, and at expiry without the sweep; the sweep records it once", async () => {
    const revoked = await activeGrant();
    expect((await as.owner.post(`${BASE}/${revoked}/revoke`)).status).toBe(200);
    expect((await as.investigator.get(`${BASE}/${revoked}/items`)).status).toBe(403);

    const expired = await activeGrant();
    await backdate(expired);
    expect((await as.investigator.get(`${BASE}/${expired}/items`)).status).toBe(403);
    await sweepBreakGlass(deps);
    await sweepBreakGlass(deps);
    const ends = (await auditFor(expired)).filter(
      (r) => r.action === "governance.site_break_glass.expired",
    );
    expect(ends).toHaveLength(1);
    expect(ends[0]?.target).toMatchObject({ wasActive: true });
  });
});
