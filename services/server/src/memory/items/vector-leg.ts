import { sql, withTeam, type KobeDb } from "@kobe/db";
import { vectorLiteral } from "../embeddings/vector-store.js";
import type { QueryVector } from "../embeddings/service.js";
import type { ItemRow } from "./item-row.js";
import { locate } from "./location.js";
import { SELECT_LANES, type SelectLane } from "./select.js";

/**
 * The selector's vector leg (KOBE-409; hybrid ranking). It runs beside the keyword read, on its
 * own connection and transaction (`withTeam`, so RLS applies as everywhere), as soon as the
 * message's query vector arrives: per lane, the {@link VECTOR_READ_MAX} active items whose current
 * version is nearest to the query (cosine), among rows embedded by the query's model with the same
 * dimension count. Rows of another model, or without a vector, simply get no similarity: keyword
 * search still covers them.
 *
 * Bounded twice: the whole leg (query embedding included) must answer within
 * {@link VECTOR_LEG_DEADLINE_MS} of the start, and its statement has its own `statement_timeout`.
 * Late, failed or unavailable: the message is ranked by keywords alone. Nothing is written. No
 * vector index (RLS defeats it, as with GIN; per-Workspace sets are small).
 */

/** Nearest items read per lane. */
export const VECTOR_READ_MAX = 32;
/** The vector statement's own deadline. */
export const VECTOR_QUERY_TIMEOUT_MS = 30;
/** From the start of selection: the query vector and the vector statement, both. */
export const VECTOR_LEG_DEADLINE_MS = 45;

type SQL = ReturnType<typeof sql>;
const raw = (n: number) => sql.raw(String(n));

interface Who {
  readonly teamId: string;
  readonly userId: string;
}

function laneVectorQuery(who: Who, lane: SelectLane, model: string, dims: number): SQL {
  const loc = locate(lane, who.teamId, who.userId);
  // Keyword parts are filled in by the merge (`mergeVectorRows`): the keyword read already has
  // every row a word of the message matched; a row only the vector found matched none of them.
  return sql`
    SELECT ${lane}::text AS lane, c.id, c.kind, c.pinned, c.version, c.statement, c.actor_kind,
           to_char(c.as_of, 'YYYY-MM-DD') AS as_of,
           to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS saved_on,
           false AS matched, 0::float8 AS rank,
           GREATEST(0, extract(epoch FROM now() - c.created_at)::float8 / 86400) AS age_days,
           false AS sticky, -1 AS total, 1 - c.distance AS sim
      FROM (
        SELECT i.id, i.kind, i.pinned, i.current_version AS version, v.statement, v.actor_kind,
               ${loc.asOf} AS as_of, v.created_at,
               (v.embedding OPERATOR(public.<=>) p.e)::float8 AS distance
          FROM ${loc.items} i
          JOIN ${loc.versions} v ON ${loc.versionOf} AND v.version = i.current_version
          CROSS JOIN p
         WHERE ${loc.where} AND i.status = 'active' AND NOT ${loc.policy}
           AND v.embedding_model = ${model} AND v.embedding_dims = ${dims}
         ORDER BY distance, i.id
         LIMIT ${raw(VECTOR_READ_MAX)}
      ) c`;
}

/** The nearest rows of every lane (`total` -1 marks them; `sim` is the cosine similarity). */
export async function readVectorRows(db: KobeDb, who: Who, query: QueryVector): Promise<ItemRow[]> {
  const dims = query.vector.length;
  const parts = SELECT_LANES.map(
    (lane) =>
      sql`SELECT * FROM (${laneVectorQuery(who, lane, query.model, dims)}) AS ${sql.raw(`v_${lane}`)}`,
  );
  return withTeam(db, who.teamId, async (tx) => {
    await tx.execute(
      sql`SELECT set_config('statement_timeout', ${`${VECTOR_QUERY_TIMEOUT_MS}ms`}, true)`,
    );
    const res = await tx.execute<ItemRow>(sql`
      WITH p AS (SELECT ${vectorLiteral(query.vector)}::public.vector AS e)
      ${sql.join(parts, sql` UNION ALL `)}`);
    return res.rows;
  });
}

/**
 * Starts the vector leg for one message (call it before the keyword read, so the two overlap).
 * Resolves within `deadlineMs` to the nearest rows, or undefined (no query vector, late, failed).
 */
export function startVectorLeg(
  db: KobeDb,
  who: Who,
  queryVector: Promise<QueryVector | undefined>,
  deadlineMs = VECTOR_LEG_DEADLINE_MS,
): Promise<ItemRow[] | undefined> {
  const work = (async () => {
    const query = await queryVector;
    return query === undefined ? undefined : await readVectorRows(db, who, query);
  })().catch(() => undefined);
  const late = new Promise<undefined>((resolve) => {
    const timer = setTimeout(() => resolve(undefined), deadlineMs);
    void work.finally(() => clearTimeout(timer));
  });
  return Promise.race([work, late]);
}

/**
 * The keyword rows with their similarity, then the rows only the vector leg found, of the lanes
 * the switches allow (pure; tested). Policy rows are never in the vector leg (taken whole); a
 * vector row gets the stickiness the keyword read knows (`sticky` ids).
 */
export function mergeVectorRows(
  keyword: readonly ItemRow[],
  vector: readonly ItemRow[],
  lanes: readonly SelectLane[],
  sticky: readonly string[] = [],
): ItemRow[] {
  const allowed = new Set<string>(lanes);
  const sims = new Map(
    vector.filter((r) => allowed.has(r.lane)).map((r) => [`${r.lane}:${r.id}`, r]),
  );
  const out: ItemRow[] = keyword.map((r) => {
    const v = r.lane === "policy" ? undefined : sims.get(`${r.lane}:${r.id}`);
    if (v?.sim === undefined) return r;
    sims.delete(`${r.lane}:${r.id}`);
    return { ...r, sim: v.sim };
  });
  const stuck = new Set(sticky);
  const extra = [...sims.values()].map((r) => (stuck.has(r.id) ? { ...r, sticky: true } : r));
  return [...out, ...extra];
}
