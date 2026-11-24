import { sql } from "drizzle-orm";
import type { KaijuDb } from "../client.js";
import {
  GIT_BUILTIN_CONNECTOR_ID,
  GIT_BUILTIN_CONNECTOR_URL,
  KAIJU_BUILTIN_CONNECTOR_ID,
  KAIJU_BUILTIN_CONNECTOR_URL,
  KAIJU_MCP_MODE_KEY,
  parseKaijuMcpMode,
  type KaijuMcpMode,
} from "../schema/connectors.js";

/** The `kobe` row's preferred name, and the fallback when a registered connector holds it. */
export const KAIJU_BUILTIN_NAMES = ["kobe", "kobe-builtin"] as const;

export type KaijuBuiltinSeed =
  /** The row was there already (another replica or an earlier start seeded it). */
  | { readonly outcome: "present"; readonly name: string }
  /** This call inserted it; `fallback` when `kobe` was taken by a registered connector. */
  | { readonly outcome: "seeded"; readonly name: string; readonly fallback: boolean }
  /** Both names are taken by registered connectors: no row, the server logs it. */
  | { readonly outcome: "names_taken" };

const pgServerSegment = (name: string) => name.replace(/-/g, "_");

/**
 * Seeds the built-in `kobe` connector row (KOBE-618, spec kaiju-admin-mcp §11 KA-1). Idempotent and
 * safe across replicas starting together: the row has a fixed id, and the insert does nothing on
 * any unique conflict (id, `builtin`, name or Pi server segment), so exactly one row exists after
 * any number of concurrent calls. Named `kobe`, or `kobe-builtin` when a registered connector
 * already uses `kobe` (or its Pi segment); the caller logs the fallback.
 */
export async function seedKaijuBuiltinConnector(db: KaijuDb): Promise<KaijuBuiltinSeed> {
  const existing = async () => {
    const res = await db.execute<{ name: string }>(
      sql`SELECT name FROM public.connectors WHERE builtin = 'kobe'`,
    );
    return res.rows[0]?.name;
  };
  const before = await existing();
  if (before !== undefined) return { outcome: "present", name: before };
  for (const [index, name] of KAIJU_BUILTIN_NAMES.entries()) {
    const inserted = await db.execute<{ name: string }>(sql`
      INSERT INTO public.connectors (id, name, url, auth_kind, credential_source, builtin)
      SELECT ${KAIJU_BUILTIN_CONNECTOR_ID}::uuid, ${name}, ${KAIJU_BUILTIN_CONNECTOR_URL},
             'none', 'member', 'kobe'
       WHERE NOT EXISTS (
         SELECT 1 FROM public.connectors c
          WHERE c.builtin IS NULL AND replace(c.name, '-', '_') = ${pgServerSegment(name)})
      ON CONFLICT DO NOTHING
      RETURNING name`);
    const row = inserted.rows[0];
    if (row !== undefined) return { outcome: "seeded", name: row.name, fallback: index > 0 };
    // Another replica may have won the race meanwhile: its row is the one.
    const raced = await existing();
    if (raced !== undefined) return { outcome: "present", name: raced };
  }
  return { outcome: "names_taken" };
}

/** The site switch `kobe_mcp.mode` (KA5): `docs` when unset or unreadable as a mode. */
export async function readKaijuMcpMode(db: Pick<KaijuDb, "execute">): Promise<KaijuMcpMode> {
  const res = await db.execute<{ value: string }>(
    sql`SELECT value FROM public.site_settings WHERE key = ${KAIJU_MCP_MODE_KEY}`,
  );
  return parseKaijuMcpMode(res.rows[0]?.value);
}

/** The `git` row's preferred name, and the fallback when a registered connector holds it. */
export const GIT_BUILTIN_NAMES = ["kobe-git", "kobe-git-builtin"] as const;

/**
 * Seeds the built-in `git` connector row (KOBE-762): the git host tools as their own connector.
 * Idempotent and race-safe exactly as {@link seedKaijuBuiltinConnector}.
 */
export async function seedGitBuiltinConnector(db: KaijuDb): Promise<KaijuBuiltinSeed> {
  const existing = async () => {
    const res = await db.execute<{ name: string }>(
      sql`SELECT name FROM public.connectors WHERE builtin = 'git'`,
    );
    return res.rows[0]?.name;
  };
  const before = await existing();
  if (before !== undefined) return { outcome: "present", name: before };
  for (const [index, name] of GIT_BUILTIN_NAMES.entries()) {
    const inserted = await db.execute<{ name: string }>(sql`
      INSERT INTO public.connectors (id, name, url, auth_kind, credential_source, builtin)
      SELECT ${GIT_BUILTIN_CONNECTOR_ID}::uuid, ${name}, ${GIT_BUILTIN_CONNECTOR_URL},
             'none', 'member', 'git'
       WHERE NOT EXISTS (
         SELECT 1 FROM public.connectors c
          WHERE c.builtin IS NULL AND replace(c.name, '-', '_') = ${pgServerSegment(name)})
      ON CONFLICT DO NOTHING
      RETURNING name`);
    const row = inserted.rows[0];
    if (row !== undefined) return { outcome: "seeded", name: row.name, fallback: index > 0 };
    const raced = await existing();
    if (raced !== undefined) return { outcome: "present", name: raced };
  }
  return { outcome: "names_taken" };
}
