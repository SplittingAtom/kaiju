import {
  and,
  approvals,
  asc,
  desc,
  eq,
  inArray,
  runs,
  sql,
  threadEntries,
  threads,
  type KaijuTx,
  type RunStatus,
} from "@kaiju/db";
import type { ActivityCursor } from "./cursor.js";
import { TRASH_RETENTION_DAYS, type ThreadEntry, type ThreadSummary } from "./schemas.js";
import type { AgentPin, PinError } from "../agents/versions.js";
import { visibilityOf } from "./share.js";
import type { ThinkingLevel, ThreadFolderFilter } from "@kaiju/protocol";
import { trimLargeOutput } from "./entry-output.js";
import { canViewProject, maskedProject, sharerNames, viewableProjects } from "./projects-view.js";

/**
 * Thread data access (spec D9, D15, D18, D23, §6.1). Every function runs inside the caller's
 * `withTeam` transaction, so RLS confines it to the active team; the visibility rules below add
 * the per-user layer: a viewer reads their own threads (including their Trash), threads shared
 * to a project they belong to and threads shared with the team (CE20, KOBE-221), read-only and
 * never from Trash. Nobody else reads a thread — not a team admin (D18), not a site admin (D8;
 * break-glass is its own audited path, KOBE-16). Only the owner changes a thread.
 */

type SQL = ReturnType<typeof sql>;

export interface Viewer {
  /** The active team (also enforced by RLS; repeated here so every query leads its index). */
  readonly teamId: string;
  readonly userId: string;
  /** Projects of the active team the viewer is a member of (KOBE-57; empty until then). */
  readonly projectIds: readonly string[];
}

export type ThreadAccess = "owner" | "reader";

export type ThreadError =
  | "thread_not_found"
  | "read_only"
  | "thread_busy"
  | "thread_in_trash"
  | "not_in_trash"
  | "not_in_project"
  | "entry_not_found"
  | "entry_offloaded"
  | "nothing_to_fork"
  | "project_not_found"
  | "no_agent"
  | "agent_already_chosen"
  | "scheduled_thread"
  | "model_not_enabled"
  | "thread_archived"
  | "test_thread"
  | "folder_not_found"
  | PinError;

export type ThreadResult = { ok: true; thread: ThreadSummary } | { ok: false; error: ThreadError };

export const TRASH_INTERVAL = sql.raw(`interval '${TRASH_RETENTION_DAYS} days'`);

/**
 * How long a change waits for the thread row. Appenders (the KOBE-29 seq trigger) and the run
 * orchestrator hold it; past this the change fails with 55P03, answered as 409 `thread_busy`.
 */
export const THREAD_LOCK_TIMEOUT = "2s";

/** Postgres lock_not_available (`lock_timeout` expired); the shared reader in `@kaiju/db`. */
export { isLockTimeout } from "@kaiju/db";
const DAY_MS = 86_400_000;

type TimeColumn =
  | typeof threads.lastActivityAt
  | typeof threads.deletedAt
  | typeof threads.pinnedAt
  | typeof threads.archivedAt;

const micros = (column: TimeColumn) =>
  sql<string>`(extract(epoch from ${column}) * 1000000)::bigint::text`;

export const summaryColumns = {
  id: threads.id,
  title: threads.title,
  status: threads.status,
  ownerUserId: threads.ownerUserId,
  projectId: threads.projectId,
  agentScope: threads.agentScope,
  agentId: threads.agentId,
  agentVersion: threads.agentVersion,
  sharedToProject: threads.sharedToProject,
  sharedToTeam: threads.sharedToTeam,
  modelAlias: threads.modelAlias,
  thinkingLevel: threads.thinkingLevel,
  leafEntryId: threads.leafEntryId,
  lastActivityAt: threads.lastActivityAt,
  createdAt: threads.createdAt,
  deletedAt: threads.deletedAt,
  isTest: threads.isTest,
  skillTest: threads.skillTest,
  skillDraftId: threads.skillDraftId,
  scheduleId: threads.scheduleId,
  forkedFromThreadId: threads.forkedFromThreadId,
  forkedAtEntryId: threads.forkedAtEntryId,
  pinnedAt: threads.pinnedAt,
  archivedAt: threads.archivedAt,
  folderId: threads.folderId,
  skillEval: threads.skillEval,
};

