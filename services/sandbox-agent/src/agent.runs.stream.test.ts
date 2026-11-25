import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseTranslatedPiEvent } from "@kaiju/protocol/sandbox-wire";
import { describe, expect, it } from "vitest";
import {
  RUN,
  RUN_2,
  THREAD,
  THREAD_2,
  FAKE_POLICY_EXTENSION,
  runStart,
  startHarness,
  until,
  type Harness,
} from "./testing/harness.js";
import { type PiEvent, settled, events, useAgentRunsHarness } from "./agent.runs.test-helpers.js";

let h: Harness;
useAgentRunsHarness(() => h);

describe("run.start → Pi prompt → pi.event stream", () => {
  it("streams Pi events with gapless per-run seqs and answers the command once", async () => {
    h = await startHarness();
    const result = await h.server.command(runStart("say:Hello"));
    expect(result).toMatchObject({ ok: true, data: { disposition: "started" } });
    await h.server.waitFor(settled());
    const stream = events();
    expect(stream.map((f) => f.seq)).toEqual(stream.map((_, i) => i + 1));
    expect(stream.map((f) => f.event.type)).toEqual([
      "agent_start",
      "message_update",
      "message_update",
      "turn_end",
      "agent_end",
      "agent_settled",
    ]);
    for (const f of stream) expect(parseTranslatedPiEvent(f.event).kind).not.toBe("invalid");
    const deltas = stream.flatMap((f) =>
      f.event.type === "message_update"
        ? [(f.event.assistantMessageEvent as { delta: string }).delta]
        : [],
    );
    expect(deltas.join("")).toBe("Hello");
    expect(stream.every((f: PiEvent) => f.thread_id === THREAD)).toBe(true);
  });

  it("passes the agent's system prompt to Pi as an appended, agent-owned file (KOBE-123)", async () => {
    const prompt =
      'You are the marker agent. KAIJU-PROMPT-MARKER:abc \u00e9 `$(rm -rf /)` "quoted"';
    h = await startHarness();
    await h.server.command(runStart("say:hi", { config: { system_prompt: prompt } }));
    const [launch] = await h.commandsLog();
    const argv = launch?.argv as string[];
    const at = argv.indexOf("--append-system-prompt");
    expect(at).toBeGreaterThan(-1);
    expect(argv).not.toContain("--system-prompt"); // append: Pi's tool and skill prompt stays
    const file = argv[at + 1] as string;
    expect(argv.join("\n")).not.toContain("KAIJU-PROMPT-MARKER");
    expect(path.basename(file)).toBe("system-prompt.md");
    expect(launch?.appendSystemPromptText).toBe(prompt);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await h.close();
    await expect(stat(file)).rejects.toThrow(); // removed with the process's runtime directory
  });

  it("starts Pi without the flag when the run has no system prompt (KOBE-123)", async () => {
    h = await startHarness();
    await h.server.command(runStart("say:hi", { config: { system_prompt: "" } }));
    const [launch] = await h.commandsLog();
    expect(launch?.argv).not.toContain("--append-system-prompt");
  });

  it("runs Pi in RPC mode with an allow-listed environment (no agent secrets)", async () => {
    h = await startHarness();
    await h.server.command(runStart("say:hi"));
    const [launch] = await h.commandsLog();
    expect(launch?.argv).toEqual([
      "--mode",
      "rpc",
      "--session",
      path.join(h.sessions, `${THREAD}.jsonl`),
      "--no-extensions",
      "--no-approve",
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--extension",
      FAKE_POLICY_EXTENSION,
    ]);
    expect(launch?.env).toContain("PI_CODING_AGENT_DIR");
    expect(launch?.env).not.toContain("SECRET_IN_AGENT_ENV");
    const kaijuVars = (launch?.env as string[]).filter((k) => k.startsWith("KAIJU_"));
    expect(kaijuVars).toEqual(["KAIJU_POLICY_FD", "KAIJU_TOOL_HOME", "KAIJU_TOOL_TMPDIR"]);
    const prompts = (await h.commandsLog()).filter((c) => c.type === "prompt");
    expect(prompts).toEqual([{ type: "prompt", message: "say:hi", id: expect.any(String) }]);
  });

  it("ignores a duplicate command_id on the same connection", async () => {
    h = await startHarness();
    const frame = { v: 1, command_id: "dup-1", ...runStart("say:hi") } as never;
    h.server.send(frame);
    h.server.send(frame);
    await h.server.waitFor(settled());
    await new Promise((r) => setTimeout(r, 100));
    expect(h.server.frames("command.result").filter((f) => f.command_id === "dup-1")).toHaveLength(
      1,
    );
  });

  it("reports Pi's rejection and does not keep the run", async () => {
    h = await startHarness();
    const result = await h.server.command(runStart("reject"));
    expect(result).toMatchObject({
      ok: false,
      error: { code: "pi_rejected", message: "No API key found" },
    });
    // The thread is free for the next run.
    expect(await h.server.command({ ...runStart("say:ok"), run_id: RUN_2 })).toMatchObject({
      ok: true,
    });
  });

  it("ends a run whose prompt Pi handled without starting one", async () => {
    h = await startHarness();
    expect(await h.server.command(runStart("handled"))).toMatchObject({
      ok: true,
      data: { disposition: "handled" },
    });
    expect(await h.server.command({ ...runStart("say:x"), run_id: RUN_2 })).toMatchObject({
      ok: true,
    });
  });

  it("refuses a second run on a busy thread but runs threads concurrently", async () => {
    h = await startHarness();
    await h.server.command(runStart("hang"));
    expect(await h.server.command({ ...runStart("hang"), run_id: RUN_2 })).toMatchObject({
      ok: false,
      error: { code: "pi_rejected" },
    });
    expect(
      await h.server.command({ ...runStart("say:other"), run_id: RUN_2, thread_id: THREAD_2 }),
    ).toMatchObject({ ok: true });
    await h.server.waitFor(settled(RUN_2));
  });

  it("lists attachments in the prompt and refuses paths outside the workspace", async () => {
    h = await startHarness();
    const outside = await h.server.command(
      runStart("say:x", { attachments: [{ path: "/etc/passwd", mime_type: "text/plain" }] }),
    );
    expect(outside).toMatchObject({ ok: false, error: { code: "pi_rejected" } });
    const file = path.join(h.workspace, "uploads", "sales.csv");
    await h.server.command(
      runStart("say:x", { attachments: [{ path: file, mime_type: "text/csv" }] }),
    );
    const prompt = (await h.commandsLog()).find((c) => c.type === "prompt");
    expect(prompt?.message).toBe(`say:x\n\nAttached files:\n- ${file} (text/csv)`);
  });

  it("refuses attachments that reach outside the workspace through a symlink (KOBE-144)", async () => {
    h = await startHarness();
    const outsideDir = await mkdtemp(path.join(tmpdir(), "kaiju-outside-"));
    await writeFile(path.join(outsideDir, "secret.txt"), "secret");
    await mkdir(path.join(h.workspace, "uploads"), { recursive: true });
    await symlink(outsideDir, path.join(h.workspace, "uploads", "dir"));
    await symlink(path.join(outsideDir, "secret.txt"), path.join(h.workspace, "uploads", "file"));
    await symlink(path.join(outsideDir, "gone"), path.join(h.workspace, "uploads", "dangling"));
    for (const link of ["dir/secret.txt", "file", "dangling"]) {
      const result = await h.server.command(
        runStart("say:x", {
          attachments: [{ path: path.join(h.workspace, "uploads", link), mime_type: "text/plain" }],
        }),
      );
      expect(result, link).toMatchObject({ ok: false, error: { code: "pi_rejected" } });
    }
  });

  it("refuses a symlink planted after the pre-check, before the prompt (KOBE-144)", async () => {
    const outsideDir = await mkdtemp(path.join(tmpdir(), "kaiju-outside-"));
    await writeFile(path.join(outsideDir, "secret.png"), "secret");
    h = await startHarness({
      workspace: (dir) => ({
        async beforeRun() {
          await mkdir(path.join(dir, "uploads"), { recursive: true });
          await symlink(path.join(outsideDir, "secret.png"), path.join(dir, "uploads", "p.png"));
        },
        runEnded: () => undefined,
        flush: () => Promise.resolve(),
      }),
    });
    const result = await h.server.command(
      runStart("say:x", {
        attachments: [
          {
            path: path.join(h.workspace, "uploads", "p.png"),
            mime_type: "image/png",
            native_media: "image",
          },
        ],
      }),
    );
    expect(result).toMatchObject({ ok: false, error: { code: "pi_rejected" } });
  });

  it("passes native images to Pi as image blocks, other media by path with a note (KOBE-144)", async () => {
    h = await startHarness();
    const dir = path.join(h.workspace, "uploads", THREAD);
    await mkdir(dir, { recursive: true });
    const png = Buffer.from("not-really-a-png");
    await writeFile(path.join(dir, "a.png"), png);
    await writeFile(path.join(dir, "b.pdf"), "%PDF-1.4");
    await writeFile(path.join(dir, "c.png"), png);
    const result = await h.server.command(
      runStart("say:x", {
        attachments: [
          { path: path.join(dir, "a.png"), mime_type: "image/png", native_media: "image" },
          { path: path.join(dir, "b.pdf"), mime_type: "application/pdf", native_media: "pdf" },
          { path: path.join(dir, "c.png"), mime_type: "image/png" },
        ],
      }),
    );
    expect(result).toMatchObject({ ok: true });
    const prompt = (await h.commandsLog()).find((c) => c.type === "prompt");
    expect(prompt?.images).toEqual([
      { type: "image", data: png.toString("base64"), mimeType: "image/png" },
    ]);
    expect(prompt?.message).toContain(
      `${path.join(dir, "a.png")} (image/png) - shown to you as an image`,
    );
    expect(prompt?.message).toContain(
      `b.pdf (application/pdf) - not shown inline; open it from this path`,
    );
    expect(prompt?.message).toContain(`c.png (image/png) - not shown inline`);
  });
});

