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
  siteSettingValue,
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
    sql`SELECT ${siteSettingValue(KAIJU_MCP_MODE_KEY)} AS value`,
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
 * Connector names only the built-ins may hold (KOBE-826 review L1/L2), current and pre-rename:
 * registering or renaming a connector to one is refused (as are names equal to one after `-` →
 * `_`, which Pi treats alike). The pre-rename names stay reserved so a third-party server never
 * takes over tool names that audit rows, threads and rules give the built-ins' history. Migration
 * 0260 moved a registered `kaiju` or `kaiju-git` out of the way (`kaiju-registered`).
 */
export const RESERVED_CONNECTOR_NAMES: readonly string[] = [
  ...KAIJU_BUILTIN_NAMES,
  ...GIT_BUILTIN_NAMES,
  "kobe",
  "kobe-builtin",
  "kobe-git",
  "kobe-git-builtin",
];

/** Whether `name` (or a name Pi treats as the same) is reserved for a built-in connector. */
export function isReservedConnectorName(name: string): boolean {
  const segment = pgServerSegment(name);
  return RESERVED_CONNECTOR_NAMES.some((r) => pgServerSegment(r) === segment);
}

/**
 * What migration 0260 renamed (KOBE-826, spec rename-kaiju §11 A3), kept in `site_settings` under
 * this key: `{"segments": {"<old>": "<new>"}, "registered": {"<old>": "<new>"}}`, Pi server
 * segments only where a name changed. `segments`: the built-ins (`kobe` → `kaiju`, `kobe_git` →
 * `kaiju_git`; `kobe_builtin` where the built-in had fallen back). `registered`: a registered
 * connector that held a name now reserved for a built-in, moved out of its way (`kaiju` →
 * `kaiju_registered`). Readers use it where stored history or rules name the old tools: the audit
 * view explains the built-ins' old names, shared threads keep hiding old admin results, the policy
 * engine tells a model that calls an old built-in name which name to call, and deny and ask rules
 * also match every tool under its old name (`previousToolNames`), so a rename never widens a
 * permission. Written once by the migration; nothing else writes it.
 */
export const BUILTIN_RENAMES_KEY = "kaiju_mcp.renamed";

export interface BuiltinRenames {
  /** Old Pi server segment of a built-in → the segment it has had since the rename. */
  readonly segments: Readonly<Record<string, string>>;
  /** Old segment of a registered connector moved out of a built-in's way → its new one. */
  readonly registered: Readonly<Record<string, string>>;
}

export const NO_BUILTIN_RENAMES: BuiltinRenames = { segments: {}, registered: {} };

const SEGMENT = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

function segmentMap(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (e): e is [string, string] =>
        SEGMENT.test(e[0]) && typeof e[1] === "string" && SEGMENT.test(e[1]) && e[0] !== e[1],
    ),
  );
}

/** The stored marker, or none when absent or unreadable (never throws). */
export function parseBuiltinRenames(value: string | null | undefined): BuiltinRenames {
  if (typeof value !== "string") return NO_BUILTIN_RENAMES;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return NO_BUILTIN_RENAMES;
    const { segments, registered } = parsed as Record<string, unknown>;
    return { segments: segmentMap(segments), registered: segmentMap(registered) };
  } catch {
    return NO_BUILTIN_RENAMES;
  }
}

/**
 * The names a tool had before the rename, built-in or registered (`mcp__kaiju__x` →
 * `[mcp__kobe__x]`), which deny and ask rules also match (KOBE-826 review H1). Empty for a tool
 * whose connector was not renamed.
 */
export function previousToolNames(renames: BuiltinRenames, piName: string): string[] {
  const parsed = parseMcpToolName(piName);
  if (!parsed) return [];
  return [...Object.entries(renames.segments), ...Object.entries(renames.registered)]
    .filter(([, now]) => now === parsed.server_segment)
    .map(([before]) => `mcp__${before}__${parsed.tool_segment}`);
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
