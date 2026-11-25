import type { Context } from "hono";
import type { z } from "zod";
import { withTeam, type KaijuTx } from "@kaiju/db";
import { BRANCH_LABEL_ERROR_HTTP_STATUS } from "@kaiju/protocol";
import type { TeamVariables } from "../../authz/middleware.js";
import type { ServerDeps } from "../../deps.js";
import { param } from "../../http/request.js";
import { loadAdminResultGate, redactEntry } from "../../threads/admin-redaction.js";
import type { LabelError } from "../../threads/branches.js";
import {
  decodeActivityCursor,
  encodeActivityCursor,
  type ActivityCursor,
} from "../../threads/cursor.js";
import { viewerProjectIds } from "../../threads/references.js";
import {
  isLockTimeout,
  listEntries,
  type Page,
  type ThreadError,
  type ThreadResult,
  type Viewer,
} from "../../threads/repository.js";
import { uuidSchema, type ThreadSummary } from "../../threads/schemas.js";

export type ThreadContext = Context<{ Variables: TeamVariables }>;

const ERRORS = {
  thread_not_found: [404, "No thread with that id."],
  entry_not_found: [404, "That entry is not part of this thread."],
  entry_unavailable: [409, "That message's full content is not available."],
  not_a_tool_output: [409, "That entry is not a tool's output."],
  output_busy: [503, "The full output could not be loaded right now. Try again in a moment."],
  entry_offloaded: [
    409,
    "Some very large messages in this conversation could not be copied into a fork.",
  ],
  agent_not_found: [404, "No agent with that id is available in this team."],
  agent_unavailable: [
    409,
    "That agent can't start conversations: it is suspended, archived or not published yet.",
  ],
  version_not_found: [404, "That agent has no such published version."],
  model_not_enabled: [
    409,
    "That model isn't enabled for your team. Pick one of the team's models, or ask a team admin.",
  ],
  no_agent: [409, "This thread uses the default agent, which has no versions to switch."],
  agent_already_chosen: [409, "This thread already has an agent; it can only change version."],
  scheduled_thread: [409, "A scheduled conversation runs its schedule's agent."],
  project_not_found: [404, "No project with that id is available to you."],
  draft_not_found: [404, "No draft with that id is available to you."],
  test_chat_agent: [400, "A Workbench test chat runs the Kaiju agent: leave agent_id out."],
  read_only: [403, "This thread is shared with you read-only."],
  thread_busy: [
    409,
    "The thread is busy (a run is active or queued, or it is being written). Try again.",
  ],
  thread_in_trash: [409, "The thread is in Trash. Restore it first."],
  thread_archived: [409, "The thread is archived. Unarchive it first."],
  test_thread: [409, "A test conversation can't be pinned, archived, moved or put in a folder."],
  folder_not_found: [404, "No folder with that id in this team."],
  not_in_trash: [409, "The thread is not in Trash."],
  not_in_project: [409, "Only threads in a project can be shared to it."],
  nothing_to_fork: [409, "The thread has no messages to fork."],
  rate_limited: [429, "Too many forks. Wait a few minutes and try again."],
  invalid_cursor: [400, "The cursor is not valid. Start from the first page."],
  invalid_query: [400, "The search needs at least one term that is not excluded with -."],
  search_timeout: [503, "The search took too long. Try more specific terms."],
  connector_not_found: [422, "A connector to turn off isn't available to you in this team."],
  connector_not_working: [422, "A connector to turn off isn't working right now."],
} as const satisfies Record<string, readonly [number, string]>;

export type ErrorCode = keyof typeof ERRORS;

export function fail(c: Context, code: ErrorCode) {
  const [status, message] = ERRORS[code];
  return c.json({ code, message }, status);
}

/**
 * MT3 (KOBE-578): a new project conversation would open more projects than the workspace allows
 * (`tooManyMountsErrorSchema`: 409 with the limit).
 */
export function tooManyMounts(c: Context, limit: number) {
  return c.json(
    {
      code: "too_many_mounts",
      message: `You have ${limit} projects open, the most this workspace allows. Move or trash a conversation in another project first.`,
      limit,
    },
    409,
  );
}

