import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate.js";
import {
  createTestDatabase,
  migrationsBefore,
  testServerUrl,
  type TestDatabase,
} from "./test-support/database.js";

/**
 * KOBE-648 (v1.3 Semantic Memory SMA11c, SM28; amends D10), migrations 0226-0227: the Site-level
 * break-glass grant for one person's portable memories. `site_break_glass_grants` is a site-wide
 * table (no team_id) with the lifecycle, two-person rule and time box of `break_glass_grants`,
 * enforced by `site_break_glass_grants_guard`; the subject can never request or decide a grant
 * about themselves. Workspace grants are unchanged.
 */
const MARKER = 'CREATE TABLE "site_break_glass_grants"';

let db: TestDatabase | undefined;
let older = "";
const teamA = randomUUID();
const ann = randomUUID(); // site admin, requester
const ben = randomUUID(); // site admin, approver
const cat = randomUUID(); // member, the subject
const dan = randomUUID(); // site admin and a subject
let oldPortable = "";

const database = (): TestDatabase => {
  if (!db) throw new Error("database not created");
  return db;
};

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}
const asAdmin = <T>(fn: (c: pg.Client) => Promise<T>) => withClient(database().adminUrl, fn);

/** Runs `fn` as the app role (no team context); rolls back unless `commit`. */
async function asApp<T>(fn: (c: pg.Client) => Promise<T>, commit = false) {
  return withClient(database().appUrl, async (c) => {
    await c.query("BEGIN");
    try {
      const out = await fn(c);
      await c.query(commit ? "COMMIT" : "ROLLBACK");
      return out;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    }
  });
}

/** The SQLSTATE `sql` fails with, in a savepoint (undefined: it passed). */
async function code(c: pg.Client, sql: string, params: unknown[] = []) {
  await c.query("SAVEPOINT p");
  try {
    await c.query(sql, params);
    await c.query("RELEASE SAVEPOINT p");
    return undefined;
  } catch (e) {
    await c.query("ROLLBACK TO SAVEPOINT p");
    return (e as { code?: string }).code;
  }
}

const first = async (c: pg.Client, sql: string, params: unknown[] = []) => {
  const { rows } = await c.query<{ id: string }>(sql, params);
  if (!rows[0]) throw new Error(`no row: ${sql}`);
  return rows[0].id;
};

const ask = (c: pg.Client, admin = ann, subject = cat, extra = "") =>
  first(
    c,
    `INSERT INTO site_break_glass_grants (admin_id, subject_user_id, reason${extra ? ", duration_minutes" : ""})
     VALUES ($1, $2, 'investigation 9'${extra ? `, ${extra}` : ""}) RETURNING id`,
    [admin, subject],
  );
const APPROVE = `UPDATE site_break_glass_grants SET status = 'approved', approver_id = $2 WHERE id = $1`;

/** Moves a grant's window (and request deadline) into the past, bypassing the guard. */
async function backdate(id: string): Promise<void> {
  await asAdmin(async (c) => {
    await c.query(`SET session_replication_role = replica`);
    await c.query(
      `UPDATE site_break_glass_grants SET request_expires_at = now() - interval '1 hour',
         starts_at = CASE WHEN starts_at IS NULL THEN NULL ELSE now() - interval '2 hours' END,
         expires_at = CASE WHEN expires_at IS NULL THEN NULL ELSE now() - interval '1 hour' END
       WHERE id = $1`,
      [id],
    );
  });
}

