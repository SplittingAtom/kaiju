import { existsSync, readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { APP_CARD_CUSTOM_TYPE, CAPABILITY_APP_CARDS } from "@kobe/protocol";
import { describe, expect, it } from "vitest";
import {
  RUN,
  RUN_2,
  THREAD,
  THREAD_2,
  runStart,
  startHarness,
  until,
  type Harness,
} from "./testing/harness.js";
import { card, type PiEvent, settled, useAgentRunsHarness } from "./agent.runs.test-helpers.js";

let h: Harness;
useAgentRunsHarness(() => h);

describe("Pi process lifecycle", () => {
  it("reports an exited Pi with its stderr tail and respawns on the next run", async () => {
    h = await startHarness();
    await h.server.command(runStart("crash"));
    const exited = await h.server.waitFor((f) => f.type === "pi.exited");
    expect(exited).toMatchObject({ thread_id: THREAD, exit_code: 3 });
    expect((exited as { stderr_tail: string }).stderr_tail).toContain("fatal: something broke");
    expect(await h.server.command({ ...runStart("say:again"), run_id: RUN_2 })).toMatchObject({
      ok: true,
    });
    await h.server.waitFor(settled(RUN_2));
  });

  it("never exceeds the process cap when threads start concurrently", async () => {
    h = await startHarness({ env: { KOBE_MAX_PI_PROCESSES: "1" } });
    const [a, b] = await Promise.all([
      h.server.command(runStart("hang")),
      h.server.command({ ...runStart("hang"), run_id: RUN_2, thread_id: THREAD_2 }),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
  });

  it("does not report a Pi exit for a thread with no active run (not leased)", async () => {
    h = await startHarness();
    const result = await h.server.command({
      type: "pi.command",
      thread_id: THREAD,
      command: { id: "x", type: "get_session_stats" },
    });
    expect(result).toMatchObject({ ok: false, error: { code: "pi_unavailable" } });
    await new Promise((r) => setTimeout(r, 100));
    expect(h.server.frames("pi.exited")).toEqual([]);
  });

  it("reports pi_unavailable when Pi cannot be started", async () => {
    h = await startHarness({ piBin: "/nonexistent/pi" });
    expect(await h.server.command(runStart("say:x"))).toMatchObject({
      ok: false,
      error: { code: "pi_unavailable" },
    });
  });

  it("evicts the least recently used idle Pi at the process cap, never a busy one", async () => {
    h = await startHarness({ env: { KOBE_MAX_PI_PROCESSES: "1" } });
    await h.server.command(runStart("say:one"));
    await h.server.waitFor(settled());
    // Thread 1 is idle: thread 2 takes its slot.
    await h.server.command({ ...runStart("hang"), run_id: RUN_2, thread_id: THREAD_2 });
    // Thread 2 is busy: thread 1 cannot get a slot back.
    expect(
      await h.server.command({
        ...runStart("say:x"),
        run_id: "3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6079",
      }),
    ).toMatchObject({ ok: false, error: { code: "pi_unavailable" } });
  });
});

describe("kobe-policy channel (fd 3)", () => {
  it("relays the checks of a run started again under an ended run's id (KOBE-483)", async () => {
    h = await startHarness();
    await h.server.command(runStart("say:hi"));
    await h.server.waitFor((f) => f.type === "pi.event" && f.event.type === "agent_settled");
    await h.server.command(runStart("tool:bash"));
    const check = await h.server.waitFor((f) => f.type === "policy.check");
    expect(check).toMatchObject({ run_id: RUN, tool: "bash" });
  });

  it("relays a check to the server with run/thread ids and the decision back to Pi", async () => {
    h = await startHarness();
    await h.server.command(runStart("tool:bash"));
    const check = await h.server.waitFor((f) => f.type === "policy.check");
    expect(check).toMatchObject({
      run_id: RUN,
      thread_id: THREAD,
      tool: "bash",
      tool_call_id: "call_1",
      input: { command: "ls" },
    });
    h.server.send({
      v: 1,
      type: "policy.result",
      request_id: (check as { request_id: string }).request_id,
      run_id: RUN,
      tool_call_id: "call_1",
      decision: "allow",
      reasons: [{ code: "risk_read", stage: "risk_class", message: "read" }],
    } as never);
    const decision = await h.server.waitFor(
      (f) => f.type === "pi.event" && f.event.type === "kobe_test_policy_decision",
    );
    expect((decision as PiEvent).event).toMatchObject({ decision: "allow" });
  });

  it("delivers a decision whose reason code and stage it does not know (newer server)", async () => {
    h = await startHarness();
    await h.server.command(runStart("tool:bash"));
    const check = await h.server.waitFor((f) => f.type === "policy.check");
    h.server.sendRaw(
      JSON.stringify({
        v: 1,
        type: "policy.result",
        request_id: (check as { request_id: string }).request_id,
        run_id: RUN,
        tool_call_id: "call_1",
        decision: "allow",
        reasons: [
          { code: "a_code_from_the_future", stage: "a_future_stage", message: "new", extra: 1 },
        ],
      }),
    );
    const decision = await h.server.waitFor(
      (f) => f.type === "pi.event" && f.event.type === "kobe_test_policy_decision",
    );
    expect((decision as PiEvent).event).toMatchObject({ decision: "allow" });
    expect(h.server.frames("error")).toEqual([]);
  });

  it("starts no run when kobe-policy refuses to start (fail closed)", async () => {
    h = await startHarness({
      env: { KOBE_POLICY_EXTENSION: "/opt/kobe/pi-extensions/refuse/index.js" },
    });
    const result = await h.server.command(runStart("say:hi"));
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "pi_unavailable",
        message: "kobe-policy did not start: kobe-policy refused to start: fake refusal",
      },
    });
    const prompts = (await h.commandsLog()).filter((c) => c.type === "prompt");
    expect(prompts).toEqual([]);
  });

  it("starts no run when kobe-policy never reports ready (fail closed)", async () => {
    h = await startHarness({
      env: { KOBE_POLICY_EXTENSION: "/opt/kobe/pi-extensions/silent/index.js" },
      policyReadyTimeoutMs: 200,
    });
    const result = await h.server.command(runStart("say:hi"));
    expect(result).toMatchObject({
      ok: false,
      error: { code: "pi_unavailable", message: expect.stringMatching(/did not report ready/) },
    });
    expect((await h.commandsLog()).filter((c) => c.type === "prompt")).toEqual([]);
  });

  it("restarts a Pi whose policy channel closed instead of reusing it", async () => {
    h = await startHarness();
    await h.server.command(runStart("drop-policy"));
    await h.server.waitFor((f) => f.type === "pi.event" && f.event.type === "agent_settled");
    const harness = h;
    const launches = async () => (await harness.commandsLog()).filter((c) => "argv" in c).length;
    expect(await launches()).toBe(1);
    const second = await h.server.command(runStart("say:hi", { run_id: RUN_2 }));
    expect(second).toMatchObject({ ok: true });
    expect(await launches()).toBe(2);
  });

  it("gates pi.command on kobe-policy being ready", async () => {
    h = await startHarness({
      env: { KOBE_POLICY_EXTENSION: "/opt/kobe/pi-extensions/refuse/index.js" },
    });
    const result = await h.server.command({
      type: "pi.command",
      thread_id: THREAD,
      command: { id: "srv", type: "get_state" },
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "pi_unavailable", message: expect.stringMatching(/kobe-policy/) },
    });
    expect((await h.commandsLog()).filter((c) => c.type === "get_state")).toEqual([]);
  });

  it("denies pending checks when the connection drops (fail closed)", async () => {
    h = await startHarness();
    await h.server.command(runStart("tool:mcp__jira__create_issue"));
    await h.server.waitFor((f) => f.type === "policy.check");
    h.server.terminate();
    const decision = await h.server.waitFor(
      (f) => f.type === "pi.event" && f.event.type === "kobe_test_policy_decision",
    );
    expect((decision as PiEvent).event).toMatchObject({ decision: "deny" });
  });
});

