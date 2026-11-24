import { withTeam, type KaijuDb, type KaijuTx } from "@kaiju/db";
import { registryTeamFor } from "./settings.js";

/**
 * A Registry decision's transaction (review-335 L3): in the Registry team's RLS context when one
 * exists, so it can also cancel the version's open re-runs (team rows) atomically; the registry
 * tables themselves are site-wide.
 */
export async function inRegistryTx<T>(
  db: KaijuDb,
  fn: (tx: KaijuTx, registryTeamId: string | null) => Promise<T>,
): Promise<T> {
  const teamId = await registryTeamFor(db);
  return teamId
    ? withTeam(db, teamId, (tx) => fn(tx, teamId))
    : db.transaction((tx) => fn(tx, null));
}
