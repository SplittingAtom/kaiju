import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordModelUsage, runs, threads, withTeam, type ModelUsageRecord } from "@kaiju/db";
import { runWithAuditContext } from "../audit/context.js";
import { pendingVersions, readCoverage } from "../memory/embeddings/vector-store.js";
import { readVectorRows } from "../memory/items/vector-leg.js";
import {
  MEMORY_SITE_SETTINGS_KEY,
  readMemorySiteSettings,
  writeMemorySiteSettings,
} from "../memory/site-settings.js";
import { createTeamWithAdmin } from "../teams/members.js";
import { openHarness, type Harness } from "../testing/harness.js";
import { runsUsage, siteUsage, teamUsage, threadUsage } from "./usage-store.js";

/**
 * KOBE-828 (RN-15): the in-cluster models are `kaiju-local/<model>` now, `kobe-local/<model>`
 * before. `run_usage` is append-only, so calls made before the upgrade keep the old id: every
 * usage report groups both as one model (ac-2). Vectors made under the old id stay current, so
 * the rename never sends memory to be embedded again, and an old id in the embedding setting
 * (written by a pod of the previous release) reads as the current model.
 */
const OLD = "kobe-local";
const NEW = "kaiju-local";
let h: Harness;
let user = "";
let team = "";
let run = "";
let thread = "";

const asUser = <T>(userId: string, fn: () => Promise<T>) =>
  runWithAuditContext({ actor: { kind: "user", id: userId }, ip: null, userAgent: null }, fn);

const call = (model: string, at: Date, over: Partial<ModelUsageRecord> = {}): ModelUsageRecord => ({
  id: randomUUID(),
  teamId: team,
  userId: user,
  sandboxId: randomUUID(),
  runId: run,
  at,
  route: "openai",
  model,
  status: 200,
  inputTokens: 1000,
  outputTokens: 10,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  usageSource: "reported",
  durationMs: 900,
  ttfbMs: 100,
  aborted: false,
  ...over,
});

beforeAll(async () => {
  h = await openHarness({ models: { providerKeySecrets: ["p".repeat(40)] } });
  user = await h.createUser("local-rename@usage.test");
  const db = h.deps.database.db;
  team = (
    await asUser(user, () => createTeamWithAdmin(db, { slug: "local-rename", name: "LR" }, user))
  ).id;
  ({ run, thread } = await withTeam(db, team, async (tx) => {
    const [t] = await tx
      .insert(threads)
      .values({ teamId: team, ownerUserId: user })
      .returning({ id: threads.id });
    if (!t) throw new Error("no thread");
    const [r] = await tx
      .insert(runs)
      .values({
        teamId: team,
        threadId: t.id,
        trigger: "user",
        status: "completed",
        userEntryId: "e-1",
        startedAt: new Date(),
        endedAt: new Date(),
      })
      .returning({ id: runs.id });
    if (!r) throw new Error("no run");
    return { run: r.id, thread: t.id };
  }));
  const before = new Date(Date.now() - 60_000);
  // Two calls before the upgrade (old id), one after (new id), one of another model.
  await recordModelUsage(db, [
    call(`${OLD}/qwen3`, before),
    call(`${OLD}/qwen3`, new Date(before.getTime() + 1000)),
    call(`${NEW}/qwen3`, new Date()),
    call("openai/gpt-5", new Date(before.getTime() + 2000)),
  ]);
}, 120_000);
afterAll(() => h.close());

const range = () => ({
  from: new Date(Date.now() - 3_600_000),
  to: new Date(Date.now() + 60_000),
  bucket: "hour" as const,
});

describe("usage reports across the kaiju-local rename (KOBE-828 ac-2)", () => {
  it("groups the old and new ids as one model in the team and site reports", async () => {
    const db = h.deps.database.db;
    for (const report of [await teamUsage(db, team, range()), await siteUsage(db, range())]) {
      const byModel = Object.fromEntries(report.by_model.map((m) => [m.model, m.calls]));
      expect(byModel).toEqual({ [`${NEW}/qwen3`]: 3, "openai/gpt-5": 1 });
    }
  });

  it("names the current id in a run's and a thread's usage", async () => {
    const db = h.deps.database.db;
    const [usage] = await runsUsage(db, team, { runId: run });
    expect(usage?.models).toEqual([`${NEW}/qwen3`, "openai/gpt-5"]);
    const latest = (await threadUsage(db, team, thread)).latest_call;
    expect(latest?.model).toBe(`${NEW}/qwen3`);
  });
});

describe("vectors across the kaiju-local rename (no re-embedding)", () => {
  const model = `${NEW}/nomic-embed-text`;
  let item = "";

  beforeAll(async () => {
    // A vector stored under the old id (by a server of the previous release, during the roll).
    const res = await h.admin.query<{ id: string }>(
      `WITH i AS (INSERT INTO semantic_memory_items (team_id, scope, kind)
                  VALUES ($1, 'team', 'fact') RETURNING team_id, id)
       INSERT INTO semantic_memory_item_versions (team_id, item_id, version, statement,
         actor_kind, actor_user_id, embedding, embedding_model, embedding_dims)
       SELECT team_id, id, 1, 'The fiscal year starts in April', 'user', $2, '[1,0,0]', $3, 3
         FROM i RETURNING item_id AS id`,
      [team, user, `${OLD}/nomic-embed-text#d2`],
    );
    item = res.rows[0]?.id ?? "";
  });

  it("counts it as current: nothing pending, fully covered", async () => {
    const db = h.deps.database.db;
    const pending = await withTeam(db, team, (tx) =>
      pendingVersions(tx, "workspace", { teamId: team, model, limit: 10 }),
    );
    expect(pending).toEqual([]);
    const other = await withTeam(db, team, (tx) =>
      pendingVersions(tx, "workspace", { teamId: team, model: "openai/emb", limit: 10 }),
    );
    expect(other.map((p) => p.itemId)).toEqual([item]);
    const coverage = await readCoverage(db, model);
    expect(coverage.embedded).toBeGreaterThanOrEqual(1);
    expect(coverage.embedded).toBe(coverage.total);
  });

  it("ranks it in search by meaning", async () => {
    const rows = await readVectorRows(
      h.deps.database.db,
      { teamId: team, userId: user },
      { model, vector: [1, 0, 0] },
    );
    expect(rows.map((r) => r.id)).toContain(item);
  });

  it("reads an old id in the embedding setting as the current model, and saving it changes nothing", async () => {
    await h.admin.query(
      `INSERT INTO site_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [MEMORY_SITE_SETTINGS_KEY, JSON.stringify({ embedding_model: `${OLD}/nomic-embed-text` })],
    );
    const db = h.deps.database.db;
    expect((await readMemorySiteSettings(db)).embedding_model).toBe(model);
    const written = await db.transaction((tx) =>
      writeMemorySiteSettings(tx, { embedding_model: `${OLD}/nomic-embed-text` }, new Set([NEW])),
    );
    expect(written).toMatchObject({ ok: true, changed: [] });
  });
});
