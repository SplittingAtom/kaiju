import { sql, type KobeTx } from "@kobe/db";
import {
  semanticMemoryRenderedBytes,
  semanticMemoryRunRank,
  type RunSemanticMemory,
  type RunSemanticMemoryItem,
  type SemanticMemoryPlacement,
} from "@kobe/protocol";
import { logger } from "../../logger.js";
import { readRunRecords, recordToRunItem } from "./run-records.js";
import type { SelectLane } from "./select.js";

/**
 * Memory placement (KOBE-658, Site setting `memory.placement`; Gate A: the cache-read share fell
 * from 91.2% to 26.1% because the per-message picks sat in the system prompt). The selector picks
 * as before; this shapes the payload the sandbox renders, and the run records keep exactly what
 * the payload carries (U48), in every mode:
 * - `system`, `latest_user_keep`, `latest_user_strip`: the selection unchanged (the sandbox places
 *   the picks);
 * - `tool_only`: no picks (KOBE-399's `recall` / `show_memory_item` find them);
 * - `stable_plus_delta`: the held set (the picks of the thread's latest epoch run, at current
 *   versions) marked `held`, then the picks it lacks; within the Site budget.
 */

/**
 * Whether `tool_only` may be used: KOBE-399 (item recall and `show_memory_item`) flips this when it
 * lands. Until then the mode falls back to `latest_user_keep` with a log line.
 */
export const TOOL_ONLY_AVAILABLE = false;

let warnedToolOnly = false;

/** The placement this run gets: the Site's, unless the agent cannot do it (logged once). */
export function effectivePlacement(
  stored: SemanticMemoryPlacement,
  opts: { readonly agentPlaces: boolean; readonly warn?: (message: string) => void },
): SemanticMemoryPlacement {
  if (!opts.agentPlaces) return "system";
  if (stored === "tool_only" && !TOOL_ONLY_AVAILABLE) {
    const message =
      "memory placement tool_only needs item recall (KOBE-399); using latest_user_keep";
    if (opts.warn) opts.warn(message);
    else if (!warnedToolOnly) {
      warnedToolOnly = true;
      logger.warn({ placement: stored }, message);
    }
    return "latest_user_keep";
  }
  return stored;
}

const isPick = (i: RunSemanticMemoryItem) => semanticMemoryRunRank(i) === 2;
const unheld = ({ held: _held, ...rest }: RunSemanticMemoryItem): RunSemanticMemoryItem => rest;

/**
 * The payload for `placement`. `held` (stable_plus_delta): the held set, undefined when this run
 * starts an epoch (its own picks become the held set). Over `budgetBytes`, whole picks are left
 * out from the end, delta before held (never Policy or pinned), and counted as omitted.
 */
export function applyPlacement(
  semantic: RunSemanticMemory,
  placement: SemanticMemoryPlacement,
  opts: { readonly budgetBytes: number; readonly held?: readonly RunSemanticMemoryItem[] },
): RunSemanticMemory {
  if (placement === "system") return semantic;
  if (placement === "latest_user_keep" || placement === "latest_user_strip") {
    return { ...semantic, placement };
  }
  const fixed = semantic.items.filter((i) => !isPick(i));
  const picks = semantic.items.filter(isPick);
  if (placement === "tool_only") {
    return {
      items: fixed,
      omitted_count: semantic.omitted_count + picks.length,
      placement,
    };
  }
  const taken = new Set(fixed.map((i) => i.id));
  const heldItems = (opts.held ?? picks)
    .filter((i) => !taken.has(i.id) && !i.policy && !i.pinned)
    .map((i) => ({ ...unheld(i), held: true as const }));
  const heldIds = new Set(heldItems.map((i) => i.id));
  const delta = picks.filter((i) => !heldIds.has(i.id)).map(unheld);
  let items = [...fixed, ...heldItems, ...delta];
  let omitted = semantic.omitted_count;
  while (semanticMemoryRenderedBytes({ items }) > opts.budgetBytes && items.length > fixed.length) {
    items = items.slice(0, -1);
    omitted += 1;
  }
  return { items, omitted_count: omitted, placement };
}

/** A redelivered start (its records read back): the held ones marked again, first among picks. */
export function markHeld(
  semantic: RunSemanticMemory,
  heldIds: ReadonlySet<string>,
): RunSemanticMemory {
  const fixed = semantic.items.filter((i) => !isPick(i));
  const picks = semantic.items.filter(isPick).map(unheld);
  const held = picks.filter((i) => heldIds.has(i.id)).map((i) => ({ ...i, held: true as const }));
  return {
    items: [...fixed, ...held, ...picks.filter((i) => !heldIds.has(i.id))],
    omitted_count: semantic.omitted_count,
    placement: "stable_plus_delta",
  };
}