describe("workspace sync hooks (KOBE-27)", () => {
  it("restores the workspace before the prompt reaches Pi, and pushes after the run and on stop", async () => {
    const calls: string[] = [];
    h = await startHarness({
      workspace: (dir) => ({
        async beforeRun(frame) {
          calls.push(`beforeRun:${frame.run_id}`);
          await mkdir(path.join(dir, "uploads"), { recursive: true });
          await writeFile(path.join(dir, "uploads", "sales.csv"), "a,b\n");
        },
        runEnded: () => void calls.push("runEnded"),
        flush: (ms) => Promise.resolve(void calls.push(`flush:${ms}`)),
        prove: () => Promise.resolve(void calls.push("prove")),
      }),
    });
    const file = path.join(h.workspace, "uploads", "sales.csv");
    const result = await h.server.command(
      runStart("say:x", { attachments: [{ path: file, mime_type: "text/csv" }] }),
    );
    expect(result).toMatchObject({ ok: true });
    // Pi saw the prompt only after the hook had put the upload in place.
    const prompt = (await h.commandsLog()).find((c) => c.type === "prompt");
    expect(prompt).toBeDefined();
    expect(readFileSync(file, "utf8")).toBe("a,b\n");
    await h.server.waitFor(settled());
    await until(() => calls.includes("runEnded"));
    expect(calls[0]).toBe(`beforeRun:${RUN}`);
    await h.agent.stop(500);
    // Without Pi identities (this harness) no reclaim proof is offered (KOBE-733).
    expect(calls.at(-1)).toBe("flush:15000");
  });

  it("fails the run when the workspace cannot be prepared, before Pi sees the prompt", async () => {
    h = await startHarness({
      workspace: () => ({
        beforeRun: () =>
          Promise.reject(new Error("attachment uploads/x.csv is not in the workspace")),
        runEnded: () => undefined,
        flush: () => Promise.resolve(),
      }),
    });
    const result = await h.server.command(runStart("say:x"));
    expect(result).toMatchObject({ ok: false });
    const log = existsSync(path.join(h.sessions, `${THREAD}.jsonl.commands.jsonl`))
      ? await h.commandsLog()
      : [];
    expect(log.find((c) => c.type === "prompt")).toBeUndefined();
  });
});

