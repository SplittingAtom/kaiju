import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTeam } from "@kobe/db";
import { runSemanticMemorySchema, semanticMemoryRenderedBytes } from "@kobe/protocol";
import { startVectorLeg } from "./memory/items/vector-leg.js";
import { storedVectorModel } from "./memory/embeddings/prefixes.js";
import { BackgroundTasks } from "./background.js";
import { MemoryEmbeddings, type QueryVector } from "./memory/embeddings/service.js";
import { buildRunSemantic } from "./memory/items/run-memory.js";
import { recordRunMemory } from "./memory/items/run-records.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * KOBE-382 ac-4: the selector at the scope limits (SM21 defaults: 1,000 Workspace items with three
 * versions each, 300 of the runner's own, 50 portable, 1,000 Site items, 25 Policy items at the
 * 2 KiB cap) answers within 50 ms at the 95th percentile, selection only. Numbers go in
 * docs/ledger/KOBE-382.md.
 */
let h: Harness;
const team = randomUUID();
let runner = "";
let threadId = "";
let runId = "";

const WORDS = [
  "deploy",
  "release",
  "customer",
  "invoice",
  "budget",
  "roadmap",
  "incident",
  "oncall",
  "database",
  "migration",
  "frontend",
  "backend",
  "design",
  "review",
  "meeting",
  "friday",
  "security",
  "audit",
  "report",
  "quarterly",
  "pricing",
  "contract",
  "vendor",
  "support",
  "latency",
  "cache",
  "kubernetes",
  "helm",
  "postgres",
  "python",
  "typescript",
  "testing",
];
const VOCAB = `ARRAY[${WORDS.map((w) => `'${w}'`).join(",")}]`;
/** A statement of six vocabulary words and a number, ~70-200 bytes. */
const statement = (g: string) =>
  `'Item ' || ${g} || ': ' || (SELECT string_agg((${VOCAB})[1 + ((${g} * k * 7919) % ${WORDS.length})], ' ') FROM generate_series(1, 6 + ${g} % 20) k)`;

beforeAll(async () => {
  h = await openHarness();
  runner = await h.createUser("perf@select.test");
  await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, 'perf', 'Perf')`, [team]);
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`,
    [team, runner],
  );
  const q = (text: string, params: unknown[] = []) => h.admin.query(text, params);
  await q("BEGIN");
  // Workspace: 1,000 shared items (3 versions each, 10 pinned) and 300 of the runner's own.
  await q(
    `INSERT INTO semantic_memory_items (team_id, id, scope, owner_user_id, kind, pinned, current_version)
     SELECT $1, gen_random_uuid(), CASE WHEN g <= 1000 THEN 'team' ELSE 'user' END,
            CASE WHEN g <= 1000 THEN NULL ELSE $2::uuid END,
            (ARRAY['fact','convention','decision','preference'])[1 + g % 4], g % 100 = 0, 3
       FROM generate_series(1, 1300) g`,
    [team, runner],
  );
  await q(
    `INSERT INTO semantic_memory_item_versions (team_id, item_id, version, statement, actor_user_id, actor_kind, created_at)
     SELECT i.team_id, i.id, v, ${statement("x.g")}, $2, 'user', now() - (x.g % 400) * interval '1 day'
       FROM (SELECT id, team_id, row_number() OVER (ORDER BY id) AS g FROM semantic_memory_items WHERE team_id = $1) x
       JOIN semantic_memory_items i ON i.team_id = x.team_id AND i.id = x.id
       CROSS JOIN generate_series(1, 3) v`,
    [team, runner],
  );
  // Portable: 50 preferences of the runner.
  await q(
    `WITH i AS (INSERT INTO portable_memory_items (id, owner_user_id, kind)
                SELECT gen_random_uuid(), $1, 'preference' FROM generate_series(1, 50) RETURNING id)
     INSERT INTO portable_memory_item_versions (item_id, version, statement, actor_user_id, actor_kind)
     SELECT id, 1, ${statement("x.g")}, $1, 'user'
       FROM (SELECT id, row_number() OVER (ORDER BY id) AS g FROM i) x`,
    [runner],
  );
  // Site: 1,000 items and 25 Policy items of 80 bytes (2,000 bytes, under the 2 KiB cap).
  await q(
    `WITH i AS (INSERT INTO site_memory_items (id, kind, policy, pinned)
                SELECT gen_random_uuid(), 'fact', g > 1000, g % 100 = 0 AND g <= 1000
                  FROM generate_series(1, 1025) g RETURNING id, policy)
     INSERT INTO site_memory_item_versions (item_id, version, statement, actor_user_id, actor_kind)
     SELECT id, 1, CASE WHEN policy THEN rpad('Policy ' || x.g, 80, '.') ELSE ${statement("x.g")} END, $1, 'user'
       FROM (SELECT id, policy, row_number() OVER (ORDER BY id) AS g FROM i) x`,
    [runner],
  );
  const thread = await q(
    `INSERT INTO threads (team_id, owner_user_id, status, title) VALUES ($1, $2, 'running', 'Release planning')
     RETURNING id`,
    [team, runner],
  );
  threadId = (thread.rows[0] as { id: string }).id;
  const runs = await q(
    `INSERT INTO runs (team_id, thread_id, trigger, status, created_at, started_at, ended_at)
     VALUES ($1, $2, 'user', 'completed', now() - interval '1 minute', now() - interval '1 minute', now()),
            ($1, $2, 'user', 'running', now(), now(), NULL)
     RETURNING id, status`,
    [team, threadId],
  );
  await q("COMMIT");
  await q("ANALYZE");
  const rows = runs.rows as { id: string; status: string }[];
  const previous = rows.find((r) => r.status === "completed")?.id ?? "";
  runId = rows.find((r) => r.status === "running")?.id ?? "";
  // The previous run's records make some items sticky.
  const given = await build(previous, "deploy release friday");
  await withTeam(h.deps.database.db, team, (tx) =>
    recordRunMemory(tx, team, previous, given.items),
  );
});