export type SummaryRow = {
  id: string;
  title: string | null;
  status: ThreadSummary["status"];
  ownerUserId: string;
  projectId: string | null;
  agentScope: AgentPin["agentScope"] | null;
  agentId: string | null;
  agentVersion: number | null;
  sharedToProject: boolean;
  sharedToTeam: boolean;
  modelAlias: string | null;
  /** KOBE-260; absent in rows read without it. */
  thinkingLevel?: ThinkingLevel | null;
  leafEntryId: string | null;
  lastActivityAt: Date;
  createdAt: Date;
  deletedAt: Date | null;
  isTest: boolean;
  /** KOBE-323; absent in rows read without it. */
  skillTest?: boolean;
  skillDraftId?: string | null;
  scheduleId?: string | null;
  forkedFromThreadId?: string | null;
  forkedAtEntryId?: string | null;
  pinnedAt?: Date | null;
  archivedAt?: Date | null;
  /** KOBE-534; absent in rows read without it. */
  folderId?: string | null;
  skillEval?: boolean;
};

/**
 * The summary without the viewer: a fork shows its fork point but never names its source, which
 * only {@link summarize} resolves for a viewer who may open it (KOBE-216, review-280 L2).
 */
export function toSummary(row: SummaryRow): ThreadSummary {
  return {
    thread_id: row.id,
    title: row.title,
    status: row.status,
    owner_user_id: row.ownerUserId,
    project_id: row.projectId,
    agent_id: row.agentId,
    agent_version: row.agentVersion,
    shared_to_project: row.sharedToProject,
    visibility: visibilityOf(row),
    model: row.modelAlias,
    thinking_level: row.thinkingLevel ?? null,
    leaf_entry_id: row.leafEntryId,
    last_activity_at: row.lastActivityAt.toISOString(),
    created_at: row.createdAt.toISOString(),
    is_test: row.isTest,
    ...(row.skillTest
      ? { skill_test: true as const, skill_draft_id: row.skillDraftId ?? null }
      : {}),
    schedule_id: row.scheduleId ?? null,
    forked_from_thread_id: null,
    forked_from_title: null,
    forked_at_entry_id: row.forkedAtEntryId ?? null,
    pinned_at: row.pinnedAt?.toISOString() ?? null,
    archived_at: row.archivedAt?.toISOString() ?? null,
    folder_id: row.folderId ?? null,
    deleted_at: row.deletedAt?.toISOString() ?? null,
    purge_after: row.deletedAt
      ? new Date(row.deletedAt.getTime() + TRASH_RETENTION_DAYS * DAY_MS).toISOString()
      : null,
  };
}

/**
 * Rows the viewer may read: own (Trash included while restorable; older Trash is awaiting purge
 * and treated as gone), or shared with the team or to one of their projects (never from Trash).
 */
export function readableBy(viewer: Viewer): SQL {
  const own = sql`${eq(threads.ownerUserId, viewer.userId)} AND (${threads.deletedAt} IS NULL OR ${threads.deletedAt} > now() - ${TRASH_INTERVAL})`;
  return sql`${eq(threads.teamId, viewer.teamId)} AND (${own} OR (${sharedWith(viewer)} AND ${threads.deletedAt} IS NULL))`;
}

/**
 * A folder's threads as the viewer sees them (KOBE-534, TF4/TF5): unarchived and readable (own, or
 * shared with them); the caller adds live and not a test. The viewer's own pinned threads are in
 * the folder's Pinned list (`/pinned?folder=`), so the list leaves them out; the counts keep them.
 */
function inFolderFor(viewer: Viewer, options: { withOwnPinned?: boolean } = {}): SQL {
  const pinned = options.withOwnPinned
    ? sql`true`
    : sql`(${threads.pinnedAt} IS NULL OR ${threads.ownerUserId} <> ${viewer.userId})`;
  return sql`${threads.archivedAt} IS NULL AND ${pinned} AND ${readableBy(viewer)}`;
}

