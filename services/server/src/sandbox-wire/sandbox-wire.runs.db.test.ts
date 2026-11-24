import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SANDBOX_CLOSE_CODES, SANDBOX_MAX_FRAME_BYTES } from "@kaiju/protocol/sandbox-wire";
import { sql, withTeam } from "@kaiju/db";
import { FakeSandbox, isFake } from "../testing/fake-sandbox.js";
import {
  fx,
  auth,
  sandboxes,
  url,
  type World,
  world,
  newRun,
  connect,
  started,
  events,
  runRow,
  delta,
  assistantStart,
  settled,
  auditActions,
  sleep,
  useSandboxWireWorld,
} from "./sandbox-wire.test-helpers.js";

useSandboxWireWorld();

describe("interrupted runs (D14)", () => {
  it("interrupts runs the reconnected sandbox no longer lists", async () => {
    const w = await world();
    const first = await started(w);
    first.close();
    await connect(1, w, []); // Pi restarted: the run is gone
    await expect.poll(async () => (await runRow(w.team, w.runId)).status).toBe("interrupted");
    const last = (await events(w.team, w.runId)).at(-1);
    expect(last).toMatchObject({
      type: "run.interrupted",
      payload: { reason: "sandbox_lost", retryable: true },
    });
    const { rows } = await fx.admin.query<{ status: string }>(
      `SELECT status FROM threads WHERE team_id = $1 AND id = $2`,
      [w.team, w.threadId],
    );
    expect(rows[0]?.status).toBe("interrupted");
    expect(await auditActions(w.team)).toContain("run.interrupted");
  });

  it("the sweep interrupts runs whose sandbox stays gone past the grace period", async () => {
    const w = await world();
    const sb = await started(w);
    sb.close();
    await expect
      .poll(async () => {
        const { rows } = await fx.admin.query(
          `SELECT 1 FROM sandbox_connections WHERE team_id = $1 AND closed_at IS NOT NULL`,
          [w.team],
        );
        return rows.length;
      })
      .toBe(1);
    const result = await fx.replica(1).deps.sandboxWire.sweep();
    expect(result.interrupted.map((r) => r.runId)).toContain(w.runId);
    expect((await runRow(w.team, w.runId)).status).toBe("interrupted");
  });

  it("the sweep keeps a run whose sandbox reconnected and resumed it", async () => {
    const w = await world();
    const first = await started(w);
    first.close();
    await connect(1, w, [{ run_id: w.runId, thread_id: w.threadId, last_seq: 0 }]);
    const result = await fx.replica(0).deps.sandboxWire.sweep();
    expect(result.interrupted.map((r) => r.runId)).not.toContain(w.runId);
    expect((await runRow(w.team, w.runId)).status).toBe("running");
  });

  it("pi.exited interrupts the thread's active run", async () => {
    const w = await world();
    const sb = await started(w);
    sb.send({
      v: 1,
      type: "pi.exited",
      thread_id: w.threadId,
      exit_code: 1,
      signal: null,
      stderr_tail: "",
    });
    await expect.poll(async () => (await runRow(w.team, w.runId)).status).toBe("interrupted");
  });
});

describe("late frames for ended runs", () => {
  it("answers run_not_active (acked, not executed) and denies a late policy.check", async () => {
    const w = await world();
    const sb = await started(w);
    sb.event(w.runId, w.threadId, 1, assistantStart);
    await sb.until(() => sb.acked(w.runId) >= 1);
    // Stop, the way the orchestrator ends a run: status and terminal event together.
    await withTeam(fx.db, w.team, async (tx) => {
      await tx.execute(
        sql`UPDATE runs SET status = 'cancelled', ended_at = now() WHERE id = ${w.runId}`,
      );
      await tx.execute(
        sql`INSERT INTO run_events (team_id, run_id, type, payload) VALUES (${w.team}, ${w.runId}, 'run.interrupted', ${JSON.stringify({ reason: "cancelled", last_entry_id: null, retryable: false })}::jsonb)`,
      );
    });
    const before = (await events(w.team, w.runId)).length;
    sb.event(w.runId, w.threadId, 2, delta("late"));
    await sb.until(() => sb.frames("error").find((e) => e.code === "run_not_active"));
    await sb.until(() => sb.acked(w.runId) >= 2);
    expect((await events(w.team, w.runId)).length).toBe(before);
    sb.send({
      v: 1,
      type: "policy.check",
      request_id: "r1",
      run_id: w.runId,
      thread_id: w.threadId,
      tool_call_id: "c1",
      tool: "read",
      input: { path: "/workspace/a" },
    });
    const result = await sb.until(() =>
      sb.frames("policy.result").find((r) => r.request_id === "r1"),
    );
    expect(result.decision).toBe("deny");
    expect(result.reasons.map((r) => r.code)).toEqual(["run_not_active"]);
    expect(sb.closed).toBeUndefined();
  });
});

