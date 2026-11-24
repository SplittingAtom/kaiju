import type { KaijuDb } from "@kaiju/db";
import type { SemanticMemoryScope } from "@kaiju/protocol";
import { logger } from "../../logger.js";
import type { SaveWho } from "./service.js";

/**
 * Embed on save, wired once per database (KOBE-779, review pass 2 P2-5). The item store lists
 * every item it writes a version of (`Op.saved`) and, after the commit, hands them here
 * (`afterCommit` in items/context.ts), whichever write path ran: the item routes, To review,
 * proposals, Undo, import. The server registers its `MemoryEmbeddings` for its database at
 * start (`deps.ts`); without one (a test, a tool) nothing is embedded and Build vectors catches up.
 *
 * Keyed by the database handle, not a module global, so two servers in one process (the
 * multi-replica tests) each embed with their own service.
 */
export type SaveEmbedder = (
  who: SaveWho,
  scope: SemanticMemoryScope,
  itemIds: readonly string[],
) => void;

const embedders = new WeakMap<KaijuDb, SaveEmbedder>();

export function registerSaveEmbedder(db: KaijuDb, embed: SaveEmbedder): void {
  embedders.set(db, embed);
}

/** Requests vectors for saved items (in the background; never throws, never blocks the save). */
export function embedSaved(
  db: KaijuDb,
  who: SaveWho,
  scope: SemanticMemoryScope,
  itemIds: readonly string[],
): void {
  if (itemIds.length === 0) return;
  try {
    embedders.get(db)?.(who, scope, [...new Set(itemIds)]);
  } catch (err) {
    // The save is committed: a failure to even queue the embedding leaves it to Build vectors.
    logger.warn({ err, scope }, "memory embed on save could not be queued");
  }
}
