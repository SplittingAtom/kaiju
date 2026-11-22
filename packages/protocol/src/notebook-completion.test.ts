import { describe, expect, it } from "vitest";
import {
  CAPABILITY_NOTEBOOK_COMPLETE,
  NOTEBOOK_COMPLETE_CODE_MAX_BYTES,
  NOTEBOOK_COMPLETE_MATCHES_MAX,
  NOTEBOOK_DOC_MAX_CHARS,
  notebookCompletionBodySchema,
  notebookCompletionResultSchema,
} from "./notebook-completion.js";
import { notebookInspectFrameSchema } from "./sandbox-wire/index.js";
import { serverToSandboxFrameSchema } from "./sandbox-wire/frames.js";

const THREAD = "5a2b3c4d-6e7f-4a8b-9c0d-1e2f3a4b5c6d";

describe("notebook completion contract (KOBE-808)", () => {
  it("names its capability", () => {
    expect(CAPABILITY_NOTEBOOK_COMPLETE).toBe("notebook_complete");
  });

  it("takes a completion body: code with a cursor inside it", () => {
    const ok = notebookCompletionBodySchema.safeParse({ op: "complete", code: "df.al", cursor: 5 });
    expect(ok.success).toBe(true);
    // The cursor is in code points: "😀" is one.
    expect(
      notebookCompletionBodySchema.safeParse({ op: "complete", code: "😀x", cursor: 2 }).success,
    ).toBe(true);
    expect(
      notebookCompletionBodySchema.safeParse({ op: "complete", code: "😀x", cursor: 3 }).success,
    ).toBe(false);
    expect(
      notebookCompletionBodySchema.safeParse({ op: "complete", code: "x", cursor: -1 }).success,
    ).toBe(false);
    expect(
      notebookCompletionBodySchema.safeParse({ op: "complete", code: "a\u0000", cursor: 1 })
        .success,
    ).toBe(false);
    // A lone surrogate (an editor can hold one) is refused here, never a database error later.
    for (const code of ["a\uD800", "\uDC00b", "x\uD800\uD800y"]) {
      expect(
        notebookCompletionBodySchema.safeParse({ op: "complete", code, cursor: 1 }).success,
      ).toBe(false);
    }
    expect(
      notebookCompletionBodySchema.safeParse({ op: "complete", code: "\uD83D\uDE00", cursor: 1 })
        .success,
    ).toBe(true);
    const big = "x".repeat(NOTEBOOK_COMPLETE_CODE_MAX_BYTES + 1);
    expect(
      notebookCompletionBodySchema.safeParse({ op: "complete", code: big, cursor: 1 }).success,
    ).toBe(false);
    expect(
      notebookCompletionBodySchema.safeParse({ op: "complete", code: "x", cursor: 1, extra: 1 })
        .success,
    ).toBe(false);
  });

  it("takes a doc body: a dotted Python name only, never code", () => {
    expect(notebookCompletionBodySchema.safeParse({ op: "doc", name: "pd.read_csv" }).success).toBe(
      true,
    );
    for (const name of ["", "a()", "a.b()", "x[0]", "1a", "a..b", "a.", "import os", "é"]) {
      expect(notebookCompletionBodySchema.safeParse({ op: "doc", name }).success, name).toBe(false);
    }
    expect(
      notebookCompletionBodySchema.safeParse({ op: "doc", name: "a", code: "a" }).success,
    ).toBe(false);
    expect(notebookCompletionBodySchema.safeParse({ op: "run", name: "a" }).success).toBe(false);
  });

  it("reads completion answers with capped matches", () => {
    const answer = {
      status: "ok",
      op: "complete",
      matches: [{ text: "alpha", type: "attribute" }, { text: "align" }],
      cursor_start: 3,
      cursor_end: 5,
    };
    expect(notebookCompletionResultSchema.safeParse(answer).success).toBe(true);
    expect(notebookCompletionResultSchema.safeParse({ ...answer, cursor_start: 6 }).success).toBe(
      false,
    );
    const many = Array.from({ length: NOTEBOOK_COMPLETE_MATCHES_MAX + 1 }, (_, i) => ({
      text: `m${i}`,
    }));
    expect(notebookCompletionResultSchema.safeParse({ ...answer, matches: many }).success).toBe(
      false,
    );
    expect(
      notebookCompletionResultSchema.safeParse({ ...answer, matches: [{ text: "" }] }).success,
    ).toBe(false);
  });

  it("reads doc answers with capped text", () => {
    const doc = { status: "ok", op: "doc", found: true, signature: "f(x, y=2)", doc: "Adds." };
    expect(notebookCompletionResultSchema.safeParse(doc).success).toBe(true);
    expect(
      notebookCompletionResultSchema.safeParse({ status: "ok", op: "doc", found: false }).success,
    ).toBe(true);
    expect(
      notebookCompletionResultSchema.safeParse({
        ...doc,
        doc: "d".repeat(NOTEBOOK_DOC_MAX_CHARS + 1),
      }).success,
    ).toBe(false);
  });

  it("reads the states without an answer", () => {
    for (const status of ["busy", "no_kernel", "unavailable", "asleep", "unsupported"]) {
      expect(notebookCompletionResultSchema.safeParse({ status }).success, status).toBe(true);
    }
    expect(notebookCompletionResultSchema.safeParse({ status: "ok" }).success).toBe(false);
  });

  it("frames: completion and doc variants of notebook.inspect; the snapshot frame unchanged", () => {
    const base = { v: 1, type: "notebook.inspect", command_id: "c1", thread_id: THREAD };
    const complete = { ...base, op: "complete", code: "df.", cursor: 3, timeout_ms: 1000 };
    const doc = { ...base, op: "doc", name: "df.head" };
    for (const f of [base, complete, doc]) {
      expect(notebookInspectFrameSchema.safeParse(f).success).toBe(true);
      expect(serverToSandboxFrameSchema.safeParse(f).success).toBe(true);
    }
    expect(notebookInspectFrameSchema.safeParse({ ...complete, cursor: 4 }).success).toBe(false);
    expect(notebookInspectFrameSchema.safeParse({ ...complete, refresh: true }).success).toBe(
      false,
    );
    expect(notebookInspectFrameSchema.safeParse({ ...complete, timeout_ms: 5000 }).success).toBe(
      false,
    );
    expect(notebookInspectFrameSchema.safeParse({ ...doc, name: "os.system('x')" }).success).toBe(
      false,
    );
    expect(notebookInspectFrameSchema.safeParse({ ...base, op: "complete" }).success).toBe(false);
  });
});
