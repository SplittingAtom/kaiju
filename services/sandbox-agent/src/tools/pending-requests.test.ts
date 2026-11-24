import type { KaijuToolsResponse } from "@kaiju/protocol";
import { describe, expect, it } from "vitest";
import { PendingRequests } from "./pending-requests.js";

function must(id: string | undefined): string {
  if (id === undefined) throw new Error("not admitted");
  return id;
}

function setup(max = 4, maxPerThread = 2) {
  const pending = new PendingRequests({ prefix: "xy", max, maxPerThread });
  const replies: KaijuToolsResponse[] = [];
  const reply = (r: KaijuToolsResponse) => replies.push(r);
  return { pending, replies, reply };
}

describe("PendingRequests", () => {
  it("mints ids from the prefix, one counter per tracker, never reused", () => {
    const t = setup();
    expect(t.pending.add("t1", "r1", "kt_1", t.reply)).toBe("xy_1");
    expect(t.pending.add("t2", "r1", "kt_2", t.reply)).toBe("xy_2");
    t.pending.take("xy_1");
    expect(t.pending.add("t1", "r1", "kt_3", t.reply)).toBe("xy_3");
    expect(
      new PendingRequests({ prefix: "ab", max: 1, maxPerThread: 1 }).add("t", "r", "k", t.reply),
    ).toBe("ab_1");
  });

  it("refuses past the per-thread cap without minting an id", () => {
    const t = setup(4, 2);
    t.pending.add("t1", "r1", "kt_1", t.reply);
    t.pending.add("t1", "r1", "kt_2", t.reply);
    expect(t.pending.add("t1", "r1", "kt_3", t.reply)).toBeUndefined();
    expect(t.pending.add("t2", "r2", "kt_4", t.reply)).toBe("xy_3");
    expect(t.pending.size).toBe(3);
    expect(t.replies).toEqual([]);
  });

  it("refuses past the global cap", () => {
    const t = setup(3, 2);
    t.pending.add("t1", "r1", "kt_1", t.reply);
    t.pending.add("t2", "r2", "kt_2", t.reply);
    t.pending.add("t3", "r3", "kt_3", t.reply);
    expect(t.pending.add("t4", "r4", "kt_4", t.reply)).toBeUndefined();
    expect(t.pending.size).toBe(3);
  });

  it("take answers exactly once: a second take (double answer) finds nothing", () => {
    const t = setup();
    const id = must(t.pending.add("t1", "r1", "kt_1", t.reply));
    expect(t.pending.has(id)).toBe(true);
    const first = t.pending.take(id);
    expect(first).toMatchObject({ threadId: "t1", runId: "r1", extensionId: "kt_1" });
    expect(t.pending.has(id)).toBe(false);
    expect(t.pending.take(id)).toBeUndefined();
    expect(t.pending.take("xy_99")).toBeUndefined();
  });

  it("fail answers one request with an error once, then is a no-op", () => {
    const t = setup();
    const id = must(t.pending.add("t1", "r1", "kt_1", t.reply));
    expect(t.pending.fail(id, "not_synced", "nope")).toBe(true);
    expect(t.pending.fail(id, "not_synced", "again")).toBe(false);
    expect(t.replies).toEqual([
      { id: "kt_1", ok: false, error: { code: "not_synced", message: "nope" } },
    ]);
  });

  it("fails by run, by thread and all, each with `unavailable`", () => {
    const t = setup(8, 4);
    t.pending.add("t1", "r1", "kt_1", t.reply);
    t.pending.add("t1", "r2", "kt_2", t.reply);
    t.pending.add("t2", "r3", "kt_3", t.reply);
    t.pending.add("t3", "r4", "kt_4", t.reply);

    t.pending.failRun("r2", "run ended");
    expect(t.replies).toEqual([
      { id: "kt_2", ok: false, error: { code: "unavailable", message: "run ended" } },
    ]);
    t.pending.failThread("t1", "thread gone");
    expect(t.replies.slice(1)).toEqual([
      { id: "kt_1", ok: false, error: { code: "unavailable", message: "thread gone" } },
    ]);
    t.pending.failAll("connection lost");
    expect(t.replies.slice(2).map((r) => r.id)).toEqual(["kt_3", "kt_4"]);
    expect(t.pending.size).toBe(0);
    t.pending.failAll("again");
    expect(t.replies).toHaveLength(4);
  });

  it("a request answered by a reply-time failRun is not answered again", () => {
    const t = setup();
    const id = must(
      t.pending.add("t1", "r1", "kt_1", (r) => {
        t.replies.push(r);
        t.pending.failRun("r1", "nested");
      }),
    );
    t.pending.failRun("r1", "run ended");
    expect(t.replies).toHaveLength(1);
    expect(t.pending.take(id)).toBeUndefined();
  });
});
