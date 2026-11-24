import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTeam } from "@kaiju/db";
import { readRunCandidates } from "../../memory/items/run-memory.js";
import { recallItems } from "../../memory/items/recall-items.js";
import { startVectorLeg } from "../../memory/items/vector-leg.js";
import { documentText, queryText, storedVectorModel } from "../../memory/embeddings/prefixes.js";
import { vectorLiteral } from "../../memory/embeddings/vector-store.js";
import { embedTexts, endpointFromEnv, quantile } from "./embed-endpoint.js";
import { openHarness, type Harness } from "../harness.js";
import {
  RANK_MODES,
  formatRelevanceReport,
  parseRelevanceSet,
  rankCandidates,
  scoreQuery,
  summarise,
  type QueryResult,
  type RankMode,
  type RelevanceItem,
} from "./score.js";

/**
 * `e2e/memory-eval.sh relevance` (KOBE-387): seeds e2e/fixtures/memory-relevance/items.json into a
 * throwaway database (createTestDatabase: created and dropped on KOBE_TEST_DATABASE_URL's server)
 * over the split tables (Workspace + person: semantic_memory_items, portable_memory_items,
 * site_memory_items), asks the KOBE-382 selector's own store read (`readRunCandidates`) about every
 * query in queries.json as a run's message, and reports recall@8. Not part of `pnpm verify`
 * (vitest.eval.config.ts). Writes the report as JSON to KOBE_EVAL_OUT when set.
 *
 * KOBE-409 hybrid mode: with KOBE_EVAL_EMBED_URL and KOBE_EVAL_EMBED_MODEL (embed-endpoint.ts)
 * every statement is embedded once (with the model's document prefix) and each query too (timed:
 * per-message embed latency), and the report compares keyword-only with hybrid (the selector's
 * vector leg, `startVectorLeg`, given the query vector) on the same candidates code.
 *
 * KOBE-664: every query is also asked as `recall({ query })` (`recallItems`, the tool's own code:
 * keyword-only in the first report, hybrid with the same query vector in the second), and both
 * reports carry its recall@8 in a "recall tool" column beside the selector's numbers.
 */
const endpoint = endpointFromEnv(process.env);
/** Database id → where its version lives, for the hybrid mode's vectors. */
const seeded: { id: string; scope: RelevanceItem["scope"]; statement: string }[] = [];
const FIXTURES = new URL("../../../../../e2e/fixtures/memory-relevance/", import.meta.url);
const read = (f: string): unknown => JSON.parse(readFileSync(new URL(f, FIXTURES), "utf8"));
const set = parseRelevanceSet(read("items.json"), read("queries.json"));

/** Straight to stdout: the report is the output, whatever vitest does with console logs. */
const say = (text: string) => writeSync(1, `${text}\n`);

let h: Harness;
const team = randomUUID();
let runner = "";
let threadId = "";
let runId = "";
/** Database id → fixture id. */
const fixtureOf = new Map<string, string>();

async function seedItem(item: RelevanceItem): Promise<void> {
  const id = randomUUID();
  fixtureOf.set(id, item.id);
  seeded.push({ id, scope: item.scope, statement: item.statement });
  const q = (text: string, params: unknown[]) => h.admin.query(text, params);
  const age = `${item.age_days} days`;
  if (item.scope === "team" || item.scope === "user") {
    await q(
      `INSERT INTO semantic_memory_items (team_id, id, scope, owner_user_id, kind, current_version)
       VALUES ($1, $2, $3, $4, $5, 1)`,
      [team, id, item.scope, item.scope === "user" ? runner : null, item.kind],
    );
    await q(
      `INSERT INTO semantic_memory_item_versions
         (team_id, item_id, version, statement, actor_user_id, actor_kind, created_at)
       VALUES ($1, $2, 1, $3, $4, 'user', now() - $5::interval)`,
      [team, id, item.statement, runner, age],
    );
  } else if (item.scope === "portable") {
    await q(`INSERT INTO portable_memory_items (id, owner_user_id, kind) VALUES ($1, $2, $3)`, [
      id,
      runner,
      item.kind,
    ]);
    await q(
      `INSERT INTO portable_memory_item_versions
         (item_id, version, statement, actor_user_id, actor_kind, created_at)
       VALUES ($1, 1, $2, $3, 'user', now() - $4::interval)`,
      [id, item.statement, runner, age],
    );
  } else {
    await q(
      `INSERT INTO site_memory_items (id, kind, policy, pinned) VALUES ($1, $2, false, false)`,
      [id, item.kind],
    );
    await q(
      `INSERT INTO site_memory_item_versions
         (item_id, version, statement, actor_user_id, actor_kind, created_at)
       VALUES ($1, 1, $2, $3, 'user', now() - $4::interval)`,
      [id, item.statement, runner, age],
    );
  }
}

beforeAll(async () => {
  h = await openHarness();
  runner = await h.createUser("eval@relevance.test");
  await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, 'eval', 'Eval')`, [team]);
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`,
    [team, runner],
  );
  await h.admin.query("BEGIN");
  for (const item of set.items) await seedItem(item);
  // An untitled thread with no agent or project and one running message run: the query is the
  // message alone (no earlier messages, no stickiness: nothing is ever recorded).
  const thread = await h.admin.query(
    `INSERT INTO threads (team_id, owner_user_id, status) VALUES ($1, $2, 'running') RETURNING id`,
    [team, runner],
  );
  threadId = (thread.rows[0] as { id: string }).id;
  const run = await h.admin.query(
    `INSERT INTO runs (team_id, thread_id, trigger, status, started_at)
     VALUES ($1, $2, 'user', 'running', now()) RETURNING id`,
    [team, threadId],
  );
  runId = (run.rows[0] as { id: string }).id;
  await h.admin.query("COMMIT");
  if (endpoint) await embedAll();
  await h.admin.query("ANALYZE");
}, 600_000);

