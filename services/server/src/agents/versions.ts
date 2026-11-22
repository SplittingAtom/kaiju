/**
 * Published agent versions (spec D19, KOBE-46). Publish copies an agent's draft into an immutable
 * numbered version with a frozen tool manifest (`manifest.ts`) and moves `current_version` to it;
 * rollback republishes an older version's content as a new number (manifest recomputed against
 * today's floor). Versions only grow: `current_version` is always the newest. Every change locks
 * the agent row first, so concurrent publishes get consecutive numbers. The database refuses to
 * change or delete a version and threads pin versions with NO ACTION foreign keys; an agent with
 * versions is archived, never deleted.
 *
 * One import path for callers (KOBE-711 split it): records and reads in `versions/records.ts`,
 * publish and rollback in `versions/publish.ts`, the memory setting in `versions/memory.ts`,
 * delete and archive in `versions/archive.ts`, thread pins in `versions/pins.ts`.
 */

export {
  currentMemory,
  DEFAULT_VERSION_LIMITS,
  getVersion,
  listVersions,
  UnreadableVersionError,
  type AgentVersionRecord,
  type AgentVersionSummary,
  type Published,
  type PublishError,
  type VersionLimits,
} from "./versions/records.js";
export {
  contentKey,
  publishAgent,
  publishDraftIn,
  publishEvaluated,
  rollbackAgent,
  type PublishDraftInput,
} from "./versions/publish.js";
export { setAgentMemory } from "./versions/memory.js";
export {
  archiveAgent,
  deleteOrArchiveAgent,
  unarchiveAgent,
  type Removed,
} from "./versions/archive.js";
export {
  agentStatusOf,
  canPinAgent,
  findPinnableAgent,
  latestPinnedVersion,
  resolveAgentPin,
  resolveDraftAgent,
  resolveDraftPin,
  resolvePinnedAgent,
  resolveSwitchPin,
  type AgentPin,
  type DraftPin,
  type PinError,
  type PinnedAgent,
  type PinViewer,
} from "./versions/pins.js";