/** The fake logs stdin lines and each turn_end it emits, in order: abort must follow a turn_end. */
async function expectAbortAfterTurnEnd(): Promise<void> {
  const log = await h.commandsLog();
  const firstTurnEnd = log.findIndex((c) => c.emitted === "turn_end");
  const firstAbort = log.findIndex((c) => c.type === "abort");
  expect(firstTurnEnd).toBeGreaterThan(-1);
  expect(firstAbort).toBeGreaterThan(firstTurnEnd);
}

describe("run.steer and run.stop", () => {
  it("forwards steer to the active run only", async () => {
    h = await startHarness();
    await h.server.command(runStart("hang"));
    const steer = { type: "run.steer", run_id: RUN, thread_id: THREAD, message: "bar chart" };
    expect(await h.server.command(steer)).toMatchObject({
      ok: true,
      data: { disposition: "queued" },
    });
    expect(await h.server.command({ ...steer, run_id: RUN_2 })).toMatchObject({
      ok: false,
      error: { code: "unknown_run" },
    });
    expect((await h.commandsLog()).filter((c) => c.type === "steer")).toEqual([
      { type: "steer", message: "bar chart", id: expect.any(String) },
    ]);
  });

  it("Stop clears Pi's queue, aborts, and answers once the run ended", async () => {
    h = await startHarness();
    await h.server.command(runStart("hang"));
    const stop = await h.server.command({
      type: "run.stop",
      run_id: RUN,
      thread_id: THREAD,
      mode: "abort",
      reason: "user_cancelled",
    });
    expect(stop).toMatchObject({ ok: true });
    const types = (await h.commandsLog()).map((c) => c.type).filter(Boolean);
    expect(types.slice(-2)).toEqual(["clear_queue", "abort"]);
    expect(events().at(-1)?.event.type).toBe("agent_settled");
  });

  it("after_step waits for the in-flight step (turn_end) before aborting", async () => {
    h = await startHarness();
    await h.server.command(runStart("steps"));
    const stop = await h.server.command({
      type: "run.stop",
      run_id: RUN,
      thread_id: THREAD,
      mode: "after_step",
      reason: "budget_exhausted",
    });
    expect(stop).toMatchObject({ ok: true });
    const stream = events().map((f) => f.event.type);
    expect(stream).toContain("turn_end");
    expect(stream.at(-1)).toBe("agent_settled");
    await expectAbortAfterTurnEnd();
  });

  it("after_step arriving between Pi's prompt answer and agent_start still waits for a step", async () => {
    h = await startHarness();
    // Pi answers the prompt at once but starts the run 200 ms later: the stop lands in between.
    await h.server.command(runStart("late-steps"));
    const stop = await h.server.command({
      type: "run.stop",
      run_id: RUN,
      thread_id: THREAD,
      mode: "after_step",
      reason: "budget_exhausted",
    });
    expect(stop).toMatchObject({ ok: true });
    expect(events().map((f) => f.event.type)).toContain("turn_end");
    await expectAbortAfterTurnEnd();
  });
});