/** The 0-based index of the epoch run for the `k`-th message run of a thread (0-based). */
export const epochIndex = (k: number, every: number): number => k - (k % every);

/**
 * The thread's epoch run for `runId`: the message run every `every` runs (counted by creation
 * order) whose picks are the held set. Stateless, so it needs no migration and every replica
 * agrees: the held set changes only at an epoch start, or once when an item it holds changes
 * (its current version is used) or leaves (archived, its place switched off).
 */
export async function readEpoch(
  tx: KobeTx,
  input: { readonly teamId: string; readonly threadId: string; readonly runId: string },
  every: number,
): Promise<{ readonly epochRunId: string; readonly isThisRun: boolean } | undefined> {
  const { teamId, threadId, runId } = input;
  const res = await tx.execute<{ id: string; i: number; k: number }>(sql`
    WITH o AS (
      SELECT r.id, (row_number() OVER (ORDER BY r.created_at, r.id) - 1)::int AS i
        FROM runs r
       WHERE r.team_id = ${teamId} AND r.thread_id = ${threadId}
         AND (r.kind = 'message' OR r.id = ${runId})
         AND (r.created_at, r.id) <= (SELECT c.created_at, c.id FROM runs c
                                       WHERE c.team_id = ${teamId} AND c.id = ${runId})
    ), last AS (SELECT max(i) AS k FROM o)
    SELECT o.id, o.i, last.k FROM o, last WHERE o.i = last.k - (last.k % ${every})`);
  const row = res.rows[0];
  if (!row) return undefined;
  return { epochRunId: row.id, isThisRun: row.id === runId };
}

/**
 * The held set for a run that does not start its epoch: the picks the epoch run was given, each
 * at its current version, still active, the runner's own (personal and portable) and in a place
 * the switches allow for this run.
 */
export async function readHeldSet(
  tx: KobeTx,
  input: { readonly teamId: string; readonly userId: string },
  epochRunId: string,
  lanes: readonly SelectLane[],
): Promise<RunSemanticMemoryItem[]> {
  const recorded = (await readRunRecords(tx, input.teamId, input.userId, epochRunId))
    .filter((r) => r.lane !== "policy" && !r.pinned && lanes.includes(r.lane as SelectLane))
    .map((r) => r.id);
  if (recorded.length === 0) return [];
  const { rows } = await tx.execute<HeldRow>(currentItemsQuery(input, recorded));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return recorded.flatMap((id) => {
    const r = byId.get(id);
    if (r === undefined || r.pinned || r.lane === "policy") return [];
    if (!lanes.includes(r.lane as SelectLane)) return [];
    return [recordToRunItem(r)];
  });
}

type HeldRow = Parameters<typeof recordToRunItem>[0];

/** Current versions of active items by id, under the same walls as the run records. */
function currentItemsQuery(
  input: { readonly teamId: string; readonly userId: string },
  ids: string[],
) {
  const { teamId, userId } = input;
  const list = sql`${`{${ids.join(",")}}`}::uuid[]`;
  const saved = (v: string) =>
    sql.raw(`to_char(${v}.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS saved_on`);
  return sql`
    SELECT i.id, v.version, i.scope AS lane, i.kind, v.statement, i.pinned, v.actor_kind,
           to_char(i.as_of, 'YYYY-MM-DD') AS as_of, ${saved("v")}
      FROM semantic_memory_items i
      JOIN semantic_memory_item_versions v
        ON v.team_id = i.team_id AND v.item_id = i.id AND v.version = i.current_version
     WHERE i.team_id = ${teamId} AND i.id = ANY(${list}) AND i.status = 'active'
       AND (i.scope = 'team' OR i.owner_user_id = ${userId})
    UNION ALL
    SELECT i.id, v.version, 'portable', i.kind, v.statement, i.pinned, v.actor_kind, NULL,
           ${saved("v")}
      FROM portable_memory_items i
      JOIN portable_memory_item_versions v ON v.item_id = i.id AND v.version = i.current_version
     WHERE i.id = ANY(${list}) AND i.status = 'active' AND i.owner_user_id = ${userId}
    UNION ALL
    SELECT i.id, v.version, CASE WHEN i.policy THEN 'policy' ELSE 'site' END, i.kind,
           v.statement, i.pinned AND NOT i.policy, v.actor_kind,
           to_char(i.as_of, 'YYYY-MM-DD'), ${saved("v")}
      FROM site_memory_items i
      JOIN site_memory_item_versions v ON v.item_id = i.id AND v.version = i.current_version
     WHERE i.id = ANY(${list}) AND i.status = 'active'`;
}