afterAll(async () => {
  await h?.close();
});

/** One selection, as delivery runs it (records are written later, once the start is accepted). */
const build = async (
  run: string,
  message: string,
  queryVector?: number[] | Promise<QueryVector | undefined>,
) => {
  const out = await withTeam(h.deps.database.db, team, (tx) =>
    buildRunSemantic(tx, {
      teamId: team,
      userId: runner,
      threadId,
      runId: run,
      message,
      ...(queryVector
        ? {
            vectorLeg: () =>
              startVectorLeg(
                h.deps.database.db,
                { teamId: team, userId: runner },
                Array.isArray(queryVector)
                  ? Promise.resolve({ model: VECTOR_MODEL, vector: queryVector })
                  : queryVector,
              ),
          }
        : {}),
    }),
  );
  if (out === undefined) throw new Error("no selection");
  return out.semantic;
};

const message = (i: number) => MESSAGES[i % MESSAGES.length] ?? "hello";
const MESSAGES = [
  "What did we decide about the database migration and the release on friday?",
  "Draft the quarterly security audit report for the customer",
  "hello",
  "Which vendor contract covers kubernetes and helm support pricing?",
  "Summarise the incident review: latency, cache and the oncall rota",
];

/**
 * The target is 50 ms (ac-4), measured with this file run alone (`KOBE_PERF_STRICT=1`; numbers in
 * the ledger). Under `pnpm verify` many suites share the CPUs and the database, so the default
 * bound only catches a regression of several times.
 */
const P95_MAX_MS = process.env.KOBE_PERF_STRICT === "1" ? 50 : 200;

const VECTOR_MODEL = "kobe-local/nomic-embed-text";
/** The keyword-only p95 of the run above (the hybrid bound is relative to it). */
let keywordP95 = 0;
const DIMS = 768;
const randomVector = () => Array.from({ length: DIMS }, () => Math.random() - 0.5);

