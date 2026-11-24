/**
 * Thread–file links (spec thread-file-map, KOBE-612): which workspace files each thread read or
 * wrote, and which threads used a file. Three batched reads:
 *
 * - `GET /v1/threads/file-links?threads=<id,...>` (at most 50 ids): the visible thread rows' links;
 * - `GET /v1/threads/{id}/file-links`: one thread's links (`/files` is KOBE-488's);
 * - `GET /v1/workspace/file-threads?paths=<p,...>` (at most 100 paths): the threads per file.
 *
 * Paths are the workspace tree's (`GET /v1/workspace/files`; project files under
 * `projects/<slug>/…`). `hiddenCount` and `more` count what the viewer may not see by name (TFM7).
 *
 * Answers are checked against the `@kaiju/protocol` schemas (KOBE-611, strict) in wire casing: the
 * client camelizes every answer, so each one goes back to snake_case before the check (as
 * `lib/chat/folders-api.ts` does) and the checked value is handed out camelized again.
 */
import {
  FILE_THREADS_MAX_PATHS,
  THREAD_FILE_LINKS_MAX_THREADS,
  fileThreadsResponseSchema,
  threadFileLinksResponseSchema,
  threadFileLinksSchema,
  type FileThread as WireFileThread,
  type FileThreadsEntry as WireFileThreads,
  type ThreadFileAccessValue,
  type ThreadFileLink as WireLinkedFile,
  type ThreadFileLinks as WireThreadLinks,
} from "@kaiju/protocol";
import type { z } from "zod";
import "../security/zod-jitless";
import { apiRequest, type ApiError, type ApiResult } from "../api/client";

/** The most thread ids one `file-links` read takes. */
export const FILE_LINKS_MAX_THREADS = THREAD_FILE_LINKS_MAX_THREADS;
/** The most paths one `file-threads` read takes. */
export { FILE_THREADS_MAX_PATHS };

export type FileAccess = ThreadFileAccessValue;

/** One file a thread used. `deleted`: it is gone; listed as deleted, never in the rail. */
export interface LinkedFile {
  readonly path: string;
  readonly projectId: string | null;
  readonly access: FileAccess;
  readonly lastAt: string;
  readonly deleted: boolean;
}
/** A thread's links; `hiddenCount` files the viewer may not see by name (TFM7). */
export interface ThreadFileLinks {
  readonly threadId: string;
  readonly files: readonly LinkedFile[];
  readonly hiddenCount: number;
}
/** One thread that used a file (`title` null: untitled). */
export interface FileThread {
  readonly threadId: string;
  readonly title: string | null;
  readonly access: FileAccess;
  readonly lastAt: string;
}
/** A file's threads; `more` threads the viewer may not read, or beyond the server's cap. */
export interface FileThreads {
  readonly path: string;
  readonly threads: readonly FileThread[];
  readonly more: number;
}

export interface FileLinksApi {
  /** The links of up to {@link FILE_LINKS_MAX_THREADS} threads, in one read. */
  threadFileLinks(threadIds: readonly string[]): Promise<ApiResult<readonly ThreadFileLinks[]>>;
  /** One thread's links. */
  threadFileList(threadId: string): Promise<ApiResult<ThreadFileLinks>>;
  /** The threads of up to {@link FILE_THREADS_MAX_PATHS} paths, in one read. */
  fileThreads(paths: readonly string[]): Promise<ApiResult<readonly FileThreads[]>>;
}

const MALFORMED: ApiError = {
  status: 0,
  code: "malformed_response",
  message: "The thread's files could not be read. Try again.",
};

const TOO_MANY: ApiError = {
  status: 400,
  code: "invalid_request",
  message: "Too many at once.",
};

type Row = Readonly<Record<string, unknown>>;
const isRow = (v: unknown): v is Row => v !== null && typeof v === "object" && !Array.isArray(v);
/** Maps each element of an array field; anything else is left for the schema to refuse. */
const each = (v: unknown, f: (row: unknown) => unknown) => (Array.isArray(v) ? v.map(f) : v);

