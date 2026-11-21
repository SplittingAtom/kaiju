import { describe, expect, it, vi } from "vitest";
import { batches, createFileLinksApi } from "./file-links";

const T1 = "00000000-0000-4000-8000-000000000001";
const T2 = "00000000-0000-4000-8000-000000000002";
const AT = "2026-11-10T10:00:00.000Z";

const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("createFileLinksApi", () => {
  it("reads the rows' links in one request and camelizes them", async () => {
    const fetchFn = vi.fn(async () =>
      answer({
        links: [
          {
            thread_id: T1,
            files: [
              { path: "a,b.md", project_id: null, access: "write", last_at: AT, deleted: false },
            ],
            hidden_count: 2,
          },
        ],
      }),
    );
    const api = createFileLinksApi("team", fetchFn as unknown as typeof fetch);
    const res = await api.threadFileLinks([T1, T2]);
    expect(res).toEqual({
      ok: true,
      status: 200,
      data: [
        {
          threadId: T1,
          hiddenCount: 2,
          files: [{ path: "a,b.md", projectId: null, access: "write", lastAt: AT, deleted: false }],
        },
      ],
    });
    const url = String((fetchFn.mock.calls[0] as unknown[])[0]);
    expect(url).toContain(`/v1/threads/file-links?threads=${T1},${T2}`);
  });

  it("encodes each path (commas too) and refuses a malformed answer", async () => {
    const fetchFn = vi.fn(async () => answer({ files: [{ path: "x", threads: "nope" }] }));
    const api = createFileLinksApi("team", fetchFn as unknown as typeof fetch);
    const res = await api.fileThreads(["a,b.md", "c d"]);
    expect(res).toMatchObject({ ok: false, error: { code: "malformed_response" } });
    expect(String((fetchFn.mock.calls[0] as unknown[])[0])).toContain("paths=a%2Cb.md,c%20d");
  });

  it("reads one thread's links; asks nothing for no ids; refuses over the cap", async () => {
    const fetchFn = vi.fn(async () => answer({ thread_id: T1, files: [], hidden_count: 0 }));
    const api = createFileLinksApi("team", fetchFn as unknown as typeof fetch);
    expect(await api.threadFileList(T1)).toMatchObject({ ok: true, data: { threadId: T1 } });
    expect(await api.threadFileLinks([])).toMatchObject({ ok: true, data: [] });
    expect(await api.fileThreads([])).toMatchObject({ ok: true, data: [] });
    const many = Array.from({ length: 51 }, (_, i) => `t${i}`);
    expect(await api.threadFileLinks(many)).toMatchObject({ ok: false });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("reads a file's threads, title null when untitled", async () => {
    const thread = { thread_id: T1, title: null, access: "read", last_at: AT };
    const fetchFn = vi.fn(async () =>
      answer({ files: [{ path: "a.md", threads: [thread], more: 1 }] }),
    );
    const api = createFileLinksApi("team", fetchFn as unknown as typeof fetch);
    expect(await api.fileThreads(["a.md"])).toEqual({
      ok: true,
      status: 200,
      data: [
        {
          path: "a.md",
          more: 1,
          threads: [{ threadId: T1, title: null, access: "read", lastAt: AT }],
        },
      ],
    });
  });

  it("checks answers against the protocol's strict schemas", async () => {
    const link = { thread_id: T1, files: [], hidden_count: 0 };
    const refused = [
      { ...link, extra: 1 }, // unknown field
      { ...link, thread_id: "t1" }, // not a uuid
      {
        ...link,
        files: [{ path: "a.md", project_id: null, access: "read", last_at: "x", deleted: false }],
      },
    ];
    for (const body of refused) {
      const api = createFileLinksApi("team", (async () => answer(body)) as unknown as typeof fetch);
      expect(await api.threadFileList(T1)).toMatchObject({
        ok: false,
        error: { code: "malformed_response" },
      });
    }
  });

  it("batches", () => {
    expect(batches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});
