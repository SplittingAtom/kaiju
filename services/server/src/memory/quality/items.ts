import { scanTeams, sql, withTeam, type KaijuDb, type KaijuTx } from "@kaiju/db";
import type { SemanticMemoryKind } from "@kaiju/protocol";
import { notAllowed } from "../items/errors.js";
import { locate, type Location } from "../items/location.js";
import { curates, type MemoryWho } from "../items/who.js";
import { readMemorySiteSettings } from "../site-settings.js";
import {
  CHECK_THIS_DOWN_RATIO,
  CHECK_THIS_MIN_RUNS,
  qualityFlags,
  type QualityFlags,
} from "./flags.js";

/** The scopes with item signals: the person's own, the Workspace's, the Site's. */
export const QUALITY_SCOPES = ["user", "team", "site"] as const;
export type QualityScope = (typeof QUALITY_SCOPES)[number];
export const QUALITY_FILTERS = ["all", "check_this", "unused"] as const;
export type QualityFilter = (typeof QUALITY_FILTERS)[number];

/** Active items read at most (the SM21 scope limit is 1,000). */
export const QUALITY_ITEMS_MAX = 1000;

export interface ItemSignals {
  readonly id: string;
  readonly statement: string;
  readonly kind: SemanticMemoryKind;
  readonly pinned: boolean;
  readonly policy: boolean;
  readonly runs: number;
  readonly down_runs: number;
  readonly last_received_at: string | null;
  readonly flags: QualityFlags;
}

export interface ItemSignalsResponse {
  readonly scope: QualityScope;
  readonly thresholds: {
    readonly check_min_runs: number;
    readonly check_down_ratio: number;
    readonly unused_after_days: number;
  };
  readonly counts: { readonly all: number; readonly check_this: number; readonly unused: number };
  readonly items: readonly ItemSignals[];
}

type ItemRow = {
  id: string;
  statement: string;
  kind: SemanticMemoryKind;
  pinned: boolean;
  policy: boolean;
  created_at: Date | string;
};
type UseRow = {
  item_id: string;
  runs: number;
  down_runs: number;
  last_received: Date | string | null;
};

/** Active items of the scope with their current statement (newest change first, capped). */
async function activeItems(tx: KaijuDb | KaijuTx, loc: Location): Promise<ItemRow[]> {
  const { rows } = await tx.execute<ItemRow>(sql`
    SELECT i.id, v.statement, i.kind, i.pinned, ${loc.policy} AS policy, i.created_at
      FROM ${loc.items} i JOIN ${loc.versions} v ON ${loc.versionOf} AND v.version = i.current_version
     WHERE ${loc.where} AND i.status = 'active'
     ORDER BY i.updated_at DESC, i.id
     LIMIT ${QUALITY_ITEMS_MAX}`);
  return rows;
}

/**
 * Per item of one Workspace: runs that received it, the last time, and runs among them with a
 * thumbs down (any rater, once per run). The run tables' item index and the `answer_feedback
 * (team_id, run_id, user_id)` unique index serve it. Down-rated runs are one hashed set, not a
 * subquery per row: with RLS the per-row form is costed so high that Postgres JIT-compiles it
 * (~0.5 s of compile for ~10 ms of work on 20,000 records).
 */
const usesSql = (runs: Location["runs"], teamId: string, ids: readonly string[]) => sql`
  WITH down AS (
    SELECT DISTINCT f.run_id FROM answer_feedback f
     WHERE f.team_id = ${teamId} AND f.rating = 'down'
  )
  SELECT r.item_id, count(*)::int AS runs, max(r.created_at) AS last_received,
         count(down.run_id)::int AS down_runs
    FROM ${runs} r LEFT JOIN down ON down.run_id = r.run_id
   WHERE r.team_id = ${teamId} AND r.item_id = ANY(${`{${ids.join(",")}}`}::uuid[])
   GROUP BY r.item_id`;