describe("late frames after Stop or a reconnect (KOBE-483)", () => {
  const uiRequest = (runId: string, threadId: string, id: string) => ({
    v: 1 as const,
    type: "pi.ui_request" as const,
    thread_id: threadId,
    run_id: runId,
    request: { type: "extension_ui_request" as const, id, method: "setStatus" as const },
  });

  it("drops a late pi.ui_request of a run this connection held after Stop; the connection stays", async () => {
    const w = await world();
    const sb = await started(w);
    sb.event(w.runId, w.threadId, 1, assistantStart);
    await sb.until(() => sb.acked(w.runId) >= 1);
    await withTeam(fx.db, w.team, async (tx) => {
      await tx.execute(
        sql`UPDATE runs SET status = 'cancelled', ended_at = now() WHERE id = ${w.runId}`,
      );
      await tx.execute(
        sql`INSERT INTO run_events (team_id, run_id, type, payload) VALUES (${w.team}, ${w.runId}, 'run.interrupted', ${JSON.stringify({ reason: "cancelled", last_entry_id: null, retryable: false })}::jsonb)`,
      );
    });
    // The late frame is only meaningful once the server has ended the lease (an ack of a late event).
    sb.event(w.runId, w.threadId, 2, delta("late"));
    await sb.until(() => sb.frames("error").find((e) => e.code === "run_not_active"));
    sb.send(uiRequest(w.runId, w.threadId, "ui-late"));
    await sb.until(() => sb.frames("error").filter((e) => e.code === "run_not_active").length >= 2);
    await sleep(100);
    expect(sb.closed).toBeUndefined();
    expect(sb.frames("pi.ui_response")).toEqual([]);
  });

  it("drops a pi.ui_request of a run the reconnect just interrupted, and still closes for others", async () => {
    const w = await world();
    const first = await started(w);
    first.close();
    // The agent reconnects without offering the run (it stopped it locally): interrupted on hello.
    const sb = await connect(1, w, []);
    await expect.poll(async () => (await runRow(w.team, w.runId)).status).toBe("interrupted");
    sb.send(uiRequest(w.runId, w.threadId, "ui-after-reconnect"));
    await sb.until(() => sb.frames("error").find((e) => e.code === "run_not_active"));
    await sleep(100);
    expect(sb.closed).toBeUndefined();
    // The grace covers only that run on that thread: anything else is still a lease violation.
    const other = await newRun(w);
    sb.send(uiRequest(other.runId, other.threadId, "ui-forged"));
    expect((await sb.waitClosed()).code).toBe(SANDBOX_CLOSE_CODES.lease_violation);
  });

  it("closes when a reconnect-interrupted run is named with another thread", async () => {
    const w = await world();
    const first = await started(w);
    first.close();
    const sb = await connect(1, w, []);
    await expect.poll(async () => (await runRow(w.team, w.runId)).status).toBe("interrupted");
    sb.send(uiRequest(w.runId, randomUUID(), "ui-wrong-thread"));
    expect((await sb.waitClosed()).code).toBe(SANDBOX_CLOSE_CODES.lease_violation);
  });
});