describe("selector performance at scope limits (ac-4)", () => {
  it(`answers within ${P95_MAX_MS} ms at p95, selection only`, async () => {
    for (let i = 0; i < 10; i++) await build(runId, message(i));
    const times: number[] = [];
    let last;
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now();
      last = await build(runId, message(i));
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const p = (q: number) => times[Math.min(times.length - 1, Math.floor(q * times.length))] ?? 0;
    const semantic = runSemanticMemorySchema.parse(last);
    console.log(
      `KOBE-382 selector: p50 ${p(0.5).toFixed(1)} ms, p95 ${p(0.95).toFixed(1)} ms, max ${p(1).toFixed(1)} ms; ` +
        `last block ${semantic.items.length} items, ${semanticMemoryRenderedBytes(semantic)} B, omitted ${semantic.omitted_count}`,
    );
    expect(semantic.items.filter((i) => i.policy)).toHaveLength(25);
    expect(semanticMemoryRenderedBytes(semantic)).toBeLessThanOrEqual(8 * 1024);
    keywordP95 = p(0.95);
    expect(p(0.95)).toBeLessThanOrEqual(P95_MAX_MS);
  });

  it(`with every item embedded (768 dims), hybrid selection stays within the budget at p95 (KOBE-409)`, async () => {
    const q = (text: string) => h.admin.query(text);
    const vec = `ARRAY(SELECT random() - 0.5 FROM generate_series(1, ${DIMS}) WHERE v.item_id IS NOT NULL)::real[]::public.vector`;
    for (const t of [
      "semantic_memory_item_versions",
      "portable_memory_item_versions",
      "site_memory_item_versions",
    ]) {
      await q(
        `UPDATE ${t} v SET embedding = ${vec}, embedding_model = '${storedVectorModel(VECTOR_MODEL)}', embedding_dims = ${DIMS}`,
      );
    }
    await q("ANALYZE");
    for (let i = 0; i < 10; i++) await build(runId, message(i), randomVector());
    const times: number[] = [];
    for (let i = 0; i < 100; i++) {
      const v = randomVector();
      const t0 = performance.now();
      await build(runId, message(i), v);
      times.push(performance.now() - t0);
    }
    // How often the leg itself answered in time (else that message was ranked by keywords).
    let answered = 0;
    for (let i = 0; i < 20; i++) {
      const rows = await startVectorLeg(
        h.deps.database.db,
        { teamId: team, userId: runner },
        Promise.resolve({ model: VECTOR_MODEL, vector: randomVector() }),
      );
      if (rows !== undefined) answered += 1;
    }
    console.log(`KOBE-409 vector leg answered in time: ${answered}/20`);
    times.sort((a, b) => a - b);
    const p = (x: number) => times[Math.min(times.length - 1, Math.floor(x * times.length))] ?? 0;
    console.log(
      `KOBE-409 hybrid selector (vector leg beside the keyword read, query vector given): p50 ${p(0.5).toFixed(1)} ms, ` +
        `p95 ${p(0.95).toFixed(1)} ms, max ${p(1).toFixed(1)} ms`,
    );
    // The vector leg runs beside the keyword read and selection waits for it at most
    // VECTOR_LEG_DEADLINE_MS (45 ms) from the start, so hybrid adds at most the merge to
    // max(keyword read, 45 ms); 10 ms of slack for the second connection's contention.
    expect(p(0.95)).toBeLessThanOrEqual(Math.max(P95_MAX_MS, keywordP95) + 10);
  });

  it("with a realistic query embedding call, started when the message is accepted (KOBE-409 review M1)", async () => {
    // The gateway call as production makes it: token checks, budget reservation, Bifrost and
    // the provider, here a fixed EMBED_LATENCY_MS; the sandbox claim or wake meanwhile, here a
    // conservative WAKE_MS (a wake from hibernation takes seconds). Real service, real deadline.
    const EMBED_LATENCY_MS = 150;
    const WAKE_MS = 250;
    const embeddings = new MemoryEmbeddings({
      db: h.deps.database.db,
      client: {
        embed: async () => {
          await new Promise((resolve) => setTimeout(resolve, EMBED_LATENCY_MS));
          return [randomVector()];
        },
      },
      background: new BackgroundTasks(),
      log: { info: () => undefined, warn: () => undefined },
    });
    embeddings.usableModel = async () => VECTOR_MODEL;
    embeddings.runWantsVectors = async () => true;
    const input = (i: number, early: boolean) => ({
      teamId: team,
      userId: runner,
      threadId,
      runId: `${early ? "early" : "late"}-${i}`,
      message: message(i),
    });
    const ROUNDS = 20;
    const pause = () => new Promise((resolve) => setTimeout(resolve, WAKE_MS));
    // Baseline: keyword-only selection after the same pause (an idle connection and CPU answer
    // slower than the back-to-back runs above, with or without vectors).
    const idle: number[] = [];
    for (let i = 0; i < ROUNDS; i++) {
      await pause();
      const t0 = performance.now();
      await build(runId, message(i));
      idle.push(performance.now() - t0);
    }
    idle.sort((a, b) => a - b);
    const idleP95 = idle[Math.floor(0.95 * ROUNDS)] ?? 0;
    const times: number[] = [];
    let answered = 0;
    for (let i = 0; i < ROUNDS; i++) {
      embeddings.prefetchQuery(input(i, true)); // the message is accepted
      await pause();
      const t0 = performance.now();
      const vector = embeddings.queryVector(input(i, true));
      void vector.then((v) => {
        if (v !== undefined) answered += 1;
      });
      await build(runId, message(i), vector);
      times.push(performance.now() - t0);
    }
    // The same call started at selection (the design before review M1) never makes the deadline.
    let answeredLate = 0;
    for (let i = 0; i < 5; i++) {
      if ((await embeddings.queryVector(input(i, false))) !== undefined) answeredLate += 1;
    }
    times.sort((a, b) => a - b);
    const p = (x: number) => times[Math.min(times.length - 1, Math.floor(x * times.length))] ?? 0;
    console.log(
      `KOBE-409 hybrid selector with a ${EMBED_LATENCY_MS} ms embedding started at accept: ` +
        `vector in time ${answered}/${ROUNDS} (started at selection: ${answeredLate}/5); ` +
        `p50 ${p(0.5).toFixed(1)} ms, p95 ${p(0.95).toFixed(1)} ms (keyword-only after the same pause: p95 ${idleP95.toFixed(1)} ms)`,
    );
    expect(answered).toBe(ROUNDS);
    expect(answeredLate).toBe(0);
    expect(p(0.95)).toBeLessThanOrEqual(Math.max(P95_MAX_MS, idleP95) + 10);
  });
});
