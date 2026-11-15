import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  SiteBreakGlassDenied,
  readPortableWithSiteBreakGlass,
  type PortableBreakGlassRead,
} from "./break-glass/portable-read.js";
import { createDb } from "./client.js";

/**
 * KOBE-648 (SM28; amends D10): reading one person's portable memories under a Site-level grant.
 * Refused without an approved, unexpired grant of the requesting (active) site admin; allowed with
 * one, read-only and only the subject's rows; every read audited in the Site log and in each of
 * the person's Workspaces.
 */
const app = createDb(inject("appUrl"), { max: 4 });
const appClient = new pg.Client({ connectionString: inject("appUrl") });
const admin = new pg.Client({ connectionString: inject("adminUrl") });

let requester = "";
let approver = "";
let alice = ""; // the subject: member of teamA and teamB
let bob = ""; // another person with portable items
let teamA = "";
let teamB = "";
let teamC = ""; // alice is not a member
let aliceItem = "";
let bobItem = "";

async function user(name: string, role?: "admin"): Promise<string> {
  const id = randomUUID();
  await admin.query(`INSERT INTO users (id, name, email) VALUES ($1, $2, $3)`, [
    id,
    name,
    `${id}@sbg.test`,
  ]);
  if (role) await admin.query(`INSERT INTO site_roles (user_id, role) VALUES ($1, $2)`, [id, role]);
  return id;
}

