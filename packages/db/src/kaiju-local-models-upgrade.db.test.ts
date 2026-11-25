import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import { runMigrations } from "./migrate.js";
import {
  gatewayProviderName,
  loadGatewayPrices,
  loadGatewayPrincipal,
  loadMemberBudgetState,
  recordModelUsage,
} from "./models/index.js";
import {
  createTestDatabase,
  migrationsBefore,
  serverHasPgvector,
  testServerUrl,
  type TestDatabase,
} from "./test-support/database.js";
import { withTeam } from "./with-team.js";

/**
 * KOBE-828 (RN-15) as an upgrade runs it (the owner role) over a populated database: the chart's
 * in-cluster provider (`local`) is `kaiju-local` now, so the stored gateway ids `kobe-local/...`
 * are rewritten (the Site embedding model, the vectors' model without touching the vectors, Orbit
 * evals still to run), while history (`run_usage`, finished evals) keeps them. Catalog entries,
 * team defaults and agent pins name aliases, so agents keep their model; prices, usage cost and
 * budget spend cover calls under both ids (ac-1, ac-2).
 */
const MARKER = "-- KOBE-828 (rename step RN-15";
const OLD = "kobe-local";
const NEW = "kaiju-local";

const pgvector = await serverHasPgvector(testServerUrl());

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

const ids = {
  user: randomUUID(),
  team: randomUUID(),
  agent: randomUUID(),
  semantic: randomUUID(),
  portable: randomUUID(),
  site: randomUUID(),
  pendingEval: randomUUID(),
  passedEval: randomUUID(),
  oldUsage: randomUUID(),
};

let older = "";
let db: TestDatabase;

const VECTOR = "[0.1,0.2,0.3]";

async function populate(): Promise<void> {
  await withClient(db.adminUrl, async (c) => {
    await c.query(`INSERT INTO users (id, name, email) VALUES ($1, 'U', $2)`, [
      ids.user,
      `u-${ids.user.slice(0, 8)}@upgrade.test`,
    ]);
    await c.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'A')`, [
      ids.team,
      `a${ids.team.slice(0, 8)}`,
    ]);
    await c.query(
      `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'team_admin')`,
      [ids.team, ids.user],
    );
    // A Site console provider with the reserved id (an install whose chart runs no local model).
    await c.query(
      `INSERT INTO model_providers (id, kind, name, base_url, allow_private_network, api_key_enc,
         created_by)
       VALUES ('local', 'openai_compatible', 'Local', 'http://10.0.0.5:8080/v1', true, NULL, $1),
              ('openai', 'openai', 'OpenAI', NULL, false, 'sealed', $1)`,
      [ids.user],
    );
    await c.query(
      `INSERT INTO model_catalog (alias, provider_id, model, created_by, input_usd_per_mtok,
         output_usd_per_mtok)
       VALUES ('local-chat', 'local', 'qwen3', $1, 1, 2), ('gpt', 'openai', 'gpt-5', $1, 3, 4)`,
      [ids.user],
    );
    await c.query(
      `INSERT INTO team_models (team_id, alias, is_default, enabled_by)
       VALUES ($1, 'local-chat', true, $2), ($1, 'gpt', false, $2)`,
      [ids.team, ids.user],
    );
    await c.query(
      `INSERT INTO team_agents (team_id, id, owner_user_id, slug, frontmatter)
       VALUES ($1, $2, $3, 'agent', $4)`,
      [ids.team, ids.agent, ids.user, JSON.stringify({ name: "A", model: "local-chat" })],
    );
    await c.query(
      `INSERT INTO team_budgets (team_id, user_id, monthly_usd, updated_by) VALUES ($1, NULL, 100, $2)`,
      [ids.team, ids.user],
    );
    await c.query(
      `INSERT INTO site_settings (key, value) VALUES ('memory.settings', $1), ('unrelated', $2)`,
      [
        JSON.stringify({ embedding_model: `${OLD}/nomic-embed-text`, learning_model_alias: "gpt" }),
        `${OLD}/kept-as-is`,
      ],
    );
    // Memory items with a vector each (where pgvector is), one of another provider's model.
    await c.query(
      `WITH i AS (INSERT INTO semantic_memory_items (team_id, id, scope, kind)
                  VALUES ($1, $2, 'team', 'fact') RETURNING team_id, id)
       INSERT INTO semantic_memory_item_versions (team_id, item_id, version, statement,
         actor_kind, actor_user_id)
       SELECT team_id, id, 1, 'The fiscal year starts in April', 'user', $3 FROM i`,
      [ids.team, ids.semantic, ids.user],
    );
    await c.query(
      `WITH i AS (INSERT INTO portable_memory_items (id, owner_user_id, kind)
                  VALUES ($1, $2, 'preference') RETURNING id)
       INSERT INTO portable_memory_item_versions (item_id, version, statement, actor_kind,
         actor_user_id)
       SELECT id, 1, 'Answer briefly', 'user', $2 FROM i`,
      [ids.portable, ids.user],
    );
    await c.query(
      `WITH i AS (INSERT INTO site_memory_items (id, kind) VALUES ($1, 'fact') RETURNING id)
       INSERT INTO site_memory_item_versions (item_id, version, statement, actor_kind,
         actor_user_id)
       SELECT id, 1, 'Offices close at six', 'user', $2 FROM i`,
      [ids.site, ids.user],
    );
    if (pgvector) {
      for (const [table, id, model] of [
        ["semantic_memory_item_versions", ids.semantic, `${OLD}/nomic-embed-text#d2`],
        ["portable_memory_item_versions", ids.portable, `${OLD}/nomic-embed-text#d2`],
        ["site_memory_item_versions", ids.site, "openai/text-embedding-3-small"],
      ] as const)
        await c.query(
          `UPDATE ${table} SET embedding = $2, embedding_model = $3, embedding_dims = 3
            WHERE item_id = $1`,
          [id, VECTOR, model],
        );
    }
    // Orbit evals: one still to run, one finished (history).
    const definition = JSON.stringify({ frontmatter: { name: "A", model: `${OLD}/qwen3` } });
    await c.query(
      `INSERT INTO orbit_evals (id, team_id, agent_id, agent_scope, agent_slug, requested_by,
         draft_revision, definition, model, threshold, status)
       VALUES ($1, $2, $3, 'team', 'agent', $4, 1, $5, $6, 0.1, 'pending')`,
      [ids.pendingEval, ids.team, ids.agent, ids.user, definition, `${OLD}/qwen3`],
    );
    await c.query(
      `INSERT INTO orbit_evals (id, team_id, agent_id, agent_scope, agent_slug, requested_by,
         draft_revision, definition, model, threshold, status, attack_success_rate, finished_at)
       VALUES ($1, $2, $3, 'team', 'agent', $4, 1, $5, $6, 0.1, 'passed', 0, now())`,
      [ids.passedEval, ids.team, ids.agent, ids.user, definition, `${OLD}/qwen3`],
    );
    // A call made before the upgrade, priced then (append-only history).
    await c.query(
      `INSERT INTO run_usage (team_id, id, user_id, kind, route, model, status, input_tokens,
         output_tokens, usage_source, cost_usd, duration_ms)
       VALUES ($1, $2, $3, 'memory_embed', 'openai', $4, 200, 1000000, 0, 'reported', 1, 5)`,
      [ids.team, ids.oldUsage, ids.user, `${OLD}/qwen3`],
    );
  });
}

