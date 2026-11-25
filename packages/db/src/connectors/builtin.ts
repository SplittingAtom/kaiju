import { parseMcpToolName } from "@kaiju/protocol";
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

/** The `kaiju` row's preferred name, and the fallback when a registered connector holds it. */
export const KAIJU_BUILTIN_NAMES = ["kaiju", "kaiju-builtin"] as const;

export type KaijuBuiltinSeed =
  /** The row was there already (another replica or an earlier start seeded it). */
  | { readonly outcome: "present"; readonly name: string }
  /** This call inserted it; `fallback` when `kaiju` was taken by a registered connector. */
  | { readonly outcome: "seeded"; readonly name: string; readonly fallback: boolean }
  /** Both names are taken by registered connectors: no row, the server logs it. */
  | { readonly outcome: "names_taken" };

const pgServerSegment = (name: string) => name.replace(/-/g, "_");

/**
 * Seeds the built-in `kaiju` connector row (KOBE-618, spec kobe-admin-mcp §11 KA-1). Idempotent and
 * safe across replicas starting together: the row has a fixed id, and the insert does nothing on
 * any unique conflict (id, `builtin`, name or Pi server segment), so exactly one row exists after
 * any number of concurrent calls. Named `kaiju`, or `kaiju-builtin` when a registered connector
 * already uses `kaiju` (or its Pi segment); the caller logs the fallback. An install from before
 * the rename already has the row: migration 0260 renamed it (KOBE-826), so this finds it.
 */
export async function seedKaijuBuiltinConnector(db: KaijuDb): Promise<KaijuBuiltinSeed> {
  const existing = async () => {
    const res = await db.execute<{ name: string }>(
      sql`SELECT name FROM public.connectors WHERE builtin = 'kaiju'`,
    );
    return res.rows[0]?.name;
  };
  const before = await existing();
  if (before !== undefined) return { outcome: "present", name: before };
  for (const [index, name] of KAIJU_BUILTIN_NAMES.entries()) {
    const inserted = await db.execute<{ name: string }>(sql`
      INSERT INTO public.connectors (id, name, url, auth_kind, credential_source, builtin)
      SELECT ${KAIJU_BUILTIN_CONNECTOR_ID}::uuid, ${name}, ${KAIJU_BUILTIN_CONNECTOR_URL},
             'none', 'member', 'kaiju'
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

/** The site switch `kaiju_mcp.mode` (KA5): `docs` when unset or unreadable as a mode. */
export async function readKaijuMcpMode(db: Pick<KaijuDb, "execute">): Promise<KaijuMcpMode> {
  const res = await db.execute<{ value: string }>(
    sql`SELECT value FROM public.site_settings WHERE key = ${KAIJU_MCP_MODE_KEY}`,
  );
  return parseKaijuMcpMode(res.rows[0]?.value);
}

/** The `git` row's preferred name, and the fallback when a registered connector holds it. */
export const GIT_BUILTIN_NAMES = ["kaiju-git", "kaiju-git-builtin"] as const;

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

/**
 * What migration 0260 renamed (KOBE-826, spec rename-kaiju §11 A3), kept in `site_settings` under
 * this key: `{"segments": {"<old Pi server segment>": "<new segment>"}}`, only for a built-in whose
 * name it changed (`kobe` → `kaiju`, `kobe-git` → `kaiju-git`, the `-builtin` fallbacks alike; a
 * registered connector holding the new name keeps the built-in on its old one). Readers use it
 * where stored or remembered history names the old tools: the audit view explains them, shared
 * threads keep hiding old admin results, and the policy engine tells a model that calls an old
 * name which name to call instead. Written once by the migration; nothing else writes it.
 */
export const BUILTIN_RENAMES_KEY = "kaiju_mcp.renamed";

export interface BuiltinRenames {
  /** Old Pi server segment → the segment the built-in has had since the rename. */
  readonly segments: Readonly<Record<string, string>>;
}

export const NO_BUILTIN_RENAMES: BuiltinRenames = { segments: {} };

const SEGMENT = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

/** The stored marker, or none when absent or unreadable (never throws). */
export function parseBuiltinRenames(value: string | null | undefined): BuiltinRenames {
  if (typeof value !== "string") return NO_BUILTIN_RENAMES;
  try {
    const parsed: unknown = JSON.parse(value);
    const segments =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>).segments
        : undefined;
    if (typeof segments !== "object" || segments === null || Array.isArray(segments)) {
      return NO_BUILTIN_RENAMES;
    }
    const entries = Object.entries(segments).filter(
      (e): e is [string, string] =>
        SEGMENT.test(e[0]) && typeof e[1] === "string" && SEGMENT.test(e[1]) && e[0] !== e[1],
    );
    return { segments: Object.fromEntries(entries) };
  } catch {
    return NO_BUILTIN_RENAMES;
  }
}

/** The marker as stored (none when the migration renamed nothing or a reset removed it). */
export async function readBuiltinRenames(db: Pick<KaijuDb, "execute">): Promise<BuiltinRenames> {
  const res = await db.execute<{ value: string }>(
    sql`SELECT value FROM public.site_settings WHERE key = ${BUILTIN_RENAMES_KEY}`,
  );
  return parseBuiltinRenames(res.rows[0]?.value);
}

/**
 * The name a pre-rename built-in tool has now (`mcp__kobe__docs_index` → `mcp__kaiju__docs_index`),
 * or undefined when `piName` does not start with a renamed segment.
 */
export function renamedBuiltinToolName(
  renames: BuiltinRenames,
  piName: string,
): string | undefined {
  const parsed = parseMcpToolName(piName);
  if (!parsed) return undefined;
  const now = Object.hasOwn(renames.segments, parsed.server_segment)
    ? renames.segments[parsed.server_segment]
    : undefined;
  return now === undefined ? undefined : `mcp__${now}__${parsed.tool_segment}`;
}