describe("pi.command", () => {
  it("forwards allow-listed commands with the agent's own id and returns Pi's data", async () => {
    h = await startHarness();
    const result = await h.server.command({
      type: "pi.command",
      thread_id: THREAD,
      command: { id: "server-chosen", type: "get_state" },
    });
    expect(result).toMatchObject({ ok: true, data: { isStreaming: false } });
    const sent = (await h.commandsLog()).find((c) => c.type === "get_state");
    expect(sent?.id).not.toBe("server-chosen");
  });

  it("refuses fork (not in the contract: it would move Pi off the thread's session file)", async () => {
    h = await startHarness();
    h.server.sendRaw(
      JSON.stringify({
        v: 1,
        type: "pi.command",
        command_id: "fork-1",
        thread_id: THREAD,
        command: { id: "x", type: "fork", entryId: "a1" },
      }),
    );
    await h.server.waitFor((f) => f.type === "error" && f.code === "malformed_frame");
    expect(h.server.frames("command.result").some((r) => r.command_id === "fork-1")).toBe(false);
  });

  it("answers frame_too_large when Pi's data does not fit in one frame", async () => {
    h = await startHarness();
    expect(
      await h.server.command({
        type: "pi.command",
        thread_id: THREAD,
        command: { id: "x", type: "get_tree" },
      }),
    ).toMatchObject({ ok: false, error: { code: "frame_too_large" } });
  });

  it("surfaces Pi errors as pi_rejected", async () => {
    h = await startHarness();
    expect(
      await h.server.command({
        type: "pi.command",
        thread_id: THREAD,
        command: { id: "x", type: "get_entries", since: "nope" },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "pi_rejected", message: "Entry not found: nope" },
    });
  });
});

describe("Pi output hygiene", () => {
  it("replaces an event too large for one frame by a placeholder, keeping seqs gapless", async () => {
    h = await startHarness();
    await h.server.command(runStart("big"));
    await h.server.waitFor(settled());
    const stream = events();
    expect(stream.map((f) => f.seq)).toEqual(stream.map((_, i) => i + 1));
    expect(stream[1]?.event).toEqual({
      type: "kaiju.event_dropped",
      original_type: "tool_execution_update",
      reason: "frame_too_large",
    });
  });

  it("maps U+0000 to U+FFFD and drops __proto__ keys before sending", async () => {
    h = await startHarness();
    await h.server.command(runStart("dirty"));
    await h.server.waitFor(settled());
    const dirty = events().find((f) => f.event.type === "custom_dirty")?.event;
    expect(dirty).toEqual({ type: "custom_dirty", text: "a�b", nested: { ok: 1 } });
  });
});
