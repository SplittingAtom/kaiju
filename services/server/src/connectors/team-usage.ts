import {
  and,
  asc,
  connectors,
  eq,
  isNull,
  parseToolsSnapshot,
  teamConnectors,
  teams,
  withTeam,
  type ConnectorExposureKind,
  type KaijuDb,
} from "@kaiju/db";
import { mapLimited } from "../mcp/fan-out.js";

/** Team transactions in flight at once: a few connections from the pool, never one per team. */
const TEAM_READ_CONCURRENCY = 4;

/** One team that has a connector enabled, as the site connector detail panel shows it (KOBE-641). */
export interface ConnectorTeamUse {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly exposure: ConnectorExposureKind;
  /** How many tools a `custom` exposure ticks (0 otherwise); never which credentials exist. */
  readonly enabled_tools: number;
}

/** One team's enablement row for the connector. */
interface Enablement {
  readonly team: { readonly id: string; readonly name: string; readonly slug: string };
  readonly row: {
    readonly exposure: ConnectorExposureKind;
    readonly enabledTools: string[];
  };
}

/**
 * The one walk over "which teams enabled connector X" (KOBE-784, P2-32; it had three copies).
 * `team_connectors` is a team table and RLS never lets one query see every team, so this reads
 * each team in its own `withTeam`, a few at a time (`TEAM_READ_CONCURRENCY`), ordered by team name.
 */
async function enablementsOf(db: KaijuDb, connectorId: string): Promise<Enablement[]> {
  const all = await db
    .select({ id: teams.id, name: teams.name, slug: teams.slug })
    .from(teams)
    .orderBy(asc(teams.name), asc(teams.slug));
  const rows = await mapLimited(all, TEAM_READ_CONCURRENCY, async (team) => {
    const [row] = await withTeam(db, team.id, (tx) =>
      tx
        .select({ exposure: teamConnectors.exposure, enabledTools: teamConnectors.enabledTools })
        .from(teamConnectors)
        .where(
          and(eq(teamConnectors.teamId, team.id), eq(teamConnectors.connectorId, connectorId)),
        ),
    );
    return row ? { team, row } : null;
  });
  return rows.flatMap((r) => (r === null ? [] : [r]));
}

/** Ids of the teams that have the connector enabled (removal counts, drift recipients). */
export async function teamIdsUsing(db: KaijuDb, connectorId: string): Promise<string[]> {
  return (await enablementsOf(db, connectorId)).map((e) => e.team.id);
}

/**
 * The teams that have the connector enabled, with their exposure, ordered by team name; undefined
 * when the connector is unknown, removed or the built-in Kaiju connector (which has team levels, not
 * enablements). A custom count only counts ticks that still name a pinned tool.
 */
export async function listTeamsUsing(
  db: KaijuDb,
  connectorId: string,
): Promise<ConnectorTeamUse[] | undefined> {
  const [found] = await db
    .select({ snapshot: connectors.toolsSnapshot })
    .from(connectors)
    .where(
      and(eq(connectors.id, connectorId), isNull(connectors.deletedAt), isNull(connectors.builtin)),
    );
  if (!found) return undefined;
  const pinned = new Set(
    parseToolsSnapshot(found.snapshot)
      .filter((t) => t.status === "pinned")
      .map((t) => t.pi_name),
  );
  return (await enablementsOf(db, connectorId)).map(({ team, row }) => ({
    ...team,
    exposure: row.exposure,
    enabled_tools:
      row.exposure === "custom" ? row.enabledTools.filter((t) => pinned.has(t)).length : 0,
  }));
}
