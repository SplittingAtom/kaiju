import {
  KAIJU_BUILTIN_CONNECTOR_ID,
  parseKaijuMcpMode,
  parseKaijuMcpTeamLevel,
  sql,
  KAIJU_MCP_MODE_KEY,
  type KaijuMcpMode,
  type KaijuMcpTeamLevel,
  type KaijuTx,
  type TeamRole,
} from "@kaiju/db";
import { SITE_GRANTS, type SiteGrant } from "@kaiju/protocol";
import {
  siteMemoryAllows,
  skillReviewAllows,
  teamMemoryAllows,
  type SiteRole,
} from "../authz/permissions.js";
import type { KaijuTool } from "./catalog.js";
import { KAIJU_ADMIN_TOOLS } from "./tools/index.js";

/**
 * Who may use which Kaiju MCP tool right now (KOBE-619, spec kobe-admin-mcp §3, §6, §8): the site
 * switch (`kobe_mcp.mode`), the team's level (`teams.settings.kobe_mcp.admin`) and the person's
 * own permission (team role, site role), all re-read from the database for every list and call.
 */

/** Anything with `execute` (a pool or a transaction): every read here is a plain statement. */
type Reader = Pick<KaijuTx, "execute">;

export interface KaijuBuiltinRow {
  readonly id: string;
  readonly name: string;
}

export interface KaijuAccess {
  readonly mode: KaijuMcpMode;
  readonly level: KaijuMcpTeamLevel;
  /** The person's role in the team; null when no longer a member. */
  readonly teamRole: TeamRole | null;
  /** A Workspace memory steward of the team (KOBE-380): adds `team.memory.curate` (KOBE-650). */
  readonly memorySteward: boolean;
  readonly siteRole: SiteRole;
  /** The person's site grants (Skill reviewer, KOBE-622); none for an inactive account. */
  readonly grants: readonly SiteGrant[];
}

/** The seeded `kobe` row while it is active and the site switch is not `off`. */
export async function loadKaijuBuiltin(db: Reader): Promise<KaijuBuiltinRow | undefined> {
  const res = await db.execute<{ id: string; name: string; mode: string | null }>(sql`
    SELECT c.id, c.name,
           (SELECT s.value FROM public.site_settings s WHERE s.key = ${KAIJU_MCP_MODE_KEY}) AS mode
      FROM public.connectors c
     WHERE c.builtin = 'kobe' AND c.id = ${KAIJU_BUILTIN_CONNECTOR_ID}
       AND c.status = 'active' AND c.deleted_at IS NULL`);
  const row = res.rows[0];
  if (row === undefined || parseKaijuMcpMode(row.mode) === "off") return undefined;
  return { id: row.id, name: row.name };
}

/** The built-in row's name whatever the switches say (`kobe`, or `kobe-builtin`), if seeded. */
export async function kaijuBuiltinName(db: Reader): Promise<string | undefined> {
  const res = await db.execute<{ name: string }>(
    sql`SELECT name FROM public.connectors WHERE builtin = 'kobe'`,
  );
  return res.rows[0]?.name;
}

/** Switches only (no person): the engine's view of the connector in a team. */
export async function loadKaijuSwitches(
  db: Reader,
  teamId: string,
): Promise<{ mode: KaijuMcpMode; level: KaijuMcpTeamLevel }> {
  const res = await db.execute<{ mode: string | null; settings: unknown }>(sql`
    SELECT (SELECT s.value FROM public.site_settings s WHERE s.key = ${KAIJU_MCP_MODE_KEY}) AS mode,
           (SELECT t.settings FROM public.teams t WHERE t.id = ${teamId}) AS settings`);
  const row = res.rows[0];
  return { mode: parseKaijuMcpMode(row?.mode), level: parseKaijuMcpTeamLevel(row?.settings) };
}

/**
 * The switches and the person's roles. `team_members` is a team table: run inside
 * `withTeam(teamId)` (or the role reads as null and nothing is allowed).
 */
export async function loadKaijuAccess(
  db: Reader,
  teamId: string,
  userId: string,
): Promise<KaijuAccess> {
  const switches = await loadKaijuSwitches(db, teamId);
  const res = await db.execute<{ team_role: TeamRole | null; site_role: SiteRole }>(sql`
    SELECT (SELECT m.role FROM public.team_members m
             WHERE m.team_id = ${teamId} AND m.user_id = ${userId}) AS team_role,
           (SELECT r.role FROM public.site_roles r WHERE r.user_id = ${userId}) AS site_role,
           EXISTS (SELECT 1 FROM public.memory_stewards s
                    WHERE s.team_id = ${teamId} AND s.user_id = ${userId}) AS steward,
           (SELECT u.deactivated_at IS NOT NULL FROM public.users u WHERE u.id = ${userId}) AS gone,
           (SELECT coalesce(array_agg(g."grant"::text ORDER BY g."grant"), '{}')
              FROM public.site_grants g WHERE g.user_id = ${userId}) AS grants`);
  const row = res.rows[0] as {
    team_role: TeamRole | null;
    site_role: SiteRole;
    steward?: boolean;
    gone?: boolean;
    grants?: unknown;
  };
  const active = row !== undefined && row.gone === false;
  return {
    ...switches,
    teamRole: active ? row.team_role : null,
    memorySteward: active && row.steward === true,
    siteRole: active ? (row.site_role ?? null) : null,
    grants: active ? parseGrants(row.grants) : [],
  };
}

const KNOWN_GRANTS: ReadonlySet<string> = new Set<string>(SITE_GRANTS);

/** `array_agg` comes back as an array (or its text form on some drivers): known grants only. */
function parseGrants(value: unknown): SiteGrant[] {
  const list = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.replace(/^\{|\}$/g, "").split(",")
      : [];
  return list.filter((g): g is SiteGrant => typeof g === "string" && KNOWN_GRANTS.has(g));
}

/** The site and team switches allow the tool (KA5: admin tools only with `admin` + a level). */
export function switchesAllow(
  tool: KaijuTool,
  switches: { readonly mode: KaijuMcpMode; readonly level: KaijuMcpTeamLevel },
): boolean {
  if (switches.mode !== "admin") return false;
  if (switches.level === "read") return tool.readOnly;
  return switches.level === "read_write";
}

/**
 * The person holds the tool's console permission (and is still a member of the team). Memory
 * stewards (KOBE-380) hold the curate permissions as in the console (`teamMemoryAllows`,
 * `siteMemoryAllows`); for every other permission these are the plain role checks.
 */
export function personAllows(tool: KaijuTool, access: KaijuAccess): boolean {
  if (access.teamRole === null) return false;
  if (tool.scope === "team")
    return teamMemoryAllows(
      { role: access.teamRole, memorySteward: access.memorySteward },
      tool.permission,
    );
  // A Skill Registry tool: the page's own action check, Skill reviewer grant included (SK22).
  if (tool.skillReview !== undefined) {
    return skillReviewAllows(
      { siteRole: access.siteRole, grants: access.grants },
      tool.skillReview,
    );
  }
  return siteMemoryAllows({ siteRole: access.siteRole, grants: access.grants }, tool.permission);
}

/** The tools this person may list and call now. */
export function allowedKaijuTools(access: KaijuAccess): KaijuTool[] {
  return KAIJU_ADMIN_TOOLS.filter((t) => switchesAllow(t, access) && personAllows(t, access));
}
