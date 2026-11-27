import { describe, expect, it } from "vitest";
import { kaijuToolsRequestSchema, kaijuToolsResponseSchema } from "./artifacts.js";
import {
  EDITOR_READ_TEXT_MAX_BYTES,
  editorReadInputSchema,
  editorRunInputSchema,
} from "./editor-tools.js";
import { sandboxToServerFrameSchema, serverToSandboxFrameSchema } from "./sandbox-wire/frames.js";
import { BUILTIN_TOOLS, builtinToolDescriptor } from "./tools.js";

const RUN = "4f1c2a3b-5d6e-4f70-8a9b-0c1d2e3f4a5b";
const THREAD = "5a2b3c4d-6e7f-4a8b-9c0d-1e2f3a4b5c6d";

describe("editor tools (KOBE-848)", () => {
  it("editor_run is a Kaiju-scoped write (asks by default); editor_read is a read", () => {
    expect(builtinToolDescriptor("editor_run")).toMatchObject({ risk: "write", scope: "kaiju" });
    expect(builtinToolDescriptor("editor_read")).toMatchObject({ risk: "read", scope: "kaiju" });
    expect(BUILTIN_TOOLS.editor_run?.primary_arg).toBe("/path");
  });

  it("takes only a .py path, no code, cells or lines", () => {
    expect(editorRunInputSchema.safeParse({ path: "/workspace/a.py" }).success).toBe(true);
    expect(editorRunInputSchema.safeParse({ path: "a.py", timeout_s: 30 }).success).toBe(true);
    for (const bad of [
      { path: "a.ipynb" },
      { path: "../a.py" },
      { path: "a\n.py" },
      { path: "a.py", code: "print(1)" },
      { path: "a.py", lines: { start: 1, end: 2 } },
      { path: "a.py", timeout_s: 0 },
      {},
    ]) {
      expect(editorRunInputSchema.safeParse(bad).success).toBe(false);
    }
    for (const what of ["output", "log", "variables"]) {
      expect(editorReadInputSchema.safeParse({ path: "a.py", what }).success).toBe(true);
    }
    expect(editorReadInputSchema.safeParse({ path: "a.py", what: "all" }).success).toBe(false);
    expect(editorReadInputSchema.safeParse({ path: "a.py" }).success).toBe(false);
  });

  it("editor_run rides notebook.run; editor_read has its own frames", () => {
    const run = {
      v: 1,
      type: "notebook.run",
      request_id: "nb_1",
      run_id: RUN,
      thread_id: THREAD,
      tool_call_id: "call_1",
      tool: "editor_run",
      input: { path: "/workspace/a.py" },
    };
    expect(sandboxToServerFrameSchema.safeParse(run).success).toBe(true);
    // editor_run's input never takes run_python's code.
    expect(
      sandboxToServerFrameSchema.safeParse({ ...run, input: { code: "print(1)" } }).success,
    ).toBe(false);
    const read = {
      v: 1,
      type: "editor.read",
      request_id: "er_1",
      run_id: RUN,
      thread_id: THREAD,
      tool_call_id: "call_2",
      tool: "editor_read",
      input: { path: "a.py", what: "variables" },
    };
    expect(sandboxToServerFrameSchema.safeParse(read).success).toBe(true);
    expect(sandboxToServerFrameSchema.safeParse({ ...read, tool: "editor_run" }).success).toBe(
      false,
    );
    const ok = {
      v: 1,
      type: "editor.read_result",
      request_id: "er_1",
      ok: true,
      op: "editor_read",
      what: "log",
      text: "x",
      truncated: false,
    };
    expect(serverToSandboxFrameSchema.safeParse(ok).success).toBe(true);
    const tooBig = { ...ok, text: "x".repeat(EDITOR_READ_TEXT_MAX_BYTES + 1) };
    expect(serverToSandboxFrameSchema.safeParse(tooBig).success).toBe(false);
    const fail = { ...ok, ok: false, error: { code: "a_new_code", message: "m" } };
    delete (fail as Partial<typeof ok>).op;
    delete (fail as Partial<typeof ok>).what;
    delete (fail as Partial<typeof ok>).text;
    delete (fail as Partial<typeof ok>).truncated;
    expect(serverToSandboxFrameSchema.safeParse(fail).success).toBe(true);
  });

  it("is part of the kaiju-tools channel", () => {
    expect(
      kaijuToolsRequestSchema.safeParse({
        id: "1",
        op: "notebook.run",
        tool_call_id: "c",
        tool: "editor_run",
        input: { path: "a.py" },
      }).success,
    ).toBe(true);
    expect(
      kaijuToolsRequestSchema.safeParse({
        id: "1",
        op: "editor.read",
        tool_call_id: "c",
        tool: "editor_read",
        input: { path: "a.py", what: "output" },
      }).success,
    ).toBe(true);
    expect(
      kaijuToolsResponseSchema.safeParse({
        id: "1",
        ok: true,
        op: "editor_read",
        what: "output",
        text: "",
        truncated: false,
      }).success,
    ).toBe(true);
  });
});
