import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SANDBOX_CLOSE_CODES } from "@kobe/protocol/sandbox-wire";
import { FakeSandbox, isFake } from "../testing/fake-sandbox.js";
import {
  fx,
  auth,
  ended,
  woken,
  sandboxes,
  url,
  world,
  newRun,
  connect,
  started,
  events,
  runRow,
  delta,
  assistantStart,
  assistantEnd,
  settled,
  auditActions,
  useSandboxWireWorld,
} from "./sandbox-wire.test-helpers.js";

useSandboxWireWorld();

describe("upgrade authentication", () => {
  it("refuses missing, invalid and dead credentials, and the wrong path or subprotocol", async () => {
    const w = await world();
    const status = async (p: Promise<FakeSandbox | { status: number }>) => {
      const r = await p;
      if (isFake(r)) {
        r.close();
        return 101;
      }
      return r.status;
    };
    expect(await status(FakeSandbox.connect(url(0), undefined))).toBe(401);
    expect(await status(FakeSandbox.connect(url(0), "tok-forged"))).toBe(401);
    expect(await status(FakeSandbox.connect(url(0), w.token, { protocol: "other" }))).toBe(400);
    expect(await status(FakeSandbox.connect(url(0).replace("/connect", "/nope"), w.token))).toBe(
      404,
    );
    expect(
      await status(
        FakeSandbox.connect(url(0), w.token, { headers: { "x-forwarded-for": "1.2.3.4" } }),
      ),
    ).toBe(404);
    auth.dead.add(w.sandboxId);
    expect(await status(FakeSandbox.connect(url(0), w.token))).toBe(401);
    auth.dead.delete(w.sandboxId);
    // Not a member of the team the token names.
    const stranger = await fx.person("stranger");
    const foreign = auth.issue({ sandboxId: randomUUID(), teamId: w.team, userId: stranger.id });
    expect(await status(FakeSandbox.connect(url(0), foreign))).toBe(401);
    expect(await status(FakeSandbox.connect(url(0), w.token))).toBe(101);
    // Signed tokens refused after verification are audited (forged ones carry no team).
    await settled();
    expect((await auditActions(w.team)).filter((x) => x === "sandbox.token_rejected")).toHaveLength(
      2,
    );
  });

  it("closes on a hello for another sandbox, an unsupported Pi, a frame before hello, or no hello", async () => {
    const w = await world();
    const open = async () => {
      const sb = await FakeSandbox.connect(url(0), w.token);
      if (!isFake(sb)) throw new Error("refused");
      sandboxes.push(sb);
      return sb;
    };
    const a = await open();
    a.hello(randomUUID());
    expect((await a.waitClosed()).code).toBe(SANDBOX_CLOSE_CODES.unauthorized);
    await settled();
    expect(await auditActions(w.team)).toContain("sandbox.token_rejected");
    const b = await open();
    b.hello(w.sandboxId, [], "2.0.0");
    expect((await b.waitClosed()).code).toBe(SANDBOX_CLOSE_CODES.unsupported_version);
    const c = await open();
    c.event(w.runId, w.threadId, 1, { type: "agent_start" });
    expect((await c.waitClosed()).code).toBe(SANDBOX_CLOSE_CODES.protocol_error);
    const d = await open();
    expect((await d.waitClosed(5_000)).code).toBe(SANDBOX_CLOSE_CODES.hello_timeout);
  });
});