function merge(into: Map<string, UseRow>, rows: readonly UseRow[]): void {
  for (const r of rows) {
    const had = into.get(r.item_id);
    if (!had) {
      into.set(r.item_id, r);
      continue;
    }
    const last =
      had.last_received === null ||
      (r.last_received !== null && new Date(r.last_received) > new Date(had.last_received))
        ? r.last_received
        : had.last_received;
    into.set(r.item_id, {
      item_id: r.item_id,
      runs: had.runs + r.runs,
      down_runs: had.down_runs + r.down_runs,
      last_received: last,
    });
  }
}

function assertReads(who: MemoryWho, scope: QualityScope): void {
  if (scope === "user") return;
  if (!curates(who, scope))
    throw notAllowed(
      scope === "team"
        ? "Only Team admins and memory stewards see how Workspace memories are used."
        : "Only Site admins and Site memory stewards see how Site memories are used.",
    );
}

/**
 * Item signals and flags of one scope (KOBE-411). `user`: the caller's own items in the active
 * Workspace. `team`: Workspace curators. `site`: Site curators; Site items reach runs in every
 * Workspace, so their run records are summed over every team (`scanTeams`, one query per team,
 * team tables behind RLS): numbers only cross, never a thread, run or rating.
 */
export async function listItemSignals(
  db: KaijuDb,
  who: MemoryWho,
  scope: QualityScope,
  filter: QualityFilter,
  now = new Date(),
): Promise<ItemSignalsResponse> {
  assertReads(who, scope);
  const settings = await readMemorySiteSettings(db);
  const loc = locate(scope, scope === "site" ? null : who.teamId, who.userId);
  const uses = new Map<string, UseRow>();
  let items: ItemRow[];
  if (scope === "site") {
    items = await activeItems(db, loc);
    const ids = items.map((i) => i.id);
    if (ids.length > 0) {
      const perTeam = await scanTeams(db, "listItemSignals", async (tx, team) => {
        const { rows } = await tx.execute<UseRow>(usesSql(loc.runs, team.id, ids));
        return rows;
      });
      for (const rows of perTeam) merge(uses, rows);
    }
  } else {
    const teamId = loc.teamId as string;
    items = await withTeam(db, teamId, async (tx) => {
      const found = await activeItems(tx, loc);
      if (found.length > 0) {
        const { rows } = await tx.execute<UseRow>(
          usesSql(
            loc.runs,
            teamId,
            found.map((i) => i.id),
          ),
        );
        merge(uses, rows);
      }
      return found;
    });
  }
  const all = items.map((i): ItemSignals => {
    const u = uses.get(i.id);
    const use = {
      runs: u?.runs ?? 0,
      downRuns: u?.down_runs ?? 0,
      lastReceivedAt: u?.last_received ?? null,
      createdAt: i.created_at,
    };
    return {
      id: i.id,
      statement: i.statement,
      kind: i.kind,
      pinned: i.pinned,
      policy: i.policy,
      runs: use.runs,
      down_runs: use.downRuns,
      last_received_at:
        use.lastReceivedAt === null ? null : new Date(use.lastReceivedAt).toISOString(),
      flags: qualityFlags(use, settings.unused_after_days, now),
    };
  });
  // Flagged first (check this, then unused), then the most used.
  const rank = (s: ItemSignals) => (s.flags.check_this ? 0 : s.flags.unused ? 1 : 2);
  all.sort((a, b) => rank(a) - rank(b) || b.runs - a.runs || a.id.localeCompare(b.id));
  return {
    scope,
    thresholds: {
      check_min_runs: CHECK_THIS_MIN_RUNS,
      check_down_ratio: CHECK_THIS_DOWN_RATIO,
      unused_after_days: settings.unused_after_days,
    },
    counts: {
      all: all.length,
      check_this: all.filter((s) => s.flags.check_this).length,
      unused: all.filter((s) => s.flags.unused).length,
    },
    items: filter === "all" ? all : all.filter((s) => s.flags[filter]),
  };
}
