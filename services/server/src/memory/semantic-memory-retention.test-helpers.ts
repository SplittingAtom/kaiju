// Shared setup for the semantic-memory-retention.*.db.test.ts files
// (split from semantic-memory-retention.db.test.ts, KOBE-725).
import { randomUUID } from "node:crypto";
import pino from "pino";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { runWithAuditContext } from "../audit/context.js";
import { runRetentionPass } from "../retention/index.js";
import type { TestBrowser } from "../testing/browser.js";
import { openHarness, type Harness } from "../testing/harness.js";
import {
  deactivateUser as deactivate,
  reactivateUserIfVia as reactivate,
} from "../users/deactivation.js";

/**
 * KOBE-386 (v1.3 SM28, Q7): semantic memory retention sweeps, offboarding and SSO/SCIM
 * deactivation. Workspace items follow the team's window, Site and portable items the Site window
 * (`retention_days`); evidence drops with its source conversation; a departed member's personal
 * items go 30 days after they left; portable items survive deactivation until a site admin purges
 * them. Holds always win: the hold lock first, held owners, Site-wide holds and held authors skipped.
 */
export let h: Harness;
export const log = pino({ level: "silent" });
export const ids = {
  owner: "",
  admin: "",
  alice: "",
  bob: "",
  carol: "",
  dora: "",
  erin: "",
  finn: "",
};
export const as = {} as { admin: TestBrowser };
export let team = "";
export let auditFloor = 0;
export const SCIM = "scim:11111111-2222-4333-8444-555555555555";
export const CONFIRM_DORA = { confirmEmail: "Dora@smret.test " };

/** The SCIM path's calls, as the provider's request would make them (an actor in context). */
export const asScim = <T>(fn: () => Promise<T>) =>
  runWithAuditContext({ actor: { kind: "user", id: ids.admin }, ip: null, userAgent: null }, fn);
export const deactivateUser = (...a: Parameters<typeof deactivate>) =>
  asScim(() => deactivate(...a));
export const reactivateUserIfVia = (...a: Parameters<typeof reactivate>) =>
  asScim(() => reactivate(...a));

export const DAY = 86_400_000;
export const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
export const pass = () => runRetentionPass({ db: h.deps.database.db, logger: log });
export const offboardingCtx = () => ({
  db: h.deps.database.db,
  provider: () => undefined,
  blobs: undefined,
  log,
});

export interface ItemSpec {
  readonly owner?: string;
  readonly status?: "active" | "archived" | "superseded";
  readonly supersededBy?: string;
  /** Days since the item's last change. */
  readonly updated?: number;
  /** Age in days of each version, oldest first; the last one is current. */
  readonly versions?: readonly number[];
  readonly actor?: string;
  readonly sourceThread?: string;
  readonly asOf?: string;
}

export const statusOf = (spec: ItemSpec) =>
  spec.status ?? (spec.supersededBy ? "superseded" : "active");

/** A Workspace item with its versions, in one statement (the current-version check is deferred). */
export async function ws(spec: ItemSpec): Promise<string> {
  const id = randomUUID();
  const ages = spec.versions ?? [1];
  await h.admin.query(
    `WITH i AS (
       INSERT INTO semantic_memory_items
         (team_id, id, scope, owner_user_id, kind, status, superseded_by, current_version, updated_at, as_of)
       VALUES ($1, $2, $3, $4, 'fact', $5, $6, $7, $8, $12::date))
     INSERT INTO semantic_memory_item_versions
       (team_id, item_id, version, statement, actor_user_id, actor_kind, created_at,
        source_thread_id, source_entry_ids, evidence)
     SELECT $1, $2, g.n, 'statement ' || g.n, $9, 'user', g.at, $10,
            CASE WHEN $10::uuid IS NULL THEN NULL ELSE ARRAY['e1'] END,
            CASE WHEN $10::uuid IS NULL THEN NULL ELSE '{"quote":"we ship on Fridays"}'::jsonb END
       FROM unnest($11::timestamptz[]) WITH ORDINALITY AS g(at, n)`,
    [
      team,
      id,
      spec.owner ? "user" : "team",
      spec.owner ?? null,
      statusOf(spec),
      spec.supersededBy ?? null,
      ages.length,
      ago(spec.updated ?? 0),
      spec.actor ?? spec.owner ?? ids.alice,
      spec.sourceThread ?? null,
      ages.map(ago),
      spec.asOf ?? null,
    ],
  );
  return id;
}

export async function site(spec: ItemSpec): Promise<string> {
  const id = randomUUID();
  const ages = spec.versions ?? [1];
  await h.admin.query(
    `WITH i AS (
       INSERT INTO site_memory_items (id, kind, status, superseded_by, current_version, updated_at)
       VALUES ($1, 'fact', $2, $3, $4, $5))
     INSERT INTO site_memory_item_versions (item_id, version, statement, actor_user_id, actor_kind, created_at)
     SELECT $1, g.n, 'site ' || g.n, $6, 'user', g.at
       FROM unnest($7::timestamptz[]) WITH ORDINALITY AS g(at, n)`,
    [
      id,
      statusOf(spec),
      spec.supersededBy ?? null,
      ages.length,
      ago(spec.updated ?? 0),
      spec.actor ?? ids.admin,
      ages.map(ago),
    ],
  );
  return id;
}

