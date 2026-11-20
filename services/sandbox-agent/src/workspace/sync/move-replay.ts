import type { AppliedMove } from "../moves.js";
import { warn, type SyncState } from "./state.js";

/** Journalled moves since `since` applied locally; a failure leaves them to the pull alone. */
export async function replayMoves(s: SyncState, since: number): Promise<AppliedMove[]> {
  try {
    return await s.moves.replay(since);
  } catch (error) {
    warn(s, "workspace moves could not be replayed; the pull applies them", error);
    return [];
  }
}

/**
 * Known states follow a local rename made now: the moved files keep their content base, marked
 * `moved` so the new path's rows are always evaluated against them (review R2).
 */
export function rekey(s: SyncState, moves: readonly AppliedMove[]): void {
  for (const { from, to } of moves) {
    for (const [path, k] of [...s.known]) {
      if (path !== from && !path.startsWith(`${from}/`)) continue;
      s.known.delete(path);
      s.known.set(`${to}${path.slice(from.length)}`, { ...k, moved: true });
    }
  }
}
