import type { KobeTx } from "@kobe/db";
import type { RunSemanticMemoryItem } from "@kobe/protocol";
import {
  parseRunMemoryState,
  runMemoryStateQuery,
  type RunMemoryStateRow,
} from "../../switches.js";
import {
  queryWords,
  readPolicyItems,
  readRecallRows,
  TRIGRAM_MESSAGE_MAX_CHARS,
} from "../../items/run-memory.js";
import { relevanceScore, type SelectLane } from "../../items/select.js";
import { trigramSimilarity, trigrams } from "../../items/trigram.js";
import type { ExtractorExistingItem } from "../prompt/input.js";

/**
 * The existing items a learning pass lists (KOBE-392, SM15): **every** active Site Policy item
 * (while Policy applies), then the best {@link RELATED_MAX_ITEMS} of the scopes a candidate may
 * land in and the switches allow (the author's `user` and `portable` items, the Workspace's
 * `team` items), ranked by the selector's relevance (A7: `ts_rank_cd + 0.3 · trigram + 0.1 ·
 * recency`, as `recall`) against the conversation. Read in the caller's `withTeam()` transaction
 * as the author: never another person's items, never another Workspace's. Site items other than
 * Policy are not listed: a pass never proposes to the Site.
 */

export const RELATED_MAX_ITEMS = 40;
/** Scopes a candidate may update, supersede or contradict. */
export const RELATED_LANES: readonly SelectLane[] = ["user", "portable", "team"];

const asExisting = (i: RunSemanticMemoryItem): ExtractorExistingItem => ({
  id: i.id,
  scope: i.scope,
  kind: i.kind,
  policy: i.policy,
  statement: i.statement,
});

export interface RelatedQuery {
  /** Words for full-text matching (the conversation, the person's newest words first). */
  readonly text: string;
  /** Text for trigram similarity (the person's newest message). */
  readonly latest: string;
}

export async function readRelatedItems(
  tx: KobeTx,
  who: { readonly teamId: string; readonly userId: string },
  query: RelatedQuery,
): Promise<ExtractorExistingItem[]> {
  const { memory } = parseRunMemoryState(
    (await tx.execute<RunMemoryStateRow>(runMemoryStateQuery(who.teamId))).rows[0],
  );
  const policy = memory.policy ? await readPolicyItems(tx, who) : [];
  const lanes = RELATED_LANES.filter((lane) => memory.scopes[lane]);
  const rows =
    lanes.length === 0 ? [] : await readRecallRows(tx, who, queryWords(query.text), false, lanes);
  const grams = trigrams(query.latest.slice(0, TRIGRAM_MESSAGE_MAX_CHARS));
  const related = rows
    .map((r) => ({
      item: r.item,
      score: relevanceScore({
        item: r.item,
        matched: true,
        textRank: r.textRank,
        trigram: trigramSimilarity(r.item.statement, grams),
        ageDays: r.ageDays,
        sticky: false,
      }),
    }))
    .sort((a, b) => b.score - a.score || (a.item.id < b.item.id ? -1 : 1))
    .slice(0, RELATED_MAX_ITEMS)
    .map((r) => r.item);
  const byId = (a: RunSemanticMemoryItem, b: RunSemanticMemoryItem) => (a.id < b.id ? -1 : 1);
  return [...policy.sort(byId), ...related].map(asExisting);
}
