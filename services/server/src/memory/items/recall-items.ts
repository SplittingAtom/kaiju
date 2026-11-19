import { presentedActorKind } from "./actor-kind.js";
import { sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import {
  type MemoryShownItem,
  type RunSemanticMemoryItem,
  type SemanticMemoryActorKind,
  type SemanticMemoryKind,
  type SemanticMemoryScope,
  type SemanticMemoryStatus,
} from "@kobe/protocol";
import { readRunMemoryPlan } from "../../agents/run-memory.js";
import type { QueryEmbedInput, QueryVector } from "../embeddings/service.js";
import { parseRunMemoryState, runMemoryStateQuery, type RunMemoryStateRow } from "../switches.js";
import type { ItemRow } from "./item-row.js";
import { locate } from "./location.js";
import { readRunRecords } from "./run-records.js";
import { queryWords, readRecallItemRows, recallCandidates } from "./run-memory.js";
import { rankRecall, SELECT_LANES, type SelectLane } from "./select.js";
import { mergeVectorRows, readVectorRows } from "./vector-leg.js";

/**
 * The agent's read paths over saved memories (KOBE-399, SM26):
 *
 * - {@link recallItems}: `recall({ query })` answers the runner's active items of every scope the
 *   switches allow (and Site Policy), ranked by the selector's relevance (A7:
 *   `ts_rank_cd + 0.3 · trigram + 0.1 · recency`, no preference base or stickiness), hybrid like
 *   the selector (KOBE-664, KOBE-409: `+ 2 · vectorScore`, and the query's nearest items count
 *   without a shared word) when the Site has an embedding model and the items have vectors of it;
 *   best `MEMORY_RECALL_MAX_ITEMS`. Undefined when the run's agent version has no semantic
 *   memory (`notes_only`, `off`, test chats, evals). Works whether or not the run's context carried
 *   the items, so a placement that keeps them out of the prompt can rely on it.
 * - {@link showItem}: `show_memory_item({ id })` reads one item as saved now, only when this run was
 *   given it (its run records) or an earlier `recall` of the run answered it (`recalled`, kept by
 *   the connection). Reads only: nothing is written, not even an audit row.
 */

export interface RecallWho {
  readonly teamId: string;
  readonly userId: string;
  readonly runId: string;
}

/** The recall query's vector (`MemoryEmbeddings.recallVector`); never throws. */
export interface RecallEmbedder {
  recallVector?(input: QueryEmbedInput): Promise<QueryVector | undefined>;
}

/** The recall vector statement's own deadline (a tool call; the selector's is 30 ms). */
export const RECALL_VECTOR_QUERY_TIMEOUT_MS = 1_000;

interface KeywordRecall {
  readonly lanes: readonly SelectLane[];
  readonly rows: ItemRow[];
}

/** The plan, the switches and the keyword rows, in the run's team transaction. */
async function readKeywordRecall(
  tx: KobeTx,
  who: RecallWho,
  query: string,
): Promise<KeywordRecall | undefined> {
  const plan = await readRunMemoryPlan(tx, who);
  if (!plan.semantic) return undefined;
  const { memory } = parseRunMemoryState(
    (await tx.execute<RunMemoryStateRow>(runMemoryStateQuery(who.teamId))).rows[0],
  );
  const lanes = SELECT_LANES.filter((lane) => memory.scopes[lane]);
  const rows = await readRecallItemRows(tx, who, queryWords(query), memory.policy, lanes);
  return { lanes, rows };
}

/**
 * The vector leg's rows for the recall query, after the keyword transaction committed: the query
 * embedding is a gateway call, so no transaction is held open across it (the vector statement
 * then runs in its own `withTeam`, as the selector's leg does). Undefined (keywords alone) when
 * there is no embedder, no lane, no vector (no model, no pgvector, refused, failed, late) or the
 * statement fails.
 */
async function recallVectorRows(
  db: KobeDb,
  who: RecallWho & { readonly threadId: string },
  query: string,
  lanes: readonly SelectLane[],
  embedder: RecallEmbedder | undefined,
): Promise<ItemRow[] | undefined> {
  if (embedder?.recallVector === undefined || lanes.length === 0) return undefined;
  const vector = await embedder.recallVector({ ...who, message: query });
  if (vector === undefined) return undefined;
  try {
    return await readVectorRows(db, who, vector, RECALL_VECTOR_QUERY_TIMEOUT_MS);
  } catch {
    return undefined;
  }
}

/**
 * `recall({ query })`'s items: keyword rows in the run's team transaction, then (outside it) the
 * hybrid leg when it can run, ranked by {@link rankRecall}. Throws only if the keyword read does.
 */
export async function recallItems(
  db: KobeDb,
  who: RecallWho & { readonly threadId: string },
  query: string,
  embedder?: RecallEmbedder,
): Promise<RunSemanticMemoryItem[] | undefined> {
  const keyword = await withTeam(db, who.teamId, (tx) => readKeywordRecall(tx, who, query));
  if (keyword === undefined) return undefined;
  const vector = await recallVectorRows(db, who, query, keyword.lanes, embedder);
  const rows =
    vector === undefined ? keyword.rows : mergeVectorRows(keyword.rows, vector, keyword.lanes);
  const candidates = recallCandidates(rows, keyword.lanes, query);
  return rankRecall(candidates.lanes, candidates.policy);
}

interface ShownRow extends Record<string, unknown> {
  readonly id: string;
  readonly kind: SemanticMemoryKind;
  readonly status: SemanticMemoryStatus;
  readonly pinned: boolean;
  readonly policy: boolean;
  readonly version: number;
  readonly statement: string;
  readonly actor_kind: SemanticMemoryActorKind;
  readonly as_of: string | null;
  readonly saved_on: string;
}

/** Where `id` came from in this run: its records first, then an earlier recall answer. */
async function sourceOf(
  tx: KobeTx,
  who: RecallWho,
  id: string,
  recalled: (id: string) => SemanticMemoryScope | undefined,
): Promise<{ readonly scope: SemanticMemoryScope; readonly givenPolicy: boolean } | undefined> {
  const record = (await readRunRecords(tx, who.teamId, who.userId, who.runId)).find(
    (r) => r.id === id,
  );
  if (record)
    return record.lane === "policy"
      ? { scope: "site", givenPolicy: true }
      : { scope: record.lane, givenPolicy: false };
  const scope = recalled(id);
  return scope === undefined ? undefined : { scope, givenPolicy: false };
}

/**
 * One item, for `show_memory_item`. Besides coming from the run, it must still be allowed now:
 * without semantic memory (`notes_only`) only a Policy item the run was given; and its scope's
 * switch (Policy: the Site master) must still be on.
 */
export async function showItem(
  tx: KobeTx,
  who: RecallWho,
  id: string,
  recalled: (id: string) => SemanticMemoryScope | undefined,
  semantic: boolean,
): Promise<MemoryShownItem | undefined> {
  const source = await sourceOf(tx, who, id, recalled);
  if (source === undefined || (!semantic && !source.givenPolicy)) return undefined;
  const { scope } = source;
  const { memory } = parseRunMemoryState(
    (await tx.execute<RunMemoryStateRow>(runMemoryStateQuery(who.teamId))).rows[0],
  );
  const loc = locate(scope, who.teamId, who.userId);
  const { rows } = await tx.execute<ShownRow>(sql`
    SELECT i.id, i.kind, i.status, i.pinned, ${loc.policy} AS policy, i.current_version AS version,
           v.statement, v.actor_kind, to_char(${loc.asOf}, 'YYYY-MM-DD') AS as_of,
           to_char(v.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS saved_on
      FROM ${loc.items} i
      JOIN ${loc.versions} v ON ${loc.versionOf} AND v.version = i.current_version
     WHERE ${loc.where} AND i.id = ${id}`);
  const row = rows[0];
  if (!row) return undefined;
  if (row.policy ? !memory.policy : !memory.scopes[scope]) return undefined;
  if (!semantic && !row.policy) return undefined;
  return {
    id: row.id,
    version: Number(row.version),
    scope,
    kind: row.kind,
    statement: row.statement,
    policy: row.policy,
    pinned: row.policy ? false : row.pinned,
    status: row.status,
    provenance: {
      actor_kind: presentedActorKind(row.actor_kind),
      as_of: row.as_of,
      saved_on: row.saved_on,
    },
  };
}