beforeAll(async () => {
  older = migrationsBefore(MARKER);
  db = await createTestDatabase(testServerUrl(), { migrationsFolder: older });
  await asAdmin(async (c) => {
    await c.query(
      `INSERT INTO users (id, name, email) VALUES ($1, 'Ann', $2), ($3, 'Ben', $4), ($5, 'Cat', $6), ($7, 'Dan', $8)`,
      [
        ann,
        `${ann}@example.test`,
        ben,
        `${ben}@example.test`,
        cat,
        `${cat}@example.test`,
        dan,
        `${dan}@example.test`,
      ],
    );
    await c.query(
      `INSERT INTO site_roles (user_id, role) VALUES ($1, 'admin'), ($2, 'admin'), ($3, 'admin')`,
      [ann, ben, dan],
    );
    await c.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'A')`, [
      teamA,
      `a-${teamA.slice(0, 8)}`,
    ]);
  });
  // A portable preference written before the upgrade.
  oldPortable = await asApp(async (c) => {
    const id = await first(
      c,
      `INSERT INTO portable_memory_items (owner_user_id, kind, current_version)
       VALUES ($1, 'preference', 1) RETURNING id`,
      [cat],
    );
    await c.query(
      `INSERT INTO portable_memory_item_versions (item_id, version, statement, actor_kind, actor_user_id)
       VALUES ($1, 1, 'Prefers metric units', 'user', $2)`,
      [id, cat],
    );
    return id;
  }, true);
  await runMigrations({ databaseUrl: database().ownerUrl, appRole: database().appRole });
}, 180_000);

afterAll(async () => {
  await db?.drop();
  if (older) rmSync(older, { recursive: true, force: true });
});

describe("Site-level break-glass lifecycle (0226-0227, KOBE-648)", () => {
  it("starts as a pending request by a site admin, stamped by the database", async () => {
    await asApp(async (c) => {
      expect(
        await code(
          c,
          `INSERT INTO site_break_glass_grants (admin_id, subject_user_id, reason, status)
           VALUES ($1, $2, 'r', 'approved')`,
          [ann, cat],
        ),
      ).toBe("55000");
      // Not a site admin; the subject themselves; an empty reason; past the 24 h maximum.
      expect(
        await code(
          c,
          `INSERT INTO site_break_glass_grants (admin_id, subject_user_id, reason) VALUES ($1, $2, 'r')`,
          [cat, ann],
        ),
      ).toBe("42501");
      expect(
        await code(
          c,
          `INSERT INTO site_break_glass_grants (admin_id, subject_user_id, reason) VALUES ($1, $1, 'r')`,
          [dan],
        ),
      ).toBe("23514");
      expect(
        await code(
          c,
          `INSERT INTO site_break_glass_grants (admin_id, subject_user_id, reason) VALUES ($1, $2, '  ')`,
          [ann, cat],
        ),
      ).toBe("23514");
      expect(
        await code(
          c,
          `INSERT INTO site_break_glass_grants (admin_id, subject_user_id, reason, duration_minutes)
           VALUES ($1, $2, 'r', 1441)`,
          [ann, cat],
        ),
      ).toBe("23514");
      const id = await first(
        c,
        `INSERT INTO site_break_glass_grants (admin_id, subject_user_id, reason, requested_at, request_expires_at)
         VALUES ($1, $2, 'r', now() - interval '9 days', now() + interval '9 days') RETURNING id`,
        [ann, cat],
      );
      const { rows } = await c.query(
        `SELECT status, requested_at > now() - interval '1 minute' AS fresh,
                request_expires_at - requested_at = interval '24 hours' AS deadline
           FROM site_break_glass_grants WHERE id = $1`,
        [id],
      );
      expect(rows).toEqual([{ status: "pending", fresh: true, deadline: true }]);
    });
  });

  it("needs a second site admin who is not the subject, sets the window, and never changes the request", async () => {
    await asApp(async (c) => {
      const id = await ask(c, ann, cat, "90");
      expect(await code(c, APPROVE, [id, ann])).toBe("42501"); // ben and dan exist
      expect(await code(c, APPROVE, [id, cat])).toBe("42501"); // not an admin
      for (const change of [
        `reason = 'x'`,
        `subject_user_id = '${ben}'`,
        `duration_minutes = 600`,
        `legal_hold = true`,
      ]) {
        expect(
          await code(c, `UPDATE site_break_glass_grants SET ${change} WHERE id = $1`, [id]),
          change,
        ).toBe("55000");
      }
      expect(await code(c, APPROVE, [id, ben])).toBeUndefined();
      const { rows } = await c.query(
        `SELECT status, self_approved, decided_by = $2 AS by_ben,
                expires_at - starts_at = interval '90 minutes' AS window
           FROM site_break_glass_grants WHERE id = $1`,
        [id, ben],
      );
      expect(rows).toEqual([
        { status: "approved", self_approved: false, by_ben: true, window: true },
      ]);
      expect(
        await code(
          c,
          `UPDATE site_break_glass_grants SET expires_at = expires_at + interval '1 hour' WHERE id = $1`,
          [id],
        ),
      ).toBe("55000");
      // Not expired before its window ends.
      expect(
        await code(c, `UPDATE site_break_glass_grants SET status = 'expired' WHERE id = $1`, [id]),
      ).toBe("55000");
    });
  });

  it("never lets the subject approve or decide, even as a site admin", async () => {
    await asApp(async (c) => {
      const id = await ask(c, ann, dan);
      expect(await code(c, APPROVE, [id, dan])).toBe("42501");
      expect(
        await code(
          c,
          `UPDATE site_break_glass_grants SET status = 'denied', decided_by = $2 WHERE id = $1`,
          [id, dan],
        ),
      ).toBe("42501");
      expect(
        await code(
          c,
          `UPDATE site_break_glass_grants SET status = 'revoked', decided_by = $2 WHERE id = $1`,
          [id, dan],
        ),
      ).toBe("42501");
      await c.query(APPROVE, [id, ben]);
      expect(
        await code(
          c,
          `UPDATE site_break_glass_grants SET status = 'revoked', decided_by = $2 WHERE id = $1`,
          [id, dan],
        ),
      ).toBe("42501");
    });
  });

  it("self-approves (flagged) when the only other active admin is the subject", async () => {
    await asAdmin((c) => c.query(`UPDATE users SET deactivated_at = now() WHERE id = $1`, [ben]));
    try {
      await asApp(async (c) => {
        const id = await ask(c, ann, dan);
        expect(await code(c, APPROVE, [id, ann])).toBeUndefined();
        const { rows } = await c.query(
          `SELECT status, self_approved FROM site_break_glass_grants WHERE id = $1`,
          [id],
        );
        expect(rows).toEqual([{ status: "approved", self_approved: true }]);
        // About cat, dan is a second admin: no self-approval.
        const other = await ask(c, ann, cat);
        expect(await code(c, APPROVE, [other, ann])).toBe("42501");
        // A deactivated admin can't approve.
        expect(await code(c, APPROVE, [other, ben])).toBe("42501");
      });
    } finally {
      await asAdmin((c) => c.query(`UPDATE users SET deactivated_at = NULL WHERE id = $1`, [ben]));
    }
  });

  it("is denied by another admin, withdrawn or revoked by any admin, and stays decided", async () => {
    await asApp(async (c) => {
      const denied = await ask(c);
      const deny = `UPDATE site_break_glass_grants SET status = 'denied', decided_by = $2 WHERE id = $1`;
      expect(await code(c, deny, [denied, ann])).toBe("42501");
      expect(await code(c, deny, [denied, ben])).toBeUndefined();
      expect(await code(c, APPROVE, [denied, ben])).toBe("55000");

      const withdrawn = await ask(c);
      await c.query(
        `UPDATE site_break_glass_grants SET status = 'revoked', decided_by = $2 WHERE id = $1`,
        [withdrawn, ann],
      );
      const revoked = await ask(c);
      await c.query(APPROVE, [revoked, ben]);
      await c.query(
        `UPDATE site_break_glass_grants SET status = 'revoked', decided_by = $2 WHERE id = $1`,
        [revoked, ann],
      );
      const { rows } = await c.query(
        `SELECT status, ended_at IS NOT NULL AS ended FROM site_break_glass_grants
          WHERE id = ANY($1::uuid[]) ORDER BY status`,
        [[denied, withdrawn, revoked]],
      );
      expect(rows).toEqual([
        { status: "denied", ended: true },
        { status: "revoked", ended: true },
        { status: "revoked", ended: true },
      ]);
      expect(
        await code(c, `UPDATE site_break_glass_grants SET status = 'approved' WHERE id = $1`, [
          revoked,
        ]),
      ).toBe("55000");
    });
  });

  it("expires only after the window or the request deadline; a lapsed request can't be approved", async () => {
    const [active, lapsed] = await asApp(async (c) => {
      const a = await ask(c);
      await c.query(APPROVE, [a, ben]);
      return [a, await ask(c)];
    }, true);
    await backdate(active);
    await backdate(lapsed);
    await asApp(async (c) => {
      expect(await code(c, APPROVE, [lapsed, ben])).toBe("55000");
      await c.query(
        `UPDATE site_break_glass_grants SET status = 'expired' WHERE id = ANY($1::uuid[])`,
        [[active, lapsed]],
      );
      const { rows } = await c.query(
        `SELECT id = $1 AS was_active, status, ended_at IS NOT NULL AS ended
           FROM site_break_glass_grants WHERE id = ANY($2::uuid[]) ORDER BY 1`,
        [active, [active, lapsed]],
      );
      expect(rows).toEqual([
        { was_active: false, status: "expired", ended: true },
        { was_active: true, status: "expired", ended: true },
      ]);
    }, true);
  });

  it("grants the app role least privilege: no DELETE or TRUNCATE on grants or their outbox", async () => {
    await asApp(async (c) => {
      const id = await ask(c);
      expect(await code(c, `DELETE FROM site_break_glass_grants WHERE id = $1`, [id])).toBe(
        "42501",
      );
      expect(await code(c, `DELETE FROM site_break_glass_notifications`)).toBe("42501");
      expect(await code(c, `TRUNCATE site_break_glass_grants`)).toBe("42501");
      await c.query(
        `INSERT INTO site_break_glass_notifications (grant_id, event, recipient_id, recipient_role)
         VALUES ($1, 'requested', $2, 'site_admin')`,
        [id, ben],
      );
      expect(
        await code(
          c,
          `INSERT INTO site_break_glass_notifications (grant_id, event, recipient_id, recipient_role)
           VALUES ($1, 'read', $2, 'site_admin')`,
          [id, ben],
        ),
      ).toBe("23514");
    });
  });

  it("leaves portable memories written before the upgrade and Workspace grants untouched", async () => {
    await asApp(async (c) => {
      const { rows } = await c.query(
        `SELECT owner_user_id = $2 AS cat FROM portable_memory_items WHERE id = $1`,
        [oldPortable, cat],
      );
      expect(rows).toEqual([{ cat: true }]);
      // Workspace grants still need their team and keep their own guard.
      expect(
        await code(c, `INSERT INTO break_glass_grants (admin_id, reason) VALUES ($1, 'r')`, [ann]),
      ).toBe("23502");
      const ws = await first(
        c,
        `INSERT INTO break_glass_grants (team_id, admin_id, user_id, reason) VALUES ($1, $2, $3, 'r') RETURNING id`,
        [teamA, ann, cat],
      );
      expect(
        await code(
          c,
          `UPDATE break_glass_grants SET status = 'approved', approver_id = $2 WHERE id = $1`,
          [ws, ben],
        ),
      ).toBeUndefined();
    });
  });

  it("stays invoker-rights with a pinned search_path", async () => {
    await asAdmin(async (c) => {
      const { rows } = await c.query<{ name: string; definer: boolean; config: string[] }>(
        `SELECT proname AS name, prosecdef AS definer, proconfig AS config FROM pg_proc
          WHERE proname LIKE 'site_break_glass%' ORDER BY proname`,
      );
      expect(rows.map((r) => r.name)).toEqual(["site_break_glass_grants_guard"]);
      for (const r of rows) {
        expect(r, r.name).toMatchObject({
          definer: false,
          config: ["search_path=pg_catalog, public"],
        });
      }
    });
  });
});
