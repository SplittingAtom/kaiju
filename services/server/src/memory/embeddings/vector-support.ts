import { sql, type KobeDb, type KobeTx } from "@kobe/db";

/**
 * Whether this database can hold memory vectors (KOBE-409): the pgvector extension (enabled in the
 * database, only available on the server, or missing) and the embedding columns migration 0230
 * adds where pgvector is enabled (`kobe_ensure_memory_vectors()`, run after every migration). The
 * columns are in no drizzle schema, so the server detects them here and uses raw SQL; without
 * them memory search is keyword-only and the Site console says what to do.
 */
export interface VectorSupport {
  readonly extension: "enabled" | "available" | "missing";
  /** The embedding columns exist on all three version tables. */
  readonly columns: boolean;
}

export const VERSION_TABLES = [
  "semantic_memory_item_versions",
  "portable_memory_item_versions",
  "site_memory_item_versions",
] as const;

export async function readVectorSupport(db: KobeDb | KobeTx): Promise<VectorSupport> {
  const res = await db.execute<{ enabled: boolean; available: boolean; columns: number | string }>(
    sql`SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS enabled,
               EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') AS available,
               (SELECT count(DISTINCT table_name) FROM information_schema.columns
                 WHERE table_schema = 'public' AND column_name = 'embedding_model'
                   AND table_name IN (${sql.join(
                     VERSION_TABLES.map((t) => sql`${t}`),
                     sql`, `,
                   )})) AS columns`,
  );
  const row = res.rows[0];
  const extension = row?.enabled ? "enabled" : row?.available ? "available" : "missing";
  return { extension, columns: extension === "enabled" && Number(row?.columns ?? 0) === 3 };
}