/* The camelized answers back in wire casing (only the contract's fields; strict schemas refuse
   the rest, so an unknown field is caught by the schema below, not dropped here). */
function wireLinkedFile(v: unknown): unknown {
  if (!isRow(v)) return v;
  const { projectId, lastAt, ...rest } = v;
  return { ...rest, project_id: projectId, last_at: lastAt };
}
function wireThreadLinks(v: unknown): unknown {
  if (!isRow(v)) return v;
  const { threadId, hiddenCount, files, ...rest } = v;
  return {
    ...rest,
    thread_id: threadId,
    files: each(files, wireLinkedFile),
    hidden_count: hiddenCount,
  };
}
function wireFileThread(v: unknown): unknown {
  if (!isRow(v)) return v;
  const { threadId, lastAt, ...rest } = v;
  return { ...rest, thread_id: threadId, last_at: lastAt };
}
function wireFileThreads(v: unknown): unknown {
  if (!isRow(v)) return v;
  const { threads, ...rest } = v;
  return { ...rest, threads: each(threads, wireFileThread) };
}

const linkedFileView = (f: WireLinkedFile): LinkedFile => ({
  path: f.path,
  projectId: f.project_id,
  access: f.access,
  lastAt: f.last_at,
  deleted: f.deleted,
});
const threadLinksView = (t: WireThreadLinks): ThreadFileLinks => ({
  threadId: t.thread_id,
  files: t.files.map(linkedFileView),
  hiddenCount: t.hidden_count,
});
const fileThreadView = (t: WireFileThread): FileThread => ({
  threadId: t.thread_id,
  title: t.title,
  access: t.access,
  lastAt: t.last_at,
});
const fileThreadsView = (f: WireFileThreads): FileThreads => ({
  path: f.path,
  threads: f.threads.map(fileThreadView),
  more: f.more,
});

function parsed<W, T>(
  res: ApiResult<unknown>,
  toWire: (v: unknown) => unknown,
  schema: z.ZodType<W>,
  view: (w: W) => T,
): ApiResult<T> {
  if (!res.ok) return res;
  const out = schema.safeParse(toWire(res.data));
  return out.success
    ? { ok: true, status: res.status, data: view(out.data) }
    : { ok: false, error: MALFORMED };
}

const list = (values: readonly string[]) => values.map(encodeURIComponent).join(",");

export function createFileLinksApi(teamId: string, fetchFn?: typeof fetch): FileLinksApi {
  const get = (path: string) => apiRequest<unknown>(path, { teamId, fetchFn });
  return {
    async threadFileLinks(threadIds) {
      if (threadIds.length === 0) return { ok: true, status: 200, data: [] };
      if (threadIds.length > FILE_LINKS_MAX_THREADS) return { ok: false, error: TOO_MANY };
      return parsed(
        await get(`/v1/threads/file-links?threads=${list(threadIds)}`),
        (v) => (isRow(v) ? { ...v, links: each(v.links, wireThreadLinks) } : v),
        threadFileLinksResponseSchema,
        (w) => w.links.map(threadLinksView),
      );
    },
    async threadFileList(threadId) {
      return parsed(
        await get(`/v1/threads/${encodeURIComponent(threadId)}/file-links`),
        wireThreadLinks,
        threadFileLinksSchema,
        threadLinksView,
      );
    },
    async fileThreads(paths) {
      if (paths.length === 0) return { ok: true, status: 200, data: [] };
      if (paths.length > FILE_THREADS_MAX_PATHS) return { ok: false, error: TOO_MANY };
      return parsed(
        await get(`/v1/workspace/file-threads?paths=${list(paths)}`),
        (v) => (isRow(v) ? { ...v, files: each(v.files, wireFileThreads) } : v),
        fileThreadsResponseSchema,
        (w) => w.files.map(fileThreadsView),
      );
    },
  };
}

/** Splits `values` into batches of at most `size`. */
export function batches<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}