describe("what a tool started by Pi can reach", () => {
  it("does not inherit the policy channel (fd 3) and cannot re-open it via /proc", async () => {
    h = await startHarness();
    await h.server.command(runStart("grandchild"));
    const probe = await h.server.waitFor(
      (f) => f.type === "pi.event" && f.event.type === "kobe_test_grandchild",
    );
    expect((probe as PiEvent).event).toMatchObject({
      // Its fd 3, if any, is not Pi's policy socket (Node itself opens low fds) ...
      sameChannel: false,
      // ... and the socket cannot be re-opened through /proc (Linux).
      procOpen: false,
      // The env var is inherited (harmless: it names an fd the tool does not have).
      env: ["KOBE_POLICY_FD", "KOBE_TOOL_HOME", "KOBE_TOOL_TMPDIR"],
    });
    await h.server.waitFor(settled());
    // The channel is intact: a real check still goes through.
    await h.server.command({ ...runStart("tool:bash"), run_id: RUN_2 });
    await h.server.waitFor((f) => f.type === "policy.check");
  });

  it("does not inherit the kobe-tools channel (fd 4) either (KOBE-128)", async () => {
    h = await startHarness({ toolsExtension: "/opt/kobe/pi-extensions/kobe-tools/index.js" });
    await h.server.command(runStart("grandchild"));
    const probe = await h.server.waitFor(
      (f) => f.type === "pi.event" && f.event.type === "kobe_test_grandchild",
    );
    expect((probe as PiEvent).event).toMatchObject({
      sameToolsChannel: false,
      fd4Write: false,
      procOpen4: false,
      // KOBE_TOOLS_MEMORY, KOBE_MEMORY_FILE (KOBE-157) and KOBE_TOOLS_FILE_EDITS (KOBE-462) are
      // removed by the real extension at load; the fake Pi keeps them.
      env: [
        "KOBE_MEMORY_FILE",
        "KOBE_POLICY_FD",
        "KOBE_TOOLS_FD",
        "KOBE_TOOLS_FILE_EDITS",
        "KOBE_TOOLS_MEMORY",
        "KOBE_TOOL_HOME",
        "KOBE_TOOL_TMPDIR",
      ],
    });
    await h.server.waitFor(settled());
  });

  it("control: a tool handed fd 3 sees the channel, and its forged request closes it", async () => {
    h = await startHarness();
    await h.server.command(runStart("grandchild-inherit"));
    const control = await h.server.waitFor(
      (f) => f.type === "pi.event" && f.event.type === "kobe_test_grandchild",
    );
    expect((control as PiEvent).event).toMatchObject({ sameChannel: true, fd3Write: true });
    await h.server.waitFor(settled());
    // The forged line had no nonce: the channel closed. That Pi is not reused: the next run gets a
    // fresh Pi with a fresh channel (and nonce).
    const harness = h;
    const launches = async () => (await harness.commandsLog()).filter((c) => "argv" in c).length;
    expect(await launches()).toBe(1);
    await h.server.command({ ...runStart("tool:bash"), run_id: RUN_2 });
    expect(await launches()).toBe(2);
    await h.server.waitFor((f) => f.type === "policy.check");
  });

  it.skipIf(!existsSync("/proc/self/stat"))(
    "kills tools Pi started in their own process group when the thread's Pi stops",
    async () => {
      h = await startHarness();
      await h.server.command(runStart("orphan"));
      const orphan = await h.server.waitFor(
        (f) => f.type === "pi.event" && f.event.type === "kobe_test_orphan",
      );
      const pid = (orphan as PiEvent).event.pid as number;
      expect(() => process.kill(pid, 0)).not.toThrow();
      await h.server.command({
        type: "run.stop",
        run_id: RUN,
        thread_id: THREAD,
        mode: "abort",
        reason: "user_cancelled",
      });
      await h.agent.stop(500);
      // process.kill(pid, 0) also succeeds on a zombie: check the /proc state, polling.
      await until(() => {
        try {
          return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.startsWith("Z") === true;
        } catch {
          return true; // gone
        }
      });
    },
  );
});

