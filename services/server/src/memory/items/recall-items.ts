import { presentedActorKind } from "./actor-kind.js";
import { sql, type KobeTx } from "@kobe/db";
import {
  MEMORY_RECALL_MAX_ITEMS,
  type MemoryShownItem,
  type RunSemanticMemoryItem,
  type SemanticMemoryActorKind,
  type SemanticMemoryKind,
  type SemanticMemoryScope,
  type SemanticMemoryStatus,
} from "@kobe/protocol";
import { readRunMemoryPlan } from "../../agents/run-memory.js";
import { parseRunMemoryState, runMemoryStateQuery, type RunMemoryStateRow } from "../switches.js";
import { locate } from "./location.js";
import { readRunRecords } from "./run-records.js";
import { queryWords, readRecallRows, TRIGRAM_MESSAGE_MAX_CHARS } from "./run-memory.js";
import { relevanceScore, SELECT_LANES } from "./select.js";
import { trigramSimilarity, trigrams } from "./trigram.js";

/**
 * The agent's read paths over saved memories (KOBE-399, SM26), in the run's team transaction:
 *
 * - {@link recallItems}: `recall({ query })` answers the runner's active items of every scope the
 *   switches allow (and Site Policy), matching the query, ranked by the selector's relevance (A7:
 *   `ts_rank_cd + 0.3 · trigram + 0.1 · recency`, no preference base or stickiness), best
 *   {@link MEMORY_RECALL_MAX_ITEMS}. Undefined when the run's agent version has no semantic memory
 *   (`notes_only`, `off`, test chats, evals). Works whether or not the run's context carried the
 *   items, so a placement that keeps them out of the prompt can rely on it.
 * - {@link showItem}: `show_memory_item({ id })` reads one item as saved now, only when this run was
 *   given it (its run records) or an earlier `recall` of the run answered it (`recalled`, kept by
 *   the connection). Reads only: nothing is written, not even an audit row.
 */

export interface RecallWho {
  readonly teamId: string;
  readonly userId: string;
  readonly runId: string;
}

export async function recallItems(
  tx: KobeTx,
  who: RecallWho,
  query: string,
): Promise<RunSemanticMemoryItem[] | undefined> {
  const plan = await readRunMemoryPlan(tx, who);
  if (!plan.semantic) return undefined;
  const { memory } = parseRunMemoryState(
    (await tx.execute<RunMemoryStateRow>(runMemoryStateQuery(who.teamId))).rows[0],
  );
  const lanes = SELECT_LANES.filter((lane) => memory.scopes[lane]);
  const rows = await readRecallRows(tx, who, queryWords(query), memory.policy, lanes);
  const grams = trigrams(query.slice(0, TRIGRAM_MESSAGE_MAX_CHARS));
  return rows
    .map((r) => ({
      item: r.item,
      score: relevanceScore({
        item: r.item,
        matched: true,
        textRank: r.textRank,
        trigram: trigramSimilarity(r.item.statement, grams),
        ageDays: r.ageDays,
        sticky: false,
      }),
    }))
    .sort((a, b) => b.score - a.score || (a.item.id < b.item.id ? -1 : 1))
    .slice(0, MEMORY_RECALL_MAX_ITEMS)
    .map((r) => r.item);
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