/** Live, listable threads: not in Trash, not a builder test or eval thread. */
const LISTABLE = sql`${threads.deletedAt} IS NULL AND NOT ${threads.isTest} AND NOT ${threads.skillEval}`;

/**
 * Per folder, how many of its live, unarchived threads the viewer may read (KOBE-534, TF4): one
 * grouped query under the same predicate as `GET /v1/threads?folder=` (pinned ones included, as
 * the folder's Pinned list shows them), on `threads_folder_idx`. Folders with none are absent.
 */
export async function folderThreadCounts(
  tx: KaijuTx,
  viewer: Viewer,
): Promise<ReadonlyMap<string, number>> {
  const rows = await tx
    .select({ folderId: threads.folderId, n: sql<number>`count(*)::int` })
    .from(threads)
    .where(
      and(
        eq(threads.teamId, viewer.teamId),
        sql`${threads.folderId} IS NOT NULL`,
        LISTABLE,
        inFolderFor(viewer, { withOwnPinned: true }),
      ),
    )
    .groupBy(threads.folderId);
  return new Map(rows.flatMap((r) => (r.folderId ? [[r.folderId, r.n] as const] : [])));
}

/** The thread's owner is still a member of its team and not deactivated (see {@link sharedWith}). */
function ownerIsActiveMember(): SQL {
  return sql`EXISTS (SELECT 1 FROM team_members m JOIN users u ON u.id = m.user_id
    WHERE m.team_id = ${threads.teamId} AND m.user_id = ${threads.ownerUserId}
      AND u.deactivated_at IS NULL)`;
}

/**
 * Shared to the viewer by its scope: with the team, or to one of their projects (D23, CE20), and
 * only while its owner is a current, active member of the team (KOBE-221, fail closed): a share
 * never outlives the one person who could revoke it, whatever happened to `endSharesOf`. One
 * primary-key lookup each in `team_members` and `users`.
 */
function sharedWith(viewer: Viewer): SQL {
  const scope =
    viewer.projectIds.length === 0
      ? sql`${threads.sharedToTeam}`
      : sql`(${threads.sharedToTeam} OR ${and(
          eq(threads.sharedToProject, true),
          inArray(threads.projectId, [...viewer.projectIds]),
        )})`;
  return sql`${scope} AND ${ownerIsActiveMember()}`;
}

/**
 * The summaries as `viewer` sees them (CE16, KOBE-216): a fork names its source (id and title) only
 * while the viewer may open it, resolved by {@link findThreads} like `findThread`. Otherwise (the
 * share was revoked, the source moved or was purged) only `forked_at_entry_id` shows, which names
 * an entry of the fork itself. One hop: provenance is never walked further.
 */
export async function summarize(
  tx: KaijuTx,
  viewer: Viewer,
  rows: readonly SummaryRow[],
): Promise<ThreadSummary[]> {
  const ids = new Set(rows.flatMap((r) => (r.forkedFromThreadId ? [r.forkedFromThreadId] : [])));
  const sources =
    ids.size === 0 ? new Map<string, SummaryRow>() : await findThreads(tx, viewer, [...ids]);
  const owners = await sharerNames(tx, viewer, rows);
  const viewable = await viewableProjects(tx, viewer, rows);
  const waiting = await awaitingViewer(tx, viewer, rows);
  return rows.map((row) => {
    const source = row.forkedFromThreadId ? sources.get(row.forkedFromThreadId) : undefined;
    // Pin and archive are the owner's own organization (CE19): a reader never sees them.
    const own = row.ownerUserId === viewer.userId;
    const summary = {
      ...ownOrganization(toSummary(row), viewer),
      read_only: !own,
      owner_name: own ? null : (owners.get(row.ownerUserId) ?? null),
      ...maskedProject(row, viewer, viewable),
      ...(waiting.has(row.id) ? { pending_approval: true as const } : {}),
    };
    return source
      ? { ...summary, forked_from_thread_id: source.id, forked_from_title: source.title }
      : summary;
  });
}

