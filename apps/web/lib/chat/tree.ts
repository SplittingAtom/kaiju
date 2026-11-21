/**
 * Projects the Pi entry tree (`thread_entries`, D15) and the active run's live stream into the
 * branchable message list assistant-ui renders (D16: `ThreadMessage[]` with `parentId` + `headId`).
 *
 * A Pi turn is several entries (user message → assistant step → tool results → assistant step …);
 * assistant-ui shows one assistant message per turn. So:
 * - a `user` message entry is a user message (its id is the entry id);
 * - a chain of assistant-side entries (assistant steps, tool results, offloaded bodies) is one
 *   assistant message, id = its first entry; the chain ends where the tree branches;
 * - other entry types (`model_change`, `compaction`, …) belong to the message around them; those
 *   with a marker (KOBE-209) show it in that message where they sit: inside a turn as a part,
 *   after its last entry as `after`, or, below a fork or the root, as `before` on the first
 *   message under them (so a marker shows on its own branch only).
 * - a scheduled run's skipped-actions summary (KOBE-178, written by the server under the run's
 *   last entry) is not part of the tree at all: it becomes a card after the nearest shown message
 *   above it (at the end of an answer, or under a prompt the run never answered), so it is never
 *   a branch, a head or an entry to continue from.
 * Branches (edit-and-regenerate, Retry) are siblings in the tree, so assistant-ui's branch picker
 * works on them as is. The client keeps both directions of the mapping: `nodeOfEntry` (the leaf's
 * message is the head) and `lastEntryOfNode` (the entry to continue from when a branch is chosen).
 * The projection lives in `projection/` (KOBE-716); this module is its public face.
 */
export {
  EMPTY_VERSION_NOTE,
  messageMeta,
  type ChipFile,
  type KobeMessageMeta,
  type LiveOverlay,
  type ProjectedItem,
  type Projection,
  type SkippedReport,
} from "./projection/types";
export { hiddenEntries } from "./projection/build-nodes";
export { descendantsOf, newestBelow, projectThread } from "./projection/project";
export {
  branchPoint,
  branchPointOfMeta,
  withoutSkillLine,
  type BranchPoint,
} from "./projection/branch-point";