/** A rate-limited route's 429 (`rate_limited`, as the folder and fork routes answer it). */
export function rateLimited(c: Context, message: string) {
  return c.json({ code: "rate_limited", message }, 429);
}

/** The label route's refusals (CT9): its own wording where the shared one says something else. */
const LABEL_MESSAGES = {
  entry_not_found: "That entry is not part of this thread.",
  label_limit: "This thread has the most labels it can have (200). Remove some first.",
  thread_in_trash: "The thread is in Trash. Restore it first.",
  test_thread: "A test conversation can't be labelled.",
} as const satisfies Record<keyof typeof BRANCH_LABEL_ERROR_HTTP_STATUS, string>;

export function failLabel(c: Context, code: LabelError) {
  if (code === "thread_not_found" || code === "read_only") return fail(c, code);
  return c.json({ code, message: LABEL_MESSAGES[code] }, BRANCH_LABEL_ERROR_HTTP_STATUS[code]);
}

export function parseQuery<T>(c: Context, schema: z.ZodType<T>): T | undefined {
  const parsed = schema.safeParse(c.req.query());
  return parsed.success ? parsed.data : undefined;
}

/**
 * One page of entries as `viewer` may see them: a reader of a shared thread gets Kaiju admin
 * results they lack the permission for replaced (KOBE-623, KA6); the owner sees everything.
 */
export async function readableEntries(
  tx: KaijuTx,
  viewer: Viewer,
  ownerUserId: string,
  threadId: string,
  query: { readonly after: number; readonly limit: number },
) {
  const page = await listEntries(tx, viewer, threadId, query.after, query.limit);
  const gate = await loadAdminResultGate(tx, viewer, ownerUserId);
  return gate === undefined
    ? page
    : { ...page, entries: page.entries.map((e) => redactEntry(e, gate)) };
}

/** The thread id path parameter, normalized to lowercase; undefined when it is not a uuid. */
export function threadIdParam(c: Context): string | undefined {
  const parsed = param(c, "id", uuidSchema);
  return parsed.success ? parsed.data : undefined;
}

/** The cursor, null for the first page, or undefined when it is malformed. */
export function cursorParam(raw: string | undefined): ActivityCursor | null | undefined {
  if (raw === undefined) return null;
  return decodeActivityCursor(raw) ?? undefined;
}

export function pageBody(page: Page<ThreadSummary>) {
  return {
    threads: page.items,
    next_cursor: page.next ? encodeActivityCursor(page.next) : null,
  };
}

/** What every thread route group shares: the database and the viewer-scoped transactions. */
export interface ThreadKit {
  readonly deps: ServerDeps;
  readonly db: ServerDeps["database"]["db"];
  /** Runs `fn` in the active team's transaction as the signed-in viewer. */
  readonly asViewer: <T>(
    c: ThreadContext,
    fn: (tx: KaijuTx, viewer: Viewer) => Promise<T>,
  ) => Promise<T>;
  /** Runs a change; a thread row held past the lock timeout answers 409 `thread_busy`. */
  readonly change: (
    c: ThreadContext,
    fn: (tx: KaijuTx, viewer: Viewer) => Promise<ThreadResult>,
  ) => Promise<Response>;
}

export function threadKit(deps: ServerDeps): ThreadKit {
  const db = deps.database.db;

  /** Runs `fn` in the active team's transaction as the signed-in viewer. */
  const asViewer = <T>(c: ThreadContext, fn: (tx: KaijuTx, viewer: Viewer) => Promise<T>) => {
    const teamId = c.get("team").id;
    const userId = c.get("user").id;
    return withTeam(db, teamId, async (tx) =>
      fn(tx, { teamId, userId, projectIds: await viewerProjectIds(tx, teamId, userId) }),
    );
  };

  /** Runs a change; a thread row held past the lock timeout answers 409 `thread_busy`. */
  const change = async (
    c: ThreadContext,
    fn: (tx: KaijuTx, viewer: Viewer) => Promise<ThreadResult>,
  ) => {
    try {
      const result = await asViewer(c, fn);
      return result.ok ? c.json(result.thread) : fail(c, result.error satisfies ThreadError);
    } catch (err) {
      if (isLockTimeout(err)) return fail(c, "thread_busy");
      throw err;
    }
  };

  return { deps, db, asViewer, change };
}
