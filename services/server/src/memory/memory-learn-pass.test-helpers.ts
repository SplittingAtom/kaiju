// Shared setup for the memory-learn-pass.*.db.test.ts files
// (split from memory-learn-pass.db.test.ts, KOBE-725).
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, expect } from "vitest";
import { type KobeTx } from "@kobe/db";
import { type MemoryExtractorCandidate } from "@kobe/protocol";
import { BackgroundTasks } from "../background.js";
import { appendRunEvents } from "../event-stream/append.js";
import { type ServerCallClient, type ServerCallInput } from "../models/gateway-client.js";
import {
  createLearningPasses,
  type LearningPasses,
  type LearningPassesOptions,
} from "./learn/run.js";
import { EventStreamFixture, type Person } from "../testing/event-stream-fixture.js";

/**
 * KOBE-393 (SMB5; SM14, SM15, SM16, Q5): a learning pass end to end against Postgres with a
 * scripted model gateway: start checks, the DB's one-pass-per-thread rule across replicas, the
 * extractor call and its retry, validation and candidates, the watermark, pass events on the
 * thread's run (and the append guard), the stale-pass sweep and the trace.
 */
export const fx = new EventStreamFixture();
export let owner: Person;
export let mate: Person;
export let team: string;
export const LEARNER = `lp-${randomBytes(3).toString("hex")}`;
export const NO_LOG = { info: () => undefined, warn: () => undefined };

/** A scripted gateway: each call takes the next reply (a JSON value, raw text, or an error). */
export class FakeGateway implements ServerCallClient {
  readonly calls: ServerCallInput[] = [];
  replies: (unknown | Error | ((input: ServerCallInput) => unknown))[] = [];
  async complete(input: ServerCallInput): Promise<string> {
    this.calls.push(input);
    const queued = this.replies.shift() ?? { candidates: [], skill_hints: [] };
    const next = typeof queued === "function" ? await queued(input) : queued;
    if (next instanceof Error) throw next;
    return typeof next === "string" ? next : JSON.stringify(next);
  }
}

export let gateway: FakeGateway;
export let background: BackgroundTasks;
export let passes: LearningPasses;
export const passesOn = (
  replica: number,
  beforeClaim?: (tx: KobeTx) => Promise<void>,
  completion?: LearningPassesOptions["completion"],
) =>
  createLearningPasses({
    db: fx.replica(replica).deps.database.db,
    client: gateway,
    background,
    log: NO_LOG,
    ...(beforeClaim ? { beforeClaim } : {}),
    ...(completion ? { completion } : {}),
  });

/** Another connection holding the thread's change lock, as a long change on it would. */
export async function holdThread(threadId: string) {
  const locker = new pg.Client({ connectionString: fx.database.adminUrl });
  await locker.connect();
  await locker.query("BEGIN");
  await locker.query(`SELECT 1 FROM threads WHERE team_id = $1 AND id = $2 FOR NO KEY UPDATE`, [
    team,
    threadId,
  ]);
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await locker.query("ROLLBACK");
    await locker.end();
  };
}

