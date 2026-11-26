import { DEFAULT_AGENT_VARIABLE_VALUES, type TeamAgentVariableValues } from "@kaiju/protocol";
import { siteSettings, sql, withTeam, type KaijuDb, type KaijuTx } from "@kaiju/db";
import { recordAudit } from "../audit/record.js";

/**
 * Whether the agent's `editor_read {what: "variables"}` shows the values of strings, bytes and
 * containers (KOBE-848 review M1; Chris, 2026-11-26). Stored like the remember limits: the Site
 * default in `site_settings` (one key, `true`/`false`), a team's choice in `teams.settings` (key
 * `agent_variable_values`, a boolean; absent = follow the Site; no migration). Anything stored
 * that is not a boolean reads as off (fail closed). Default off.
 */
export const SITE_AGENT_VARIABLE_VALUES_KEY = "notebooks.agent_variable_values";
export const TEAM_AGENT_VARIABLE_VALUES_SETTING = "agent_variable_values";

const siteValue = (raw: string | null | undefined): boolean =>
  raw === null || raw === undefined ? DEFAULT_AGENT_VARIABLE_VALUES : raw === "true";

const teamValue = (raw: unknown): boolean | null =>
  raw === null || raw === undefined ? null : raw === true;

/** The Site default, the team's choice and what applies, in one statement (site tables). */
export async function readTeamAgentVariableValues(
  db: KaijuDb | KaijuTx,
  teamId: string,
): Promise<TeamAgentVariableValues> {
  const res = await db.execute<{ site: string | null; team: unknown }>(sql`
    SELECT (SELECT value FROM site_settings WHERE key = ${SITE_AGENT_VARIABLE_VALUES_KEY}) AS site,
           (SELECT CASE WHEN jsonb_typeof(settings) = 'object'
                        THEN settings -> ${TEAM_AGENT_VARIABLE_VALUES_SETTING} END
              FROM teams WHERE id = ${teamId}) AS team`);
  const row = res.rows[0];
  const site = siteValue(row?.site);
  const team = teamValue(row?.team);
  return { site, team, effective: team ?? site };
}

export async function readSiteAgentVariableValues(db: KaijuDb): Promise<boolean> {
  const res = await db.execute<{ value: string }>(sql`
    SELECT value FROM site_settings WHERE key = ${SITE_AGENT_VARIABLE_VALUES_KEY}`);
  return siteValue(res.rows[0]?.value);
}

/** Saves the Site default, audited (`policy.agent_variable_values.updated`, scope site). */
export async function writeSiteAgentVariableValues(db: KaijuDb, enabled: boolean): Promise<void> {
  const value = enabled ? "true" : "false";
  await db.transaction(async (tx) => {
    await tx
      .insert(siteSettings)
      .values({ key: SITE_AGENT_VARIABLE_VALUES_KEY, value })
      .onConflictDoUpdate({ target: siteSettings.key, set: { value, updatedAt: new Date() } });
    await recordAudit(tx, {
      action: "policy.agent_variable_values.updated",
      target: { scope: "site", enabled },
    });
  });
}

/** Saves a team's choice (`null`: follow the Site), audited; answers what now applies. */
export async function writeTeamAgentVariableValues(
  db: KaijuDb,
  teamId: string,
  enabled: boolean | null,
): Promise<TeamAgentVariableValues> {
  return withTeam(db, teamId, async (tx) => {
    const base = sql`CASE WHEN jsonb_typeof(settings) = 'object' THEN settings ELSE '{}'::jsonb END`;
    await tx.execute(
      enabled === null
        ? sql`UPDATE teams SET settings = ${base} - ${TEAM_AGENT_VARIABLE_VALUES_SETTING}::text
               WHERE id = ${teamId}`
        : sql`UPDATE teams
                 SET settings = jsonb_set(${base},
                       ${`{${TEAM_AGENT_VARIABLE_VALUES_SETTING}}`}::text[], ${JSON.stringify(enabled)}::jsonb)
               WHERE id = ${teamId}`,
    );
    await recordAudit(tx, {
      action: "policy.agent_variable_values.updated",
      teamId,
      target: { scope: "team", enabled },
    });
    return readTeamAgentVariableValues(tx, teamId);
  });
}