beforeAll(async () => {
  older = migrationsBefore(MARKER);
  db = await createTestDatabase(testServerUrl(), { migrationsFolder: older });
  await populate();
  await runMigrations({ databaseUrl: db.ownerUrl, appRole: db.appRole });
  // Again: the migrate job of every release runs them all; a second run changes nothing.
  await runMigrations({ databaseUrl: db.ownerUrl, appRole: db.appRole });
}, 240_000);

afterAll(async () => {
  await db?.drop();
  if (older) rmSync(older, { recursive: true, force: true });
});

const rows = (sql: string, params: unknown[] = []) =>
  withClient(db.adminUrl, async (c) => (await c.query(sql, params)).rows);

describe("the kaiju-local rename on a populated database (KOBE-828)", () => {
  it("names the provider `local` kaiju-local and leaves every other name as it was", () => {
    expect(gatewayProviderName("local", "openai_compatible")).toBe(NEW);
    const providerId = "lan";
    expect(gatewayProviderName(providerId, "openai_compatible")).toBe(`kobe-${providerId}`);
    expect(gatewayProviderName("openai", "openai")).toBe("openai");
  });

  it("rewrites the Site embedding model and nothing else in the settings", async () => {
    const settings = await rows(`SELECT key, value FROM site_settings ORDER BY key`);
    const memory = settings.find((r) => r.key === "memory.settings");
    expect(JSON.parse(String(memory?.value))).toEqual({
      embedding_model: `${NEW}/nomic-embed-text`,
      learning_model_alias: "gpt",
    });
    expect(settings.find((r) => r.key === "unrelated")?.value).toBe(`${OLD}/kept-as-is`);
  });

  it.skipIf(!pgvector)("renames the vectors' model and keeps the vectors", async () => {
    const vectors = await rows(
      `SELECT 'semantic' AS t, embedding_model AS m, embedding::text AS v FROM semantic_memory_item_versions
       UNION ALL SELECT 'portable', embedding_model, embedding::text FROM portable_memory_item_versions
       UNION ALL SELECT 'site', embedding_model, embedding::text FROM site_memory_item_versions
       ORDER BY 1`,
    );
    expect(vectors).toEqual([
      { t: "portable", m: `${NEW}/nomic-embed-text#d2`, v: VECTOR },
      { t: "semantic", m: `${NEW}/nomic-embed-text#d2`, v: VECTOR },
      { t: "site", m: "openai/text-embedding-3-small", v: VECTOR },
    ]);
  });

  it("rewrites an Orbit eval still to run and keeps a finished one as history", async () => {
    const evals = await rows(
      `SELECT id, status, model, definition FROM orbit_evals ORDER BY status`,
    );
    expect(evals.map((e) => [e.status, e.model, e.definition.frontmatter.model])).toEqual([
      ["passed", `${OLD}/qwen3`, `${OLD}/qwen3`],
      ["pending", `${NEW}/qwen3`, `${NEW}/qwen3`],
    ]);
  });

  it("keeps the usage ledger as written (append-only)", async () => {
    expect(await rows(`SELECT model, cost_usd::text AS cost FROM run_usage`)).toEqual([
      { model: `${OLD}/qwen3`, cost: "1.0000000000" },
    ]);
  });

  it("keeps agents on their model: the alias now resolves to kaiju-local", async () => {
    const app = createDb(db.appUrl);
    try {
      const principal = await loadGatewayPrincipal(app.db, ids.team, ids.user, undefined);
      expect([...principal.enabledModels].sort()).toEqual([`${NEW}/qwen3`, "openai/gpt-5"]);
      const agent = await rows(`SELECT frontmatter FROM team_agents WHERE id = $1`, [ids.agent]);
      expect(agent[0]?.frontmatter.model).toBe("local-chat");
      const prices = await loadGatewayPrices(app.db);
      expect(prices.get(`${NEW}/qwen3`)).toEqual({ input: 1, output: 2 });
      expect(prices.has(`${OLD}/qwen3`)).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("prices a call under either id and counts both in the budget's spend", async () => {
    const app = createDb(db.appUrl);
    try {
      const at = new Date();
      const call = (model: string) => ({
        id: randomUUID(),
        teamId: ids.team,
        userId: ids.user,
        sandboxId: undefined,
        runId: undefined,
        kind: "memory_embed" as const,
        at,
        route: "openai" as const,
        model,
        status: 200,
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        usageSource: "reported" as const,
        durationMs: 5,
        ttfbMs: undefined,
        aborted: false,
      });
      // An old pod's call (old id) and a new one: both priced at the catalog's $1 per M input.
      expect(await recordModelUsage(app.db, [call(`${OLD}/qwen3`), call(`${NEW}/qwen3`)])).toBe(2);
      const costs = await rows(
        `SELECT model, cost_usd::text AS cost FROM run_usage WHERE id <> $1 ORDER BY model`,
        [ids.oldUsage],
      );
      expect(costs).toEqual([
        { model: `${NEW}/qwen3`, cost: "1.0000000000" },
        { model: `${OLD}/qwen3`, cost: "1.0000000000" },
      ]);
      const state = await withTeam(app.db, ids.team, (tx) =>
        loadMemberBudgetState(tx, ids.team, ids.user, at),
      );
      const monthly = state.lines.find((l) => l.period === "month" && l.unit === "usd");
      // The pre-upgrade call, the old-id call and the new-id call: one model, one spend.
      expect(monthly?.spent).toBe(3);
    } finally {
      await app.close();
    }
  });

  it("puts FORCE row level security back", async () => {
    const force = await rows(
      `SELECT relname, relforcerowsecurity AS f FROM pg_class WHERE relname = ANY($1) ORDER BY 1`,
      [["orbit_evals", "semantic_memory_item_versions"]],
    );
    expect(force).toEqual([
      { relname: "orbit_evals", f: true },
      { relname: "semantic_memory_item_versions", f: true },
    ]);
  });

  it("leaves the old id only in history: every text, jsonb and array column scanned", async () => {
    const columns = await rows(
      `SELECT table_name AS t, column_name AS c FROM information_schema.columns
        WHERE table_schema = 'public'
          AND data_type IN ('text', 'character varying', 'jsonb', 'json', 'ARRAY')
          AND table_name IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public')
        ORDER BY 1, 2`,
    );
    const found: string[] = [];
    await withClient(db.adminUrl, async (c) => {
      for (const { t, c: col } of columns) {
        const hit = await c.query(
          `SELECT 1 FROM public.${pg.escapeIdentifier(t)} WHERE ${pg.escapeIdentifier(col)}::text LIKE '%' || $1 || '%' LIMIT 1`,
          [`${OLD}/`],
        );
        if (hit.rowCount) found.push(`${t}.${col}`);
      }
    });
    // run_usage: append-only; orbit_evals: the finished eval; site_settings: a value no reader
    // takes as a model (the `unrelated` key above).
    expect(found).toEqual([
      "orbit_evals.definition",
      "orbit_evals.model",
      "run_usage.model",
      "site_settings.value",
    ]);
  });
});