describe("routing across replicas", () => {
  it("delivers run.start from replica 1 to the sandbox held by replica 0 and returns its result", async () => {
    const w = await world();
    const sb = await started(w, 0, 1);
    const [getEntries] = sb.frames("pi.command");
    expect(getEntries?.command.type).toBe("get_entries"); // session checked before the first run
    expect(sb.frames("run.start")[0]).toMatchObject({
      run_id: w.runId,
      thread_id: w.threadId,
      message: "hello",
    });
    const { rows } = await fx.admin.query(
      `SELECT sandbox_id FROM sandbox_run_leases WHERE team_id = $1 AND run_id = $2`,
      [w.team, w.runId],
    );
    expect(rows).toEqual([{ sandbox_id: w.sandboxId }]);
    // Content-bearing rows are deleted once the requester has its result.
    const left = await fx.admin.query(`SELECT 1 FROM sandbox_commands WHERE team_id = $1`, [
      w.team,
    ]);
    expect(left.rowCount).toBe(0);
    expect(await fx.replica(1).deps.sandboxWire.router.isConnected(w.target)).toBe(true);
  });

  it("routes pi.command and steer, and fails steer for a run not on the sandbox", async () => {
    const w = await world();
    const sb = await started(w);
    const router = fx.replica(1).deps.sandboxWire.router;
    sb.respond = (f) =>
      f.type === "pi.command" && f.command.type === "get_state"
        ? { v: 1, type: "command.result", command_id: f.command_id, ok: true, data: { model: "m" } }
        : undefined;
    expect(
      await router.piCommand(w.target, {
        threadId: w.threadId,
        command: { id: "x", type: "get_state" },
      }),
    ).toEqual({ ok: true, data: { model: "m" } });
    expect(
      await router.steerRun(w.target, { runId: w.runId, threadId: w.threadId, message: "also" }),
    ).toEqual({ ok: true });
    const other = await newRun(w);
    const steer = await router.steerRun(w.target, { ...other, message: "x" });
    expect(steer).toMatchObject({ ok: false, error: { code: "run_not_active" } });
  });

  it("queues commands for a disconnected sandbox, wakes it, and delivers on connect", async () => {
    const w = await world();
    const pending = fx.replica(1).deps.sandboxWire.router.startRun(w.target, {
      runId: w.runId,
      threadId: w.threadId,
      message: "later",
    });
    await expect.poll(() => woken).toContain(w.owner.id);
    const sb = await connect(0, w);
    expect(await pending).toEqual({ ok: true });
    expect(sb.frames("run.start")).toHaveLength(1);
  });

  it("times out when no sandbox answers", async () => {
    const w = await world();
    const result = await fx
      .replica(0)
      .deps.sandboxWire.router.steerRun(
        w.target,
        { runId: w.runId, threadId: w.threadId, message: "x" },
        { timeoutMs: 300 },
      );
    expect(result).toMatchObject({ ok: false, error: { code: "timeout" } });
  });

  it("never routes into another user's thread", async () => {
    const w = await world();
    const mallory = await fx.person("mallory");
    await fx.addMember(w.team, mallory);
    const result = await fx
      .replica(0)
      .deps.sandboxWire.router.startRun(
        { teamId: w.team, userId: mallory.id },
        { runId: w.runId, threadId: w.threadId, message: "x" },
      );
    expect(result).toMatchObject({ ok: false, error: { code: "thread_not_found" } });
  });

  it("a run.start the sandbox rejects fails the run", async () => {
    const w = await world();
    const sb = await connect(0, w);
    sb.respond = (f) =>
      f.type === "run.start"
        ? {
            v: 1,
            type: "command.result",
            command_id: f.command_id,
            ok: false,
            error: { code: "pi_rejected", message: "no model" },
          }
        : undefined;
    const r = await fx.replica(1).deps.sandboxWire.router.startRun(w.target, {
      runId: w.runId,
      threadId: w.threadId,
      message: "x",
    });
    expect(r).toMatchObject({ ok: false, error: { code: "pi_rejected" } });
    await expect.poll(async () => (await runRow(w.team, w.runId)).status).toBe("failed");
    expect((await events(w.team, w.runId)).at(-1)?.type).toBe("run.failed");
  });
});