const TABLE: Record<RelevanceItem["scope"], string> = {
  user: "semantic_memory_item_versions",
  team: "semantic_memory_item_versions",
  portable: "portable_memory_item_versions",
  site: "site_memory_item_versions",
};

/** Hybrid mode: every statement's vector, stored as embed on save would. */
async function embedAll(): Promise<void> {
  if (!endpoint) return;
  const vectors = await embedTexts(
    endpoint,
    seeded.map((s) => documentText(endpoint.storedModel, s.statement)),
  );
  for (const [i, s] of seeded.entries()) {
    const v = vectors[i] ?? [];
    await h.admin.query(
      `UPDATE ${TABLE[s.scope]} SET embedding = $1::vector, embedding_model = $2, embedding_dims = $3
        WHERE item_id = $4 AND version = 1`,
      [vectorLiteral(v), storedVectorModel(endpoint.storedModel), v.length, s.id],
    );
  }
}

afterAll(async () => {
  await h?.close();
});

describe("memory relevance eval (KOBE-387)", () => {
  it("reports recall@8 per kind and overall", async () => {
    const results: QueryResult[] = [];
    const hybrid: QueryResult[] = [];
    const latencies: number[] = [];
    const lanesSeen = new Set<string>();
    const toFixture = (ids: readonly string[]) => ids.map((id) => fixtureOf.get(id) ?? id);
    const db = h.deps.database.db;
    for (const q of set.queries) {
      const input = { teamId: team, userId: runner, threadId, runId, message: q.query };
      const { candidates, semantic } = await withTeam(db, team, (tx) =>
        readRunCandidates(tx, input),
      );
      const recalled = toFixture(((await recallItems(db, input, q.query)) ?? []).map((i) => i.id));
      if (endpoint) {
        const t0 = performance.now();
        const [vector] = await embedTexts(endpoint, [queryText(endpoint.storedModel, q.query)]);
        latencies.push(performance.now() - t0);
        const query = { model: endpoint.storedModel, vector: vector ?? [] };
        // The leg's own deadline is lifted here: this measures ranking, not latency.
        const vectorLeg = () => startVectorLeg(db, input, Promise.resolve(query), 60_000);
        const h2 = await withTeam(db, team, (tx) => readRunCandidates(tx, { ...input, vectorLeg }));
        const ranked2 = Object.fromEntries(
          RANK_MODES.map((m) => [m, toFixture(rankCandidates(h2.candidates, m))]),
        ) as Record<RankMode, string[]>;
        // The recall tool with the same query vector (the gateway call is replaced, not the code).
        const recallHybrid = await recallItems(db, input, q.query, {
          recallVector: () => Promise.resolve(query),
        });
        const recall = toFixture((recallHybrid ?? []).map((i) => i.id));
        hybrid.push(
          scoreQuery(
            q,
            { ...ranked2, recall },
            new Set(toFixture(h2.semantic.items.map((i) => i.id))),
          ),
        );
      }
      for (const lane of Object.keys(candidates)) lanesSeen.add(lane);
      const ranked = Object.fromEntries(
        RANK_MODES.map((m) => [m, toFixture(rankCandidates(candidates, m))]),
      ) as Record<RankMode, string[]>;
      const block = new Set(toFixture(semantic.items.map((i) => i.id)));
      results.push(scoreQuery(q, { ...ranked, recall: recalled }, block));
    }
    // Every lane must have been read, or the numbers measure a switched-off store.
    expect([...lanesSeen].sort()).toEqual(["portable", "site", "team", "user"]);
    const report = summarise(results, set.queries);
    say(
      `\nKAIJU-387 memory relevance: ${set.items.length} items, ${set.queries.length} queries\n\n${formatRelevanceReport(report)}\n`,
    );
    const misses = results
      .filter((r) => r.recall.relevance < 1)
      .map((r) => `${r.id} ${r.kind}/${r.style} ranks ${r.ranks.map((x) => x ?? "-").join(",")}`);
    say(`Misses (${misses.length}): ${misses.join("; ")}\n`);
    const hybridReport = endpoint ? summarise(hybrid, set.queries) : undefined;
    if (endpoint && hybridReport) {
      say(
        `\nKAIJU-409 hybrid (${endpoint.model}): keyword-only recall@8 ${report.overall.relevance.toFixed(3)} → hybrid ${hybridReport.overall.relevance.toFixed(3)}; ` +
          `KOBE-664 recall tool ${(report.overall.recallTool ?? 0).toFixed(3)} → hybrid ${(hybridReport.overall.recallTool ?? 0).toFixed(3)}; ` +
          `query embed latency p50 ${quantile(latencies, 0.5).toFixed(1)} ms, p95 ${quantile(latencies, 0.95).toFixed(1)} ms\n\n${formatRelevanceReport(hybridReport)}\n`,
      );
    }
    const out = process.env.KOBE_EVAL_OUT;
    if (out) {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(
        out,
        JSON.stringify(
          {
            report,
            results,
            ...(hybridReport
              ? {
                  hybrid: { model: endpoint?.model, report: hybridReport, results: hybrid },
                  embedLatencyMs: {
                    p50: quantile(latencies, 0.5),
                    p95: quantile(latencies, 0.95),
                  },
                }
              : {}),
          },
          null,
          2,
        ),
      );
    }
    expect(results).toHaveLength(set.queries.length);
  }, 600_000);
});
