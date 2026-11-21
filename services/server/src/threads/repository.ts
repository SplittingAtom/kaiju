/**
 * Thread data access (spec D9, D15, D18, D23, §6.1), kept as one import path for its callers
 * (KOBE-711 split it): reads and visibility in `queries.ts`, changes in `mutations.ts`, how others'
 * projects show in `projects-view.ts`. Every function runs inside the caller's `withTeam`
 * transaction.
 */

export {
  findThread,
  findThreads,
  folderThreadCounts,
  hasRunIn,
  isLockTimeout,
  listEntries,
  listOwnOrganized,
  listSharedWithMe,
  listThreads,
  listTrash,
  awaitingViewer,
  ownOrganization,
  readableBy,
  summarize,
  summarizeOne,
  summaryColumns,
  THREAD_LOCK_TIMEOUT,
  toSummary,
  type Page,
  type SummaryRow,
  type ThreadAccess,
  type ThreadError,
  type ThreadResult,
  type Viewer,
} from "./queries.js";
export {
  clearTestThreads,
  createThread,
  lockForChange,
  lockForFiling,
  PENDING_RUN_STATUSES,
  restoreThread,
  setLeaf,
  switchAgentVersion,
  trashThread,
  updateThread,
} from "./mutations.js";
export { canViewProject, maskedProject, sharerNames, viewableProjects } from "./projects-view.js";