async function team(members: string[]): Promise<string> {
  const id = randomUUID();
  await admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'T')`, [
    id,
    `sbg-${id.slice(0, 8)}`,
  ]);
  for (const m of members) {
    await admin.query(
      `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`,
      [id, m],
    );
  }
  return id;
}

/** A portable preference with `versions` versions (current = last). */
async function portable(owner: string, versions = 1): Promise<string> {
  const id = randomUUID();
  await admin.query("BEGIN");
  await admin.query(
    `INSERT INTO portable_memory_items (id, owner_user_id, kind, current_version)
     VALUES ($1, $2, 'preference', $3)`,
    [id, owner, versions],
  );
  await admin.query(
    `INSERT INTO portable_memory_item_versions (item_id, version, statement, actor_kind, actor_user_id)
     SELECT $1, v, 'Pref of ' || $3 || ' v' || v, 'user', $2 FROM generate_series(1, $4::int) v`,
    [id, owner, owner === alice ? "alice" : "bob", versions],
  );
  await admin.query("COMMIT");
  return id;
}

async function request(subject = alice, adminId = requester, legalHold = false): Promise<string> {
  const { rows } = await appClient.query<{ id: string }>(
    `INSERT INTO site_break_glass_grants (subject_user_id, admin_id, reason, legal_hold)
     VALUES ($1, $2, 'investigation 7', $3) RETURNING id`,
    [subject, adminId, legalHold],
  );
  if (!rows[0]) throw new Error("insert returned no row");
  return rows[0].id;
}

async function approved(subject = alice, legalHold = false): Promise<string> {
  const id = await request(subject, requester, legalHold);
  await appClient.query(
    `UPDATE site_break_glass_grants SET status = 'approved', approver_id = $2 WHERE id = $1`,
    [id, approver],
  );
  return id;
}

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

async function audits(grantId: string) {
  const { rows } = await admin.query<{
    action: string;
    team_id: string | null;
    target: Record<string, unknown>;
  }>(`SELECT action, team_id, target FROM audit_log WHERE target->>'grantId' = $1 ORDER BY seq`, [
    grantId,
  ]);
  return rows;
}

const read = (grantId: string, r: PortableBreakGlassRead, adminId = requester) =>
  readPortableWithSiteBreakGlass(app.db, { grantId, adminId }, r);

const errorCode = async (p: Promise<unknown>): Promise<string | undefined> => {
  try {
    await p;
  } catch (err) {
    if (err instanceof SiteBreakGlassDenied) return err.code;
    throw err;
  }
  return undefined;
};

beforeAll(async () => {
  await appClient.connect();
  await admin.connect();
  requester = await user("Requester", "admin");
  approver = await user("Approver", "admin");
  alice = await user("Alice");
  bob = await user("Bob");
  teamA = await team([alice, bob]);
  teamB = await team([alice]);
  teamC = await team([bob]);
  aliceItem = await portable(alice, 2);
  await portable(alice);
  bobItem = await portable(bob);
});

afterAll(async () => {
  await app.close();
  await appClient.end();
  await admin.end();
});

describe("readPortableWithSiteBreakGlass (KOBE-648)", () => {
  it("refuses without an active grant of this admin, and writes nothing", async () => {
    const pending = await request();
    const revoked = await approved();
    await appClient.query(
      `UPDATE site_break_glass_grants SET status = 'revoked', decided_by = $2 WHERE id = $1`,
      [revoked, approver],
    );
    const expired = await approved();
    await backdate(expired);
    const items = { kind: "items", limit: 50 } as const;
    expect(await errorCode(read(randomUUID(), items))).toBe("grant_not_found");
    expect(await errorCode(read(pending, items))).toBe("grant_not_active");
    expect(await errorCode(read(revoked, items))).toBe("grant_not_active");
    expect(await errorCode(read(expired, items))).toBe("grant_not_active");
    // Another site admin (the approver) can't use the requester's grant.
    const active = await approved();
    expect(await errorCode(read(active, items, approver))).toBe("grant_not_found");
    for (const g of [pending, revoked, expired, active]) {
      expect((await audits(g)).filter((a) => a.action.endsWith(".read"))).toEqual([]);
    }
  });

  it("refuses once the requester is no longer an active site admin", async () => {
    const id = await approved();
    await admin.query(`UPDATE users SET deactivated_at = now() WHERE id = $1`, [requester]);
    try {
      expect(await errorCode(read(id, { kind: "items", limit: 10 }))).toBe("grant_not_active");
    } finally {
      await admin.query(`UPDATE users SET deactivated_at = NULL WHERE id = $1`, [requester]);
    }
  });

  it("returns only the subject's portable items with an active grant", async () => {
    const id = await approved();
    const result = await read(id, { kind: "items", limit: 50 });
    if (result.kind !== "items") throw new Error("kind");
    expect(result.grant).toMatchObject({ id, subjectUserId: alice, workspaces: 2 });
    expect(result.items).toHaveLength(2);
    expect(result.items.every((i) => i.statement.startsWith("Pref of alice"))).toBe(true);
    expect(result.items.find((i) => i.id === aliceItem)).toMatchObject({
      currentVersion: 2,
      statement: "Pref of alice v2",
    });
    // Paging stays on the subject.
    const first = await read(id, { kind: "items", limit: 1 });
    if (first.kind !== "items") throw new Error("kind");
    expect(first.nextAfterId).not.toBeNull();
    const second = await read(id, { kind: "items", limit: 1, afterId: first.nextAfterId });
    if (second.kind !== "items") throw new Error("kind");
    expect(second.items).toHaveLength(1);
    expect(second.nextAfterId).toBeNull();
  });

  it("reads one of the subject's items with its versions; another person's item is not found", async () => {
    const id = await approved();
    const one = await read(id, { kind: "item", itemId: aliceItem });
    if (one.kind !== "item") throw new Error("kind");
    expect(one.versions.map((v) => v.statement)).toEqual(["Pref of alice v1", "Pref of alice v2"]);
    const before = (await audits(id)).length;
    expect(await errorCode(read(id, { kind: "item", itemId: bobItem }))).toBe("not_found");
    // The refused read rolled back with its audit rows.
    expect(await audits(id)).toHaveLength(before);
  });

  it("audits every read in the Site log and in each of the person's Workspaces", async () => {
    const id = await approved();
    await read(id, { kind: "item", itemId: aliceItem });
    const rows = (await audits(id)).filter((a) => a.action === "governance.site_break_glass.read");
    expect(rows.map((r) => r.team_id).sort()).toEqual([null, teamA, teamB].sort());
    expect(rows.some((r) => r.team_id === teamC)).toBe(false);
    const site = rows.find((r) => r.team_id === null);
    expect(site?.target).toMatchObject({
      grantId: id,
      object: "portable_item",
      itemId: aliceItem,
      subjectUserId: alice,
      workspaces: 2,
    });
    const ws = rows.find((r) => r.team_id === teamA);
    expect(ws?.target).toMatchObject({ grantId: id, subjectUserId: alice, itemId: aliceItem });
    expect(ws?.target).not.toHaveProperty("workspaces");
  });

  it("leaves the person out of the audit rows under legal hold", async () => {
    const id = await approved(alice, true);
    await read(id, { kind: "item", itemId: aliceItem });
    const rows = (await audits(id)).filter((a) => a.action === "governance.site_break_glass.read");
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.target).not.toHaveProperty("subjectUserId");
      // The Site row too: a held site admin reads the Site log (security review).
      expect(r.target).not.toHaveProperty("itemId");
    }
  });

  it("refuses inside a team context and never leaves one set", async () => {
    const id = await approved();
    await expect(
      app.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('kobe.team_id', ${teamA}, true)`);
        return readPortableWithSiteBreakGlass(
          tx as never,
          { grantId: id, adminId: requester },
          { kind: "items", limit: 5 },
        );
      }),
    ).rejects.toThrow(/team context/);
  });
});