export async function portable(owner: string, spec: Omit<ItemSpec, "owner"> = {}): Promise<string> {
  const id = randomUUID();
  const ages = spec.versions ?? [1];
  await h.admin.query(
    `WITH i AS (
       INSERT INTO portable_memory_items (id, owner_user_id, kind, status, superseded_by, current_version, updated_at)
       VALUES ($1, $2, 'preference', $3, $4, $5, $6))
     INSERT INTO portable_memory_item_versions (item_id, version, statement, actor_user_id, actor_kind, created_at)
     SELECT $1, g.n, 'prefers ' || g.n, $2, 'user', g.at
       FROM unnest($7::timestamptz[]) WITH ORDINALITY AS g(at, n)`,
    [
      id,
      owner,
      statusOf(spec),
      spec.supersededBy ?? null,
      ages.length,
      ago(spec.updated ?? 0),
      ages.map(ago),
    ],
  );
  return id;
}

export const TABLES = {
  ws: "semantic_memory_item_versions",
  site: "site_memory_item_versions",
  portable: "portable_memory_item_versions",
} as const;
export const versionsOf = async (lane: keyof typeof TABLES, id: string) =>
  (
    await h.admin.query<{ version: number }>(
      `SELECT version FROM ${TABLES[lane]} WHERE item_id = $1 ORDER BY version`,
      [id],
    )
  ).rows.map((r) => r.version);

export async function audits(action: string) {
  const { rows } = await h.admin.query<{
    target: Record<string, unknown>;
    actor_id: string | null;
  }>(`SELECT target, actor_id FROM audit_log WHERE action = $1 AND seq > $2 ORDER BY seq`, [
    action,
    auditFloor,
  ]);
  return rows;
}
export const sum = (rows: { target: Record<string, unknown> }[], key: string) =>
  rows.reduce((n, r) => n + Number(r.target[key] ?? 0), 0);

export async function setPeriod(period: string | null): Promise<void> {
  if (period === null) return void (await h.admin.query(`DELETE FROM team_retention`));
  await h.admin.query(
    `INSERT INTO team_retention (team_id, period, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (team_id) DO UPDATE SET period = EXCLUDED.period`,
    [team, period, ids.alice],
  );
}

export async function placeHold(userId: string | null): Promise<string> {
  const { rows } = await h.admin.query<{ id: string }>(
    `INSERT INTO legal_holds (team_id, user_id, reason, placed_by) VALUES ($1, $2, 'matter 386', $3)
     RETURNING id`,
    [team, userId, ids.admin],
  );
  const id = rows[0]?.id ?? "";
  await h.admin.query(`UPDATE legal_holds SET status = 'active', approved_by = $2 WHERE id = $1`, [
    id,
    ids.owner,
  ]);
  return id;
}

export async function placeSiteHold(): Promise<void> {
  const { rows } = await h.admin.query<{ id: string }>(
    `INSERT INTO site_legal_holds (reason, placed_by) VALUES ('Site matter 386', $1) RETURNING id`,
    [ids.admin],
  );
  await h.admin.query(
    `UPDATE site_legal_holds SET status = 'active', approved_by = $2 WHERE id = $1`,
    [rows[0]?.id, ids.owner],
  );
}

export async function clearHolds(): Promise<void> {
  for (const table of ["legal_holds", "site_legal_holds"]) {
    const { rows } = await h.admin.query<{ id: string }>(
      `SELECT id FROM ${table} WHERE status = 'active'`,
    );
    for (const { id } of rows) {
      await h.admin.query(
        `UPDATE ${table} SET release_requested_by = $2, release_requested_at = now(),
           release_reason = 'matter closed' WHERE id = $1`,
        [id, ids.admin],
      );
      await h.admin.query(
        `UPDATE ${table} SET status = 'released', released_by = $2 WHERE id = $1`,
        [id, ids.owner],
      );
    }
  }
}

export async function member(userId: string, on: boolean): Promise<void> {
  if (on)
    await h.admin.query(
      `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`,
      [team, userId],
    );
  else
    await h.admin.query(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [
      team,
      userId,
    ]);
}

export const exists = async (table: string, id: string) =>
  (await h.admin.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id])).rowCount === 1;

/**
 * Registers the shared hooks; call once at the top level of each
 * semantic-memory-retention.*.db.test.ts file.
 */
export function useSemanticMemoryRetentionHarness(): void {
  beforeAll(async () => {
    h = await openHarness();
    ids.owner = await h.createUser("owner@smret.test", "owner");
    ids.admin = await h.createUser("admin@smret.test", "admin");
    for (const who of ["alice", "bob", "carol", "dora", "erin", "finn"] as const)
      ids[who] = await h.createUser(`${who}@smret.test`);
    team = randomUUID();
    await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, 'smret', 'SMRet')`, [team]);
    await h.admin.query(
      `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'team_admin')`,
      [team, ids.owner],
    );
    as.admin = await h.signIn("admin@smret.test");
  }, 120_000);

  afterAll(() => h?.close());

  beforeEach(async () => {
    await clearHolds();
    await setPeriod(null);
    for (const who of ["alice", "bob", "carol", "dora", "erin"] as const)
      await member(ids[who], true);
    await h.admin.query(`UPDATE users SET deactivated_at = NULL, deactivated_via = NULL`);
    await h.admin.query(`DELETE FROM semantic_memory_items WHERE team_id = $1`, [team]);
    await h.admin.query(`DELETE FROM portable_memory_items`);
    await h.admin.query(`DELETE FROM site_memory_items`);
    await h.admin.query(`DELETE FROM sandboxes WHERE team_id = $1`, [team]);
    await h.admin.query(
      `INSERT INTO site_settings (key, value) VALUES ('memory.settings', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify({ retention_days: 30 })],
    );
    auditFloor = Number(
      (await h.admin.query<{ n: string }>(`SELECT coalesce(max(seq), 0) AS n FROM audit_log`))
        .rows[0]?.n,
    );
  });
}