/** A latch: `opened` settles once `open()` is called. */
export function latch() {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

/** A gateway reply that holds the pass inside its model call until `held` opens. */
export const heldReply = (held: { opened: Promise<void> }) => async () => {
  await held.opened;
  return { candidates: [], skill_hints: [] };
};

export async function siteLearner(alias: string | null) {
  await fx.admin.query(
    `INSERT INTO site_settings (key, value) VALUES ('memory.settings', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify({ learning_model_alias: alias })],
  );
}

export const text = (t: string) => [{ type: "text", text: t }];
export const msg = (role: "user" | "assistant", t: string) => ({
  message: { role, content: text(t) },
});

export interface Seeded {
  readonly threadId: string;
  readonly runId: string;
}

/**
 * A thread of `who` with u1 (person) → a1 (assistant), the leaf, and one completed run answering
 * u1, leased to them, its run.completed written.
 */
export async function seedThread(said: string, who: Person = owner): Promise<Seeded> {
  const threadId = randomUUID();
  await fx.admin.query(`INSERT INTO threads (team_id, id, owner_user_id) VALUES ($1, $2, $3)`, [
    team,
    threadId,
    who.id,
  ]);
  await addEntries(threadId, [
    ["u1", null, msg("user", said)],
    ["a1", "u1", msg("assistant", "Noted.")],
  ]);
  const runId = await completedRun(threadId, "u1", who);
  return { threadId, runId };
}

export async function addEntries(threadId: string, list: [string, string | null, object][]) {
  for (const [id, parent, payload] of list)
    await fx.admin.query(
      `INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type, payload)
       VALUES ($1, $2, $3, $4, 'message', $5)`,
      [team, threadId, id, parent, JSON.stringify(payload)],
    );
  await fx.admin.query(`UPDATE threads SET leaf_entry_id = $3 WHERE team_id = $1 AND id = $2`, [
    team,
    threadId,
    list.at(-1)?.[0],
  ]);
}

export async function completedRun(threadId: string, userEntry: string, who: Person = owner) {
  const runId = randomUUID();
  await fx.admin.query(
    `INSERT INTO runs (team_id, id, thread_id, trigger, status, started_at, ended_at, user_entry_id)
     VALUES ($1, $2, $3, 'user', 'completed', now(), now(), $4)`,
    [team, runId, threadId, userEntry],
  );
  await fx.admin.query(
    `INSERT INTO sandbox_run_leases (team_id, run_id, user_id, thread_id, sandbox_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [team, runId, who.id, threadId, randomUUID()],
  );
  await appendRunEvents(fx.db, team, runId, [
    { type: "run.completed", payload: { leaf_entry_id: null } },
  ]);
  return runId;
}

export const viewer = (who: Person = owner) => ({ teamId: team, userId: who.id, projectIds: [] });

export const candidate = (
  over: Partial<MemoryExtractorCandidate> = {},
): MemoryExtractorCandidate => ({
  statement: "I prefer metric units.",
  kind: "preference",
  suggested_scope: "user",
  portable: false,
  project_specific: false,
  source: "stated",
  operation: "add",
  target_id: null,
  confidence: 0.9,
  rationale: "The person said it.",
  evidence: [{ entry_id: "u1", quote: "I prefer metric units" }],
  ...over,
});
export const reply = (...candidates: MemoryExtractorCandidate[]) => ({
  candidates,
  skill_hints: [],
});

export async function passRow(passId: string) {
  const { rows } = await fx.admin.query<{
    status: string;
    error: string | null;
    to_entry_id: string | null;
    usage: Record<string, unknown> | null;
  }>(`SELECT status, error, to_entry_id, usage FROM memory_learning_passes WHERE id = $1`, [
    passId,
  ]);
  return rows[0];
}

export async function candidatesOf(passId: string) {
  const { rows } = await fx.admin.query<{ ord: number; payload: Record<string, unknown> }>(
    `SELECT ord, payload FROM memory_candidates WHERE pass_id = $1 ORDER BY ord`,
    [passId],
  );
  return rows;
}

export async function watermarkOf(threadId: string, who: Person = owner) {
  const { rows } = await fx.admin.query<{ entry_id: string }>(
    `SELECT entry_id FROM memory_learning_watermarks WHERE thread_id = $1 AND user_id = $2`,
    [threadId, who.id],
  );
  return rows[0]?.entry_id ?? null;
}

export async function passEvents(runId: string) {
  const { rows } = await fx.admin.query<{ type: string; payload: Record<string, unknown> }>(
    `SELECT type, payload FROM run_events WHERE run_id = $1 AND type LIKE 'memory.pass.%' ORDER BY seq`,
    [runId],
  );
  return rows;
}

/** The pass's audit rows in order; a pass id is unique, so this filters by the target. */
export async function passAudits(passId: string) {
  const { rows } = await fx.admin.query<{
    action: string;
    team_id: string | null;
    actor_kind: string;
    actor_id: string | null;
    target: Record<string, unknown>;
  }>(
    `SELECT action, team_id, actor_kind, actor_id, target FROM audit_log
      WHERE action LIKE 'memory.pass.%' AND target->>'passId' = $1 ORDER BY seq`,
    [passId],
  );
  return rows;
}

/** No audit row carries a statement, quote, rationale or message text (KOBE-393). */
export function expectNoContent(rows: { target: Record<string, unknown> }[], ...texts: string[]) {
  const all = JSON.stringify(rows.map((r) => r.target)).toLowerCase();
  for (const t of [...texts, "statement", "quote", "evidence", "rationale", "message"])
    expect(all).not.toContain(t.toLowerCase());
}

export async function startAndWait(s: Seeded, who: Person = owner) {
  const started = await passes.start(viewer(who), s.threadId);
  await background.idle();
  return started;
}

/**
 * Registers the shared hooks; call once at the top level of each
 * memory-learn-pass.*.db.test.ts file.
 */
export function useMemoryLearnPassWorld(): void {
  beforeAll(async () => {
    await fx.setup([{}, {}]);
    owner = await fx.person(`po${randomBytes(2).toString("hex")}`);
    mate = await fx.person(`pm${randomBytes(2).toString("hex")}`);
    team = await fx.team(`lp-${randomBytes(3).toString("hex")}`, owner, [mate]);
    await fx.admin.query(
      `INSERT INTO model_providers (id, kind, name, api_key_enc, created_by)
       VALUES ('openai', 'openai', 'openai', 'v2.test.sealed-provider-key', $1) ON CONFLICT (id) DO NOTHING`,
      [owner.id],
    );
    for (const alias of [LEARNER, `${LEARNER}-off`])
      await fx.admin.query(
        `INSERT INTO model_catalog (alias, provider_id, model, created_by) VALUES ($1, 'openai', $1, $2)`,
        [alias, owner.id],
      );
    await fx.admin.query(
      `INSERT INTO team_models (team_id, alias, is_default, enabled_by) VALUES ($1, $2, true, $3)`,
      [team, LEARNER, owner.id],
    );
    await siteLearner(LEARNER);
  });

  afterAll(() => fx.teardown());

  beforeEach(() => {
    gateway = new FakeGateway();
    background = new BackgroundTasks();
    passes = passesOn(0);
  });
}
