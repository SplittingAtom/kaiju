import {
  KAIJU_MCP_MODE_KEY,
  KAIJU_MCP_TEAM_SETTING,
  parseKaijuMcpMode,
  parseKaijuMcpTeamLevel,
  siteSettings,
  sql,
  withTeam,
  type KaijuDb,
  type KaijuMcpMode,
  type KaijuMcpTeamLevel,
  type KaijuTx,
} from "@kaiju/db";
import { mcpServerSegment } from "@kaiju/protocol";
import { recordAudit } from "../audit/record.js";
import { kaijuBuiltinName, loadKaijuSwitches } from "./access.js";
import { isWriteTool } from "./catalog.js";
import { KAIJU_DOCS_TOOLS } from "./docs/index.js";
import { KAIJU_ADMIN_TOOLS } from "./tools/index.js";

/**
 * The Kaiju MCP switches as the consoles change them (KOBE-623, spec kaiju-admin-mcp §6, KA5): the
 * site switch `kobe_mcp.mode` (Site console › Settings, `site.settings.manage`) and the team level
 * `teams.settings.kobe_mcp.admin` (Team console › Connectors, `team.connectors.manage`). Each
 * change is audited; reads and the run/list/call checks use `access.ts`.
 */

/** The `kobe` connector as the Team console shows it. */
export interface KaijuTeamConnectorView {
  readonly connector_id: string | null;
  /** The built-in row's name (`kobe`, or `kobe-builtin`); null when it was never seeded. */
  readonly name: string | null;
  readonly mode: KaijuMcpMode;
  readonly level: KaijuMcpTeamLevel;
  /** Pi names of the docs tools (on every run while the site switch is not `off`). */
  readonly docs_tools: readonly string[];
  /** The admin tools by name; which the person gets depends on the switches and their role. */
  readonly admin_tools: readonly {
    readonly pi_name: string;
    readonly title: string;
    readonly scope: "team" | "site";
    readonly read_only: boolean;
  }[];
}

const SETTINGS_OBJECT = sql`CASE WHEN jsonb_typeof(settings) = 'object' THEN settings ELSE '{}'::jsonb END`;

/** The Team console's view of the built-in connector in `teamId`. */
export async function readKaijuTeamConnector(
  tx: Pick<KaijuTx, "execute">,
  teamId: string,
): Promise<KaijuTeamConnectorView> {
  const name = (await kaijuBuiltinName(tx)) ?? null;
  const switches = await loadKaijuSwitches(tx, teamId);
  const pi = (t: { readonly name: string }) =>
    `mcp__${mcpServerSegment(name ?? "kobe")}__${t.name}`;
  return {
    connector_id: name === null ? null : ((await builtinId(tx)) ?? null),
    name,
    mode: switches.mode,
    level: switches.level,
    docs_tools: KAIJU_DOCS_TOOLS.map(pi),
    admin_tools: KAIJU_ADMIN_TOOLS.map((t) => ({
      pi_name: pi(t),
      title: t.title,
      scope: t.scope,
      read_only: !isWriteTool(t),
    })),
  };
}

async function builtinId(tx: Pick<KaijuTx, "execute">): Promise<string | undefined> {
  const res = await tx.execute<{ id: string }>(
    sql`SELECT id FROM public.connectors WHERE builtin = 'kobe'`,
  );
  return res.rows[0]?.id;
}

export type SetLevelResult =
  | { readonly ok: true; readonly level: KaijuMcpTeamLevel }
  | { readonly ok: false; readonly error: "changed_since_approval" };

/**
 * Sets the team's level, audited `mcp.kobe.team_level_changed` when it changed. `expected`: only
 * while the level is still this one (the console's before-state), else `changed_since_approval`.
 * Serialized per team by the `teams` row lock.
 */
export async function setKaijuTeamLevel(
  db: KaijuDb,
  teamId: string,
  level: KaijuMcpTeamLevel,
  expected?: KaijuMcpTeamLevel,
): Promise<SetLevelResult> {
  return withTeam(db, teamId, async (tx) => {
    const current = await tx.execute<{ settings: unknown }>(
      sql`SELECT settings FROM public.teams WHERE id = ${teamId} FOR NO KEY UPDATE`,
    );
    const row = current.rows[0];
    if (!row) throw new Error("team not found");
    const from = parseKaijuMcpTeamLevel(row.settings);
    if (expected !== undefined && expected !== from) {
      return { ok: false, error: "changed_since_approval" } as const;
    }
    if (from === level) return { ok: true, level } as const;
    await tx.execute(sql`
      UPDATE public.teams
         SET settings = jsonb_set(${SETTINGS_OBJECT}, ${`{${KAIJU_MCP_TEAM_SETTING}}`}::text[],
                                  to_jsonb(${level}::text))
       WHERE id = ${teamId}`);
    await recordAudit(tx, {
      action: "mcp.kobe.team_level_changed",
      teamId,
      target: { from, to: level },
    });
    return { ok: true, level } as const;
  });
}

/** The site switch (default `docs`). */
export async function readKaijuMode(db: Pick<KaijuTx, "execute">): Promise<KaijuMcpMode> {
  const res = await db.execute<{ value: string }>(
    sql`SELECT value FROM public.site_settings WHERE key = ${KAIJU_MCP_MODE_KEY}`,
  );
  return parseKaijuMcpMode(res.rows[0]?.value);
}

/** Stores the site switch in `tx`, audited as `site.settings.updated` when it changed. */
export async function storeKaijuMode(tx: KaijuTx, mode: KaijuMcpMode): Promise<void> {
  if ((await readKaijuMode(tx)) === mode) return;
  await tx
    .insert(siteSettings)
    .values({ key: KAIJU_MCP_MODE_KEY, value: mode })
    .onConflictDoUpdate({ target: siteSettings.key, set: { value: mode, updatedAt: new Date() } });
  await recordAudit(tx, {
    action: "site.settings.updated",
    target: { setting: "kobe_mcp_mode", value: mode },
  });
}