describe("leasing and the compromised-sandbox suite", () => {
  it("closes with lease_violation for a run of another sandbox (forged run id) and audits it", async () => {
    const w = await world();
    const other = await newRun(w); // same team and user, but never started on this connection
    const sb = await connect(0, w);
    sb.event(other.runId, other.threadId, 1, { type: "agent_start" });
    expect((await sb.waitClosed()).code).toBe(SANDBOX_CLOSE_CODES.lease_violation);
    expect(sb.frames("error").map((e) => e.code)).toContain("unknown_run");
    await settled();
    expect(await auditActions(w.team)).toContain("sandbox.lease_violation");
    expect((await events(w.team, other.runId)).length).toBe(0);
  });

  it("closes for a random run id, a thread mismatch and an unknown command id", async () => {
    const w = await world();
    const a = await connect(0, w);
    a.send({
      v: 1,
      type: "policy.check",
      request_id: "r",
      run_id: randomUUID(),
      thread_id: randomUUID(),
      tool_call_id: "c",
      tool: "read",
      input: {},
    });
    expect((await a.waitClosed()).code).toBe(SANDBOX_CLOSE_CODES.lease_violation);
    const b = await started(w);
    b.event(w.runId, randomUUID(), 1, { type: "agent_start" });
    expect((await b.waitClosed()).code).toBe(SANDBOX_CLOSE_CODES.lease_violation);
    expect(b.frames("error").map((e) => e.code)).toContain("unknown_thread");
    const c = await connect(1, w, [{ run_id: w.runId, thread_id: w.threadId, last_seq: 0 }]);
    c.result("never-issued", true);
    expect((await c.waitClosed()).code).toBe(SANDBOX_CLOSE_CODES.lease_violation);
  });

  it("cannot reach another team's runs (cross-team isolation)", async () => {
    const w1 = await world();
    const w2 = await world();
    // w1's sandbox names w2's run: never leased → violation; nothing written in team 2.
    const sb = await connect(0, w1);
    sb.event(w2.runId, w2.threadId, 1, delta("x"));
    expect((await sb.waitClosed()).code).toBe(SANDBOX_CLOSE_CODES.lease_violation);
    expect((await events(w2.team, w2.runId)).length).toBe(0);
    // A token for team 1 + a team-2 run id in hello.runs is not listed (and not interrupted).
    const again = await connect(1, w1, [{ run_id: w2.runId, thread_id: w2.threadId, last_seq: 3 }]);
    expect(again.frames("hello.ack")[0]?.runs).toEqual([]);
    expect((await runRow(w2.team, w2.runId)).status).toBe("running");
    // Routing with team 1's id cannot address team 2's thread.
    const r = await fx.replica(0).deps.sandboxWire.router.startRun(w1.target, {
      runId: w2.runId,
      threadId: w2.threadId,
      message: "x",
    });
    expect(r).toMatchObject({ ok: false, error: { code: "thread_not_found" } });
  });

  it("answers hostile frames with malformed_frame and keeps the connection", async () => {
    const w = await world();
    const sb = await connect(0, w);
    sb.sendRaw('{"v":1,"type":"ping","nonce":"a","nonce":"b"}'); // duplicate keys
    sb.sendRaw('{"v":1,"type":"ping","nonce":"a","__proto__":{"x":1}}');
    sb.sendRaw(`${"[".repeat(200)}${"]".repeat(200)}`); // deep nesting
    sb.sendRaw("not json");
    sb.sendRaw('{"v":1,"type":"pi.event","run_id":"x"}');
    sb.socket.send(Buffer.from([1, 2, 3]), { binary: true });
    await sb.until(() => sb.frames("error").length >= 6);
    expect(new Set(sb.frames("error").map((e) => e.code))).toEqual(new Set(["malformed_frame"]));
    sb.send({ v: 1, type: "ping", nonce: "still-there" });
    await sb.until(() => sb.frames("pong").find((p) => p.nonce === "still-there"));
  });

  it("refuses oversized frames at the WebSocket layer", async () => {
    const w = await world();
    const sb = await connect(0, w);
    sb.sendRaw(`{"v":1,"type":"ping","nonce":"${"x".repeat(SANDBOX_MAX_FRAME_BYTES)}"}`);
    expect((await sb.waitClosed()).code).toBe(1009);
  });

  it("caps frame size by type before decoding: small types at 256 KiB, pi.event at 4 MiB", async () => {
    const w = await world();
    const sb = await connect(0, w);
    // A large frame whose type may be large is decoded (and here rejected as malformed).
    sb.sendRaw(`{"v":1,"type":"pi.event","junk":"${"x".repeat(300 * 1024)}"}`);
    await sb.until(() => sb.frames("error").find((e) => e.code === "malformed_frame"));
    expect(sb.closed).toBeUndefined();
    // The same size as a ping (or with an unreadable type) is refused unparsed.
    sb.sendRaw(`{"v":1,"type":"ping","nonce":"${"x".repeat(300 * 1024)}"}`);
    expect((await sb.waitClosed()).code).toBe(SANDBOX_CLOSE_CODES.protocol_error);
    await settled();
    expect(await auditActions(w.team)).toContain("sandbox.limit_exceeded");
  });

  it("closes a flooding sandbox", async () => {
    const w = await world();
    const sb = await connect(0, w);
    for (let i = 0; i < 1_000; i += 1) sb.send({ v: 1, type: "ping", nonce: `n${i}` });
    expect((await sb.waitClosed()).code).toBe(SANDBOX_CLOSE_CODES.protocol_error);
  });

  it("keeps exactly one connection when the same sandbox connects twice at once", async () => {
    const w = await world();
    const open = async (replica: number) => {
      const sb = await FakeSandbox.connect(url(replica), w.token);
      if (!isFake(sb)) throw new Error("refused");
      sandboxes.push(sb);
      return sb;
    };
    const [a, b, c] = await Promise.all([open(0), open(0), open(1)]);
    for (const sb of [a, b, c]) sb.hello(w.sandboxId);
    await expect
      .poll(
        () =>
          [a, b, c].filter((sb) => sb.closed === undefined && sb.frames("hello.ack").length > 0)
            .length,
        {
          timeout: 5_000,
        },
      )
      .toBe(1);
    await sleep(300);
    const alive = [a, b, c].filter((sb) => sb.closed === undefined);
    expect(alive).toHaveLength(1);
    const { rows } = await fx.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM sandbox_connections WHERE team_id = $1 AND closed_at IS NULL`,
      [w.team],
    );
    expect(rows[0]?.n).toBe(1);
  });

  it("closes every connection of a deactivated user on every replica", async () => {
    const w = await world();
    const sb = await connect(1, w);
    await fx.admin.query(`UPDATE users SET deactivated_at = now() WHERE id = $1`, [w.owner.id]);
    await fx.replica(0).deps.lifecycle.emit("deactivated", w.owner.id);
    expect((await sb.waitClosed()).code).toBe(SANDBOX_CLOSE_CODES.unauthorized);
  });

  it("closes a removed member's connection in that team on every replica", async () => {
    const w = await world();
    const member = await fx.person("leaver");
    await fx.addMember(w.team, member);
    const sandboxId = randomUUID();
    const token = auth.issue({ sandboxId, teamId: w.team, userId: member.id });
    const sb = await FakeSandbox.connect(url(1), token);
    if (!isFake(sb)) throw new Error("refused");
    sandboxes.push(sb);
    sb.hello(sandboxId);
    await sb.ready();
    await fx.activate(w.owner, w.team);
    const res = await fx.replica(0).app.request(`http://kaiju.test/v1/team/members/${member.id}`, {
      method: "DELETE",
      headers: {
        cookie: [...w.owner.browser.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        origin: "http://kaiju.test",
        "x-kobe-team": w.team,
        "x-forwarded-for": w.owner.browser.ip,
      },
    });
    expect(res.status).toBe(204);
    expect((await sb.waitClosed()).code).toBe(SANDBOX_CLOSE_CODES.unauthorized);
  });
});