describe("extension UI relay", () => {
  it("forwards dialogs with the run id and relays the answer to Pi", async () => {
    h = await startHarness();
    await h.server.command(runStart("dialog"));
    const request = await h.server.waitFor((f) => f.type === "pi.ui_request");
    expect(request).toMatchObject({
      run_id: RUN,
      thread_id: THREAD,
      request: { id: "ui-1", method: "confirm" },
    });
    h.server.send({
      v: 1,
      type: "pi.ui_response",
      thread_id: THREAD,
      response: { type: "extension_ui_response", id: "ui-1", confirmed: true },
    });
    const answer = await h.server.waitFor(
      (f) => f.type === "pi.event" && f.event.type === "kobe_test_dialog_answer",
    );
    expect((answer as PiEvent).event).toMatchObject({ answer: { confirmed: true } });
  });

  it("cancels open dialogs whose run the server no longer lists after a reconnect", async () => {
    h = await startHarness({ server: { ackRuns: () => [] } });
    await h.server.command(runStart("dialog"));
    await h.server.waitFor((f) => f.type === "pi.ui_request");
    h.server.terminate();
    await h.server.waitForOn(2, (f) => f.type === "hello");
    const cancelledLines = async () =>
      (await h.commandsLog()).filter((c) => c.type === "extension_ui_response" && c.id === "ui-1");
    await until(async () => (await cancelledLines()).length > 0);
    const cancelled = await cancelledLines();
    expect(cancelled).toEqual([{ type: "extension_ui_response", id: "ui-1", cancelled: true }]);
    expect(
      h.server.received.filter((r) => r.connection === 2 && r.frame.type === "pi.ui_request"),
    ).toEqual([]);
  });

  it("re-sends open dialogs after a reconnect", async () => {
    h = await startHarness();
    await h.server.command(runStart("dialog"));
    await h.server.waitFor((f) => f.type === "pi.ui_request");
    h.server.terminate();
    await h.server.waitForOn(2, (f) => f.type === "hello");
    await h.server.waitForOn(2, (f) => f.type === "pi.ui_request");
  });
});