describe("event ingest and the durable cursor", () => {
  it("fails the run with the server's message when the last model call failed (KOBE-41)", async () => {
    const w = await world();
    const sb = await started(w);
    sb.session = [];
    const frames = [
      { type: "agent_start" },
      assistantStart,
      {
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "kobe.model_error:model_not_enabled: model_not_enabled after 1 attempt",
        },
      },
      { type: "turn_end", message: { role: "assistant" } },
      { type: "agent_settled" },
    ];
    frames.forEach((e, i) => sb.event(w.runId, w.threadId, i + 1, e));
    await sb.until(() => sb.acked(w.runId) >= frames.length);
    const evs = await events(w.team, w.runId);
    expect(evs.map((e) => e.type)).toEqual(["run.failed"]);
    expect(evs[0]?.payload).toEqual({
      error: {
        code: "model_not_enabled",
        message:
          "That model is not enabled for your team. Ask a team admin to enable it, or use the team's default model.",
      },
    });
    expect((await runRow(w.team, w.runId)).status).toBe("failed");

    // Any other error text: a generic model error, the sandbox's words never stored.
    const second = await newRun(w);
    const sb2 = await connect(0, w);
    expect(
      await fx.replica(1).deps.sandboxWire.router.startRun(w.target, {
        runId: second.runId,
        threadId: second.threadId,
        message: "again",
      }),
    ).toEqual({ ok: true });
    const bad = [
      { type: "agent_start" },
      {
        type: "message_end",
        message: { role: "assistant", stopReason: "error", errorMessage: "<b>evil</b>" },
      },
      { type: "agent_settled" },
    ];
    bad.forEach((e, i) => sb2.event(second.runId, second.threadId, i + 1, e));
    await sb2.until(() => sb2.acked(second.runId) >= bad.length);
    const failed = (await events(w.team, second.runId)).at(-1);
    expect(failed?.type).toBe("run.failed");
    expect(JSON.stringify(failed?.payload)).not.toContain("evil");
    expect(failed?.payload).toMatchObject({ error: { code: "model_error" } });
  });

  it("translates, batches, mirrors entries and completes the run, acking after commit", async () => {
    const w = await world();
    const sb = await started(w);
    const t = new Date().toISOString();
    sb.session = [
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: t,
        message: { role: "user", content: "hello" },
      },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: t,
        message: { role: "assistant", content: [{ type: "text", text: "abc" }] },
      },
    ];
    const frames = [
      { type: "agent_start" },
      assistantStart,
      delta("a"),
      delta("b"),
      delta("c"),
      assistantEnd,
      { type: "turn_end", message: { role: "assistant" } },
      { type: "agent_settled" },
    ];
    frames.forEach((e, i) => sb.event(w.runId, w.threadId, i + 1, e));
    await sb.until(() => sb.acked(w.runId) >= frames.length);
    const evs = await events(w.team, w.runId);
    expect(evs.map((e) => e.type)).toEqual([
      "text.delta",
      "entry.committed",
      "entry.committed",
      "thread.updated",
      "run.completed",
    ]);
    expect(evs[0]?.payload).toEqual({ message_id: "m2", content_index: 0, delta: "abc" });
    expect(evs[2]?.payload).toMatchObject({ entry_id: "a1", message_id: "m2" });
    // The commit moved the leaf (CT13, KOBE-543): every open stream of the run hears it.
    expect(evs[3]?.payload).toEqual({ thread_id: w.threadId, leaf_entry_id: "a1" });
    expect(evs[4]?.payload).toEqual({ leaf_entry_id: "a1" });
    expect(await runRow(w.team, w.runId)).toEqual({ status: "completed", sandbox_seq: 8 });
    const { rows } = await fx.admin.query<{ entry_id: string }>(
      `SELECT entry_id FROM thread_entries WHERE team_id = $1 AND thread_id = $2 ORDER BY seq`,
      [w.team, w.threadId],
    );
    expect(rows.map((r) => r.entry_id)).toEqual(["u1", "a1"]);
    await expect
      .poll(() => ended.some((e) => e.runId === w.runId && e.status === "completed"))
      .toBe(true);
  });

  it("drops duplicates (acked) and answers gaps with resend from the durable cursor", async () => {
    const w = await world();
    const sb = await started(w);
    sb.event(w.runId, w.threadId, 1, assistantStart);
    sb.event(w.runId, w.threadId, 2, delta("x"));
    await sb.until(() => sb.acked(w.runId) >= 2);
    sb.event(w.runId, w.threadId, 2, delta("x")); // duplicate
    sb.event(w.runId, w.threadId, 5, delta("z")); // gap: 3, 4 missing
    const resend = await sb.until(() => sb.frames("resend").find((r) => r.run_id === w.runId));
    expect(resend.from_seq).toBe(3);
    sb.event(w.runId, w.threadId, 3, delta("y"));
    sb.event(w.runId, w.threadId, 4, {
      type: "kobe.event_dropped",
      original_type: "x",
      reason: "too_large",
    });
    sb.event(w.runId, w.threadId, 5, delta("z"));
    await sb.until(() => sb.acked(w.runId) >= 5);
    const deltas = (await events(w.team, w.runId)).map(
      (e) => (e.payload as { delta?: string }).delta,
    );
    expect(deltas.join("")).toBe("xyz");
    expect((await runRow(w.team, w.runId)).sandbox_seq).toBe(5);
  });

  it("resumes after a reconnect to the other replica: durable_seq, re-sent duplicates, no loss", async () => {
    const w = await world();
    const first = await started(w, 0, 1);
    first.event(w.runId, w.threadId, 1, assistantStart);
    first.event(w.runId, w.threadId, 2, delta("one "));
    first.event(w.runId, w.threadId, 3, delta("two "));
    await first.until(() => first.acked(w.runId) >= 3);
    first.close();
    // The sandbox comes back on replica 1 having sent up to 5 (4 and 5 never arrived).
    const second = await connect(1, w, [{ run_id: w.runId, thread_id: w.threadId, last_seq: 5 }]);
    const ack = second.frames("hello.ack")[0];
    expect(ack?.runs).toEqual([{ run_id: w.runId, thread_id: w.threadId, durable_seq: 3 }]);
    second.event(w.runId, w.threadId, 3, delta("two ")); // agent re-sends a bit too much
    second.event(w.runId, w.threadId, 4, delta("three "));
    second.event(w.runId, w.threadId, 5, delta("four"));
    await second.until(() => second.acked(w.runId) >= 5);
    const text = (await events(w.team, w.runId))
      .map((e) => (e.payload as { delta?: string }).delta ?? "")
      .join("");
    expect(text).toBe("one two three four");
    // Steer from replica 0 now reaches the sandbox through replica 1.
    expect(
      await fx.replica(0).deps.sandboxWire.router.steerRun(w.target, {
        runId: w.runId,
        threadId: w.threadId,
        message: "more",
      }),
    ).toEqual({ ok: true });
  });

  it("closes the older connection with `replaced` when the sandbox connects again", async () => {
    const w = await world();
    const a = await connect(0, w);
    const b = await connect(1, w);
    expect((await a.waitClosed()).code).toBe(SANDBOX_CLOSE_CODES.replaced);
    expect(b.closed).toBeUndefined();
  });
});
