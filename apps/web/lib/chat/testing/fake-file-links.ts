/**
 * Thread–file links for `FakeKobe` (KOBE-612, spec thread-file-map): `GET /v1/threads/file-links`,
 * `GET /v1/threads/{id}/file-links` and `GET /v1/workspace/file-threads` from one set of links a
 * test adds with `link`. Wire casing.
 * Reads are recorded (`linkReads`, `fileReads`) so tests can assert batching.
 */

export interface FakeFileLink {
  readonly path: string;
  readonly access: "read" | "write";
  readonly projectId?: string | null;
  readonly deleted?: boolean;
  readonly lastAt?: string;
}

const LAST_AT = "2026-11-10T10:00:00.000Z";

function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const split = (value: string | null) =>
  value === null || value === "" ? [] : value.split(",").map(decodeURIComponent);

export class FakeFileLinks {
  /** Thread id -> its links. */
  readonly links = new Map<string, FakeFileLink[]>();
  /** Thread id -> files the viewer may not see by name (TFM7). */
  readonly hidden = new Map<string, number>();
  /** Path -> threads the viewer may not read (`more`). */
  readonly more = new Map<string, number>();
  /** The `threads=` of every file-links read, in order. */
  readonly linkReads: string[][] = [];
  /** The `paths=` of every file-threads read, in order. */
  readonly fileReads: string[][] = [];

  constructor(private readonly titleOf: (threadId: string) => string | null | undefined) {}

  /** The thread used these files. */
  link(threadId: string, ...files: FakeFileLink[]): void {
    this.links.set(threadId, [...(this.links.get(threadId) ?? []), ...files]);
  }

  #linksOf(id: string) {
    return {
      thread_id: id,
      files: (this.links.get(id) ?? []).map((f) => ({
        path: f.path,
        project_id: f.projectId ?? null,
        access: f.access,
        last_at: f.lastAt ?? LAST_AT,
        deleted: f.deleted ?? false,
      })),
      hidden_count: this.hidden.get(id) ?? 0,
    };
  }

  /** `/v1/threads/file-links`, `/v1/threads/{id}/file-links`, or undefined for any other path. */
  route(url: URL): Response | undefined {
    if (url.pathname === "/v1/threads/file-links") {
      const ids = split(url.searchParams.get("threads"));
      this.linkReads.push(ids);
      if (ids.length > 50) return answer(400, { code: "invalid_request", message: "too many" });
      return answer(200, {
        links: ids.filter((id) => this.titleOf(id) !== undefined).map((id) => this.#linksOf(id)),
      });
    }
    // One thread's links (KOBE-611): 404 when the viewer may not read it.
    const one = /^\/v1\/threads\/([^/]+)\/file-links$/u.exec(url.pathname);
    if (one) {
      const id = decodeURIComponent(one[1] ?? "");
      if (this.titleOf(id) === undefined) {
        return answer(404, { code: "thread_not_found", message: "No thread with that id." });
      }
      return answer(200, this.#linksOf(id));
    }
    if (url.pathname === "/v1/workspace/file-threads") {
      const paths = split(url.searchParams.get("paths"));
      this.fileReads.push(paths);
      if (paths.length > 100) return answer(400, { code: "invalid_request", message: "too many" });
      return answer(200, {
        files: paths.map((path) => ({
          path,
          threads: [...this.links]
            .flatMap(([threadId, files]) => {
              const used = files.filter((f) => f.path === path && f.deleted !== true);
              if (used.length === 0) return [];
              const title = this.titleOf(threadId);
              if (title === undefined) return [];
              return [
                {
                  thread_id: threadId,
                  title,
                  access: used.some((f) => f.access === "write") ? "write" : "read",
                  last_at: used[0]?.lastAt ?? LAST_AT,
                },
              ];
            })
            .sort((a, b) => b.last_at.localeCompare(a.last_at)),
          more: this.more.get(path) ?? 0,
        })),
      });
    }
    return undefined;
  }
}