/**
 * Which of `rows` hold an approval waiting for the viewer (KOBE-301: the rail's amber dot): pending
 * and not yet expired, on a run the viewer started, since only the run's user may decide it
 * (KOBE-37). One query on the partial `approvals_pending_idx`, team-scoped like every read here.
 */
export async function awaitingViewer(
  tx: KaijuTx,
  viewer: Viewer,
  rows: readonly { readonly id: string }[],
): Promise<ReadonlySet<string>> {
  if (rows.length === 0) return new Set();
  const found = await tx
    .selectDistinct({ threadId: approvals.threadId })
    .from(approvals)
    .where(
      and(
        eq(approvals.teamId, viewer.teamId),
        eq(approvals.userId, viewer.userId),
        eq(approvals.status, "pending"),
        sql`${approvals.expiresAt} > now()`,
        inArray(
          approvals.threadId,
          rows.map((r) => r.id),
        ),
      ),
    );
  return new Set(found.map((r) => r.threadId));
}

/** The summary with `pinned_at` / `archived_at` only for its owner (CE19, KOBE-220). */
export function ownOrganization<T extends ThreadSummary>(summary: T, viewer: Viewer): T {
  return summary.owner_user_id === viewer.userId
    ? summary
    : { ...summary, pinned_at: null, archived_at: null };
}

/** {@link summarize} for one row. */
export async function summarizeOne(
  tx: KaijuTx,
  viewer: Viewer,
  row: SummaryRow,
): Promise<ThreadSummary> {
  const [summary] = await summarize(tx, viewer, [row]);
  if (!summary) throw new Error("summarize returned no summary");
  return summary;
}

/** Keyset predicate for (column DESC, id DESC) after `cursor`. */
function after(column: TimeColumn, c: ActivityCursor): SQL {
  return sql`(${column}, ${threads.id}) < (timestamptz 'epoch' + ${c.micros}::bigint * interval '1 microsecond', ${c.id}::uuid)`;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly next: ActivityCursor | null;
}

async function toPage(
  tx: KaijuTx,
  viewer: Viewer,
  rows: readonly (SummaryRow & { position: string })[],
  limit: number,
): Promise<Page<ThreadSummary>> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items: await summarize(tx, viewer, items),
    next: rows.length > limit && last ? { micros: last.position, id: last.id } : null,
  };
}

/**
 * The thread list (§6.1 `GET /v1/threads`), most recent activity first. Without a project: the
 * viewer's own live threads in the rail's normal groups, so neither pinned nor archived (CE19:
 * those are {@link listOwnOrganized}). With a project: its live threads the viewer may read (own,
 * or shared if the viewer is a project member), pinned and archived ones included. Never Trash.
 */
export async function listThreads(
  tx: KaijuTx,
  viewer: Viewer,
  options: {
    projectId?: string | undefined;
    folder?: ThreadFolderFilter | undefined;
    cursor: ActivityCursor | null;
    limit: number;
  },
): Promise<Page<ThreadSummary>> {
  // Others' threads of a project only for those who may open it: a team share is no way to list
  // the threads of a project one can't see (CE20).
  const projectOpen =
    options.projectId !== undefined && (await canViewProject(tx, viewer, options.projectId));
  const own = and(
    eq(threads.teamId, viewer.teamId),
    eq(threads.ownerUserId, viewer.userId),
    sql`${threads.pinnedAt} IS NULL AND ${threads.archivedAt} IS NULL`,
  );
  const scope = options.projectId
    ? and(
        eq(threads.projectId, options.projectId),
        projectOpen ? readableBy(viewer) : eq(threads.ownerUserId, viewer.userId),
      )
    : options.folder === undefined
      ? own
      : options.folder === "none"
        ? and(own, sql`${threads.folderId} IS NULL`)
        : and(eq(threads.folderId, options.folder), inFolderFor(viewer));
  const rows = await tx
    .select({ ...summaryColumns, position: micros(threads.lastActivityAt) })
    .from(threads)
    .where(
      and(
        // Explicit, not only in `scope` and RLS: see the KOBE-16 note in packages/db/README.md.
        eq(threads.teamId, viewer.teamId),
        scope,
        sql`${threads.deletedAt} IS NULL AND NOT ${threads.isTest} AND NOT ${threads.skillEval}`,
        options.cursor ? after(threads.lastActivityAt, options.cursor) : undefined,
      ),
    )
    .orderBy(desc(threads.lastActivityAt), desc(threads.id))
    .limit(options.limit + 1);
  return toPage(tx, viewer, rows, options.limit);
}