describe("policy.check", () => {
  const check = (w: World, requestId: string, tool: string, input: Record<string, unknown>) => ({
    v: 1,
    type: "policy.check",
    request_id: requestId,
    run_id: w.runId,
    thread_id: w.threadId,
    tool_call_id: `call-${requestId}`,
    tool,
    input,
  });

  it("allows a read, denies an unknown tool (with policy.denied), and denies approvals by default", async () => {
    const w = await world();
    const sb = await started(w);
    sb.send(check(w, "a", "read", { path: "notes.md" }));
    sb.send(check(w, "b", "rm_everything", {}));
    sb.send(check(w, "c", "share_file", { path: "/workspace/x.md" }));
    const res = (id: string) =>
      sb.until(() => sb.frames("policy.result").find((r) => r.request_id === id));
    expect((await res("a")).decision).toBe("allow");
    const unknown = await res("b");
    expect(unknown).toMatchObject({ decision: "deny", reasons: [{ code: "unknown_tool" }] });
    const approval = await res("c");
    expect(approval.decision).toBe("deny");
    expect(approval.decision === "deny" && approval.message).toMatch(/approval/);
    await expect
      .poll(
        async () =>
          (await events(w.team, w.runId)).filter((e) => e.type === "policy.denied").length,
      )
      .toBe(2);
  });

  it("answers a request id once, even when the sandbox replays it", async () => {
    const w = await world();
    const sb = await started(w);
    sb.send(check(w, "dup", "read", { path: "a" }));
    await sb.until(() => sb.frames("policy.result").find((r) => r.request_id === "dup"));
    sb.send(check(w, "dup", "read", { path: "a" }));
    sb.send(check(w, "after", "read", { path: "b" }));
    await sb.until(() => sb.frames("policy.result").find((r) => r.request_id === "after"));
    expect(sb.frames("policy.result").filter((r) => r.request_id === "dup")).toHaveLength(1);
  });

  it("applies the site approval floor (no team floor, D6) and fails closed on an invalid one", async () => {
    const w = await world();
    const sb = await started(w);
    const decide = async (id: string) => {
      sb.send(check(w, id, "read", { path: "x" }));
      return sb.until(() => sb.frames("policy.result").find((r) => r.request_id === id));
    };
    expect((await decide("f0")).decision).toBe("allow");
    // Teams have no approval floor (spec D6): a leftover team setting changes nothing.
    await fx.admin.query(
      `UPDATE teams SET settings = settings || '{"approval_mode_floor":"ask-all"}' WHERE id = $1`,
      [w.team],
    );
    expect((await decide("f1")).decision).toBe("allow");
    await fx.admin.query(`UPDATE teams SET settings = '{}' WHERE id = $1`, [w.team]);
    const setFloor = (value: string) =>
      fx.admin.query(
        `INSERT INTO site_settings (key, value) VALUES ('policy.approval_floor', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [value],
      );
    try {
      // Site floor ask-all: even a read needs approval (denied by the default broker).
      await setFloor("ask-all");
      const site = await decide("f2");
      expect(site.decision === "deny" && site.message).toMatch(/approval/);
      // An unreadable floor is the strictest mode: fail closed.
      await setFloor("yolo");
      expect((await decide("f3")).decision).toBe("deny");
    } finally {
      await fx.admin.query(`DELETE FROM site_settings WHERE key = 'policy.approval_floor'`);
    }
    expect((await decide("f4")).decision).toBe("allow");
  });

  it("denies when the user is no longer a team member", async () => {
    const w = await world();
    const sb = await started(w);
    await fx.admin.query(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [
      w.team,
      w.owner.id,
    ]);
    sb.send(check(w, "m", "read", { path: "a" }));
    const r = await sb.until(() => sb.frames("policy.result").find((x) => x.request_id === "m"));
    expect(r.decision).toBe("deny");
    expect(r.reasons.map((x) => x.code)).toEqual(["not_a_member"]);
  });
});

describe("session restore (lost volume)", () => {
  it("restores Pi's session from Postgres before the next run when Pi no longer has our last entry", async () => {
    const w = await world();
    const t = new Date().toISOString();
    await withTeam(fx.db, w.team, (tx) =>
      tx.execute(sql`
        INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type, payload) VALUES
          (${w.team}, ${w.threadId}, 'e1', NULL, 'message', ${JSON.stringify({ type: "message", id: "e1", parentId: null, timestamp: t, message: { role: "user" } })}::jsonb),
          (${w.team}, ${w.threadId}, 'e2', 'e1', 'message', ${JSON.stringify({ type: "message", id: "e2", parentId: "e1", timestamp: t, message: { role: "assistant" } })}::jsonb)`),
    );
    const sb = await connect(0, w); // fresh volume: empty session
    const r = await fx.replica(1).deps.sandboxWire.router.startRun(w.target, {
      runId: w.runId,
      threadId: w.threadId,
      message: "again",
    });
    expect(r).toEqual({ ok: true });
    expect(sb.restored.at(-1)?.final).toBe(true);
    expect(sb.session.map((e) => e.id)).toEqual(["e1", "e2"]);
    const order = sb.received.map((f) => f.type).filter((t) => t !== "ping");
    expect(order.indexOf("session.restore")).toBeLessThan(order.indexOf("run.start"));
  });
});
