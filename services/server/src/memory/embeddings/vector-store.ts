import { scanTeams, sql, type KobeDb, type KobeTx } from "@kobe/db";
import { MEMORY_EMBED_MAX_DIMS } from "@kobe/protocol";

/**
 * Raw SQL over the embedding columns of the three memory version tables (KOBE-409; migration
 * 0230, not in the drizzle schema). Workspace rows only inside `withTeam()` (RLS); the site-wide
 * tables through the app role's column UPDATE grant. Vectors are written only onto the current
 * version of an item that is active or archived (a restore brings it back; superseded items are
 * never selected), each with the model that made it and its dimension count.
 */

type SQL = ReturnType<typeof sql>;

/** Which version table: Workspace (`user` and `team` items), portable, or Site. */
export type VectorTable = "workspace" | "portable" | "site";

interface TableSql {
  readonly items: SQL;
  readonly versions: SQL;
  readonly join: SQL;
}

const TABLES: Readonly<Record<VectorTable, TableSql>> = {
  workspace: {
    items: sql.raw("semantic_memory_items"),
    versions: sql.raw("semantic_memory_item_versions"),
    join: sql`v.team_id = i.team_id AND v.item_id = i.id`,
  },
  portable: {
    items: sql.raw("portable_memory_items"),
    versions: sql.raw("portable_memory_item_versions"),
    join: sql`v.item_id = i.id`,
  },
  site: {
    items: sql.raw("site_memory_items"),
    versions: sql.raw("site_memory_item_versions"),
    join: sql`v.item_id = i.id`,
  },
};

/** One version whose vector is missing or made by another model. */
export interface PendingVersion {
  readonly itemId: string;
  readonly version: number;
  readonly statement: string;
}

/** `[1,2,3]`, pgvector's text form; refuses non-finite values and oversized vectors. */
export function vectorLiteral(vector: readonly number[]): string {
  if (vector.length === 0 || vector.length > MEMORY_EMBED_MAX_DIMS)
    throw new Error("embedding has an unsupported dimension count");
  if (!vector.every((x) => Number.isFinite(x))) throw new Error("embedding is not finite");
  return `[${vector.join(",")}]`;
}

const uuids = (ids: readonly string[]): SQL => sql`${`{${ids.join(",")}}`}::uuid[]`;

/**
 * Current versions of `table` without a vector of `model`, at most `limit`, by item id. Workspace
 * rows need `teamId` (the transaction's team); `itemIds` narrows to the items just saved.
 */
export async function pendingVersions(
  tx: KobeTx,
  table: VectorTable,
  opts: {
    readonly teamId?: string;
    readonly model: string;
    readonly limit: number;
    readonly itemIds?: readonly string[];
    readonly ownerUserId?: string;
  },
): Promise<PendingVersion[]> {
  const t = TABLES[table];
  const team = table === "workspace" ? sql`AND i.team_id = ${opts.teamId ?? null}::uuid` : sql``;
  const ids = opts.itemIds ? sql`AND i.id = ANY(${uuids(opts.itemIds)})` : sql``;
  const owner =
    opts.ownerUserId === undefined ? sql`` : sql`AND i.owner_user_id = ${opts.ownerUserId}::uuid`;
  const res = await tx.execute<{ item_id: string; version: number; statement: string }>(sql`
    SELECT i.id AS item_id, v.version, v.statement
      FROM ${t.items} i JOIN ${t.versions} v ON ${t.join} AND v.version = i.current_version
     WHERE i.status IN ('active', 'archived') ${team} ${ids} ${owner}
       AND v.embedding_model IS DISTINCT FROM ${opts.model}
     ORDER BY i.id LIMIT ${opts.limit}`);
  return res.rows.map((r) => ({
    itemId: r.item_id,
    version: Number(r.version),
    statement: r.statement,
  }));
}

/** Stores one vector per version (made by `model`); a version that moved on is left alone. */
export async function writeVectors(
  tx: KobeTx,
  table: VectorTable,
  teamId: string | undefined,
  model: string,
  rows: readonly { readonly itemId: string; readonly version: number; readonly vector: number[] }[],
): Promise<number> {
  const t = TABLES[table];
  let written = 0;
  for (const r of rows) {
    const team = table === "workspace" ? sql`AND team_id = ${teamId ?? null}::uuid` : sql``;
    const res = await tx.execute(sql`
      UPDATE ${t.versions}
         SET embedding = ${vectorLiteral(r.vector)}::public.vector,
             embedding_model = ${model}, embedding_dims = ${r.vector.length}
       WHERE item_id = ${r.itemId}::uuid AND version = ${r.version} ${team}`);
    written += res.rowCount ?? 0;
  }
  return written;
}

/** Items that can carry a vector, and those with one of `model` (current versions). */
export interface Coverage {
  readonly embedded: number;
  readonly total: number;
}

async function countTable(
  tx: KobeTx,
  table: VectorTable,
  model: string | null,
  teamId?: string,
): Promise<Coverage> {
  const t = TABLES[table];
  const team = table === "workspace" ? sql`AND i.team_id = ${teamId ?? null}::uuid` : sql``;
  const res = await tx.execute<{ embedded: string | number; total: string | number }>(sql`
    SELECT count(*) FILTER (WHERE v.embedding_model = ${model}) AS embedded, count(*) AS total
      FROM ${t.items} i JOIN ${t.versions} v ON ${t.join} AND v.version = i.current_version
     WHERE i.status IN ('active', 'archived') ${team}`);
  return { embedded: Number(res.rows[0]?.embedded ?? 0), total: Number(res.rows[0]?.total ?? 0) };
}

/** Coverage of every Workspace's items (one team at a time, RLS), portable and Site items. */
export async function readCoverage(db: KobeDb, model: string | null): Promise<Coverage> {
  const teams = await scanTeams(db, "memory vector coverage", (tx, team) =>
    countTable(tx, "workspace", model, team.id),
  );
  const rest = await db.transaction(async (tx) => [
    await countTable(tx, "portable", model),
    await countTable(tx, "site", model),
  ]);
  return [...teams, ...rest].reduce(
    (a, b) => ({ embedded: a.embedded + b.embedded, total: a.total + b.total }),
    { embedded: 0, total: 0 },
  );
}