/**
 * The viewer's own pinned or archived live threads (CE19, KOBE-220), newest pin or archive first:
 * the rail's Pinned and Archived groups (indexes `threads_owner_pinned_idx`,
 * `threads_owner_archived_idx`). A thread is in at most one: archiving unpins it.
 */
export async function listOwnOrganized(
  tx: KaijuTx,
  viewer: Viewer,
  options: {
    which: "pinned" | "archived";
    /** Pinned only (KOBE-534, TF5): the pinned threads of one folder, or the unfiled ones. */
    folder?: ThreadFolderFilter | undefined;
    cursor: ActivityCursor | null;
    limit: number;
  },
): Promise<Page<ThreadSummary>> {
  const column = options.which === "pinned" ? threads.pinnedAt : threads.archivedAt;
  const folder =
    options.folder === undefined
      ? undefined
      : options.folder === "none"
        ? sql`${threads.folderId} IS NULL`
        : eq(threads.folderId, options.folder);
  const rows = await tx
    .select({ ...summaryColumns, position: micros(column) })
    .from(threads)
    .where(
      and(
        eq(threads.teamId, viewer.teamId),
        eq(threads.ownerUserId, viewer.userId),
        sql`${column} IS NOT NULL AND ${threads.deletedAt} IS NULL AND NOT ${threads.isTest}
            AND NOT ${threads.skillEval}`,
        options.which === "pinned" ? sql`${threads.archivedAt} IS NULL` : undefined,
        options.which === "pinned" ? folder : undefined,
        options.cursor ? after(column, options.cursor) : undefined,
      ),
    )
    // NULLS LAST as the indexes are built, so the scan is already in order (no sort).
    .orderBy(sql`${column} DESC NULLS LAST`, sql`${threads.id} DESC NULLS LAST`)
    .limit(options.limit + 1);
  return toPage(tx, viewer, rows, options.limit);
}

/**
 * Shared with me (CE20, KOBE-221): other members' live threads shared with the viewer, with the
 * team or to one of their projects, most recent activity first (indexes `threads_team_shared_idx`
 * and `threads_project_activity_idx`). Read-only for the viewer; never test threads or Trash.
 */
export async function listSharedWithMe(
  tx: KaijuTx,
  viewer: Viewer,
  options: { cursor: ActivityCursor | null; limit: number },
): Promise<Page<ThreadSummary>> {
  const rows = await tx
    .select({ ...summaryColumns, position: micros(threads.lastActivityAt) })
    .from(threads)
    .where(
      and(
        eq(threads.teamId, viewer.teamId),
        sql`${threads.ownerUserId} <> ${viewer.userId}`,
        sharedWith(viewer),
        sql`${threads.deletedAt} IS NULL AND NOT ${threads.isTest} AND NOT ${threads.skillEval}`,
        options.cursor ? after(threads.lastActivityAt, options.cursor) : undefined,
      ),
    )
    .orderBy(desc(threads.lastActivityAt), desc(threads.id))
    .limit(options.limit + 1);
  return toPage(tx, viewer, rows, options.limit);
}

/** The viewer's Trash, most recently deleted first; only threads still restorable. */
export async function listTrash(
  tx: KaijuTx,
  viewer: Viewer,
  options: { cursor: ActivityCursor | null; limit: number },
): Promise<Page<ThreadSummary>> {
  const rows = await tx
    .select({ ...summaryColumns, position: micros(threads.deletedAt) })
    .from(threads)
    .where(
      and(
        eq(threads.teamId, viewer.teamId),
        eq(threads.ownerUserId, viewer.userId),
        sql`${threads.deletedAt} > now() - ${TRASH_INTERVAL} AND NOT ${threads.isTest}
            AND NOT ${threads.skillEval}`,
        options.cursor ? after(threads.deletedAt, options.cursor) : undefined,
      ),
    )
    .orderBy(desc(threads.deletedAt), desc(threads.id))
    .limit(options.limit + 1);
  return toPage(tx, viewer, rows, options.limit);
}