describe("session.restore and branching (D13, D15)", () => {
  const header = {
    type: "session",
    version: 3,
    id: THREAD,
    timestamp: "2026-10-01T22:00:00Z",
    cwd: "/workspace",
  };
  const entry = (id: string, parentId: string | null, role = "user") => ({
    type: "message",
    id,
    parentId,
    timestamp: "2026-10-01T22:00:00Z",
    message: { role, content: id },
  });
  const restore = (part: number, final: boolean, entries: unknown[], extra = {}) => ({
    type: "session.restore",
    thread_id: THREAD,
    part,
    final,
    entries,
    ...extra,
  });

  it("gates the Pi started after a restore on kobe-policy being ready", async () => {
    h = await startHarness({
      env: { KOBE_POLICY_EXTENSION: "/opt/kobe/pi-extensions/refuse/index.js" },
    });
    // The restore itself only writes the session file (no Pi) ...
    expect(await h.server.command(restore(0, true, [entry("a1", null)], { header }))).toMatchObject(
      { ok: true },
    );
    // ... and the Pi that reads it is refused when its kobe-policy does not start.
    const result = await h.server.command({
      type: "pi.command",
      thread_id: THREAD,
      command: { id: "srv", type: "get_entries" },
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "pi_unavailable", message: expect.stringMatching(/kobe-policy/) },
    });
    expect((await h.commandsLog()).filter((c) => c.type === "get_entries")).toEqual([]);
  });

  it("rebuilds the session file from parts and Pi reads it", async () => {
    h = await startHarness();
    expect(
      await h.server.command(restore(0, false, [entry("a1", null)], { header })),
    ).toMatchObject({ ok: true, data: { part: 0, entries: 1 } });
    expect(
      await h.server.command(restore(1, true, [entry("b1", "a1", "assistant")])),
    ).toMatchObject({ ok: true, data: { restored: true, entries: 2 } });
    const text = await readFile(path.join(h.sessions, `${THREAD}.jsonl`), "utf8");
    expect(text.trim().split("\n")).toHaveLength(3);
    // The stored cwd is rewritten to this sandbox's workspace (Pi refuses a missing cwd).
    expect(JSON.parse(text.split("\n")[0] ?? "")).toMatchObject({ id: THREAD, cwd: h.workspace });
    const entries = await h.server.command({
      type: "pi.command",
      thread_id: THREAD,
      command: { id: "x", type: "get_entries" },
    });
    expect(entries).toMatchObject({ ok: true, data: { leafId: "b1" } });
  });

  it("refuses out-of-order parts and restores while a run is active", async () => {
    h = await startHarness();
    expect(await h.server.command(restore(1, true, []))).toMatchObject({ ok: false });
    await h.server.command(runStart("hang"));
    expect(await h.server.command(restore(0, true, [], { header }))).toMatchObject({
      ok: false,
      error: { code: "pi_rejected" },
    });
  });

  it("voids a partial restore when the connection drops", async () => {
    h = await startHarness();
    await h.server.command(restore(0, false, [entry("a1", null)], { header }));
    h.server.terminate();
    await h.server.waitForOn(2, (f) => f.type === "hello");
    // The partial temp file disappears once the restore has been voided.
    await until(async () => (await readdir(h.sessions)).every((f) => !f.endsWith(".tmp")));
    // Not "restore in progress": the thread is usable, and part 1 has no part 0 any more.
    expect(await h.server.command(restore(1, true, []))).toMatchObject({ ok: false });
    expect(await h.server.command(runStart("say:x"))).toMatchObject({ ok: true });
  });

  it("branches in place for edit-and-regenerate (parent_entry_id)", async () => {
    h = await startHarness();
    await h.server.command(
      restore(0, true, [entry("a1", null), entry("b1", "a1", "assistant"), entry("c1", "b1")], {
        header,
      }),
    );
    const result = await h.server.command(runStart("say:edited", { parent_entry_id: "b1" }));
    expect(result).toMatchObject({ ok: true });
    await h.server.waitFor(settled());
    const lines = (await readFile(path.join(h.sessions, `${THREAD}.jsonl`), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.find((l) => l.type === "custom")).toMatchObject({
      type: "custom",
      parentId: "b1",
      customType: "kobe.branch",
      data: { run_id: RUN },
    });
    expect(
      await h.server.command({ ...runStart("say:x", { parent_entry_id: "zz" }), run_id: RUN_2 }),
    ).toMatchObject({ ok: false, error: { code: "pi_rejected" } });
  });

  it("catches Pi's session up with the run's app cards, then branches below them (KOBE-440)", async () => {
    h = await startHarness();
    expect(h.server.frames("hello")[0]?.capabilities).toContain(CAPABILITY_APP_CARDS);
    await h.server.command(
      restore(0, true, [entry("a1", null), entry("b1", "a1", "assistant")], { header }),
    );
    const first = card("11111111-1111-4111-8111-111111111111", "b1");
    const second = card("22222222-2222-4222-8222-222222222222", first.id);
    const start = runStart("say:ok", { parent_entry_id: second.id, app_cards: [first, second] });
    expect(await h.server.command(start)).toMatchObject({ ok: true });
    await h.server.waitFor(settled());
    const lines = (await readFile(path.join(h.sessions, `${THREAD}.jsonl`), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.filter((l) => l.customType === APP_CARD_CUSTOM_TYPE)).toEqual([first, second]);
    expect(lines.find((l) => l.type === "custom")).toMatchObject({
      parentId: second.id,
      customType: "kobe.branch",
    });
    // A card whose parent the session lacks fails the start; nothing is appended.
    const orphan = card("33333333-3333-4333-8333-333333333333", "zz");
    expect(
      await h.server.command({
        ...runStart("say:x", { parent_entry_id: orphan.id, app_cards: [orphan] }),
        run_id: RUN_2,
      }),
    ).toMatchObject({ ok: false, error: { code: "pi_rejected" } });
  });

  it("starts a new thread's session from its first app card (KOBE-440)", async () => {
    h = await startHarness();
    const only = card("11111111-1111-4111-8111-111111111111", null);
    const start = runStart("say:ok", { parent_entry_id: only.id, app_cards: [only] });
    const answer = await h.server.command(start);
    expect(answer, JSON.stringify(answer)).toMatchObject({ ok: true });
    await h.server.waitFor(settled());
    const lines = (await readFile(path.join(h.sessions, `${THREAD}.jsonl`), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ type: "session", id: THREAD });
    expect(lines[1]).toEqual(only);
  });
});