/**
 * The thread with the viewer's access to it, or null when they may not read it (unknown id,
 * another team's thread, another user's private thread: all indistinguishable). `lock` takes the
 * row lock that every change holds; lock order is thread before run (KOBE-29). It is
 * `FOR NO KEY UPDATE`, as `lockThreadRow` (KOBE-266: `FOR UPDATE` deadlocked with foreign-key checks).
 */
export async function findThread(
  tx: KaijuTx,
  viewer: Viewer,
  id: string,
  options: { lock?: boolean } = {},
): Promise<{ thread: SummaryRow; access: ThreadAccess } | null> {
  const query = tx
    .select(summaryColumns)
    .from(threads)
    .where(and(eq(threads.id, id), readableBy(viewer)));
  // Only the threads row is locked; nothing else is joined.
  const [row] = await (options.lock ? query.for("no key update") : query);
  if (!row) return null;
  return { thread: row, access: row.ownerUserId === viewer.userId ? "owner" : "reader" };
}

/**
 * The threads among `ids` the viewer may read, by id: {@link findThread} for many ids at once
 * (the same predicate, no lock). Ids the viewer may not read are simply absent.
 */
export async function findThreads(
  tx: KaijuTx,
  viewer: Viewer,
  ids: readonly string[],
): Promise<Map<string, SummaryRow>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select(summaryColumns)
    .from(threads)
    .where(and(inArray(threads.id, [...ids]), readableBy(viewer)));
  return new Map(rows.map((r) => [r.id, r]));
}

export async function hasRunIn(
  tx: KaijuTx,
  viewer: Viewer,
  threadId: string,
  statuses: readonly RunStatus[],
): Promise<boolean> {
  const [row] = await tx
    .select({ one: sql<number>`1` })
    .from(runs)
    .where(
      and(
        eq(runs.teamId, viewer.teamId),
        eq(runs.threadId, threadId),
        inArray(runs.status, [...statuses]),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** One page of the thread's entries in append order (`seq`), after `afterSeq`. */
export async function listEntries(
  tx: KaijuTx,
  viewer: Viewer,
  threadId: string,
  afterSeq: number,
  limit: number,
): Promise<{ entries: ThreadEntry[]; nextAfter: number | null }> {
  const rows = await tx
    .select({
      entryId: threadEntries.entryId,
      parentId: threadEntries.parentId,
      seq: threadEntries.seq,
      type: threadEntries.type,
      payload: threadEntries.payload,
      blobRef: threadEntries.blobRef,
      createdAt: threadEntries.createdAt,
    })
    .from(threadEntries)
    .where(
      and(
        eq(threadEntries.teamId, viewer.teamId),
        eq(threadEntries.threadId, threadId),
        sql`${threadEntries.seq} > ${afterSeq}`,
      ),
    )
    .orderBy(asc(threadEntries.seq))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return {
    entries: page.map((r) => {
      // An offloaded body lives in object storage; never echo whatever was left inline. A tool
      // output over 64 KB is cut to a preview (KOBE-208: read in full when its card opens).
      const trimmed = r.blobRef !== null ? undefined : trimLargeOutput(r.payload);
      return {
        entry_id: r.entryId,
        parent_id: r.parentId,
        seq: r.seq,
        type: r.type,
        payload: (trimmed?.payload ?? {}) as Record<string, unknown>,
        payload_offloaded: r.blobRef !== null,
        ...(trimmed?.truncated ? { payload_truncated: true } : {}),
        created_at: r.createdAt.toISOString(),
      };
    }),
    nextAfter: rows.length > limit ? (page.at(-1)?.seq ?? null) : null,
  };
}
