import { describe, expect, it } from "vitest";
import { createApprovalVerifier } from "../approvals/index.js";
import { must } from "../testing/event-stream-fixture.js";
import {
  fx,
  KEY,
  world,
  started,
  inProject,
  join,
  asPlainMember,
  check,
  sendPut,
  result,
  put,
  read,
  AUDIT_POLL,
  rows,
  docCount,
  updates,
  refusals,
  decide,
  setTeamSwitches,
  eventually,
  errorCode,
  useMemoryAgentWorld,
} from "./memory-agent.test-helpers.js";

let askProject = false;
let seq = 0;
useMemoryAgentWorld({
  askProject: () => askProject,
  denyRecall: () => false,
  nextSeq: () => seq++,
});

describe("project memory", () => {
  const input = { scope: "project", path: "decisions.md", content: "use pnpm" };

  it("waits for a signed approval, then applies and emits memory.updated", async () => {
    const w = await world();
    await inProject(w);
    await join(w);
    const sb = await started(w);
    expect((await check(sb, w, "p1", input)).decision).toBe("allow");
    const reqId = sendPut(sb, w, "p1", input);
    const pending = await result(sb, reqId);
    expect(pending).toMatchObject({ ok: true, status: "pending_approval", scope: "project" });
    expect(await docCount(w.team)).toBe(0);

    const [approval] = await rows<{ id: string; tool: string; status: string }>(
      `SELECT id, tool, status FROM approvals WHERE team_id = $1 AND run_id = $2`,
      [w.team, w.runId],
    );
    expect(approval).toMatchObject({ tool: "remember", status: "pending" });
    await decide(w.owner, must(approval, "approval").id, "allow");

    await eventually(async () => (await docCount(w.team)) === 1);
    const ev = await eventually(async () => {
      const found = await updates(w);
      return found.length > 0 ? found : undefined;
    });
    expect(ev[0]?.payload).toMatchObject({
      scope: "project",
      path: "decisions.md",
      version: 1,
      tool_call_id: "p1",
    });
    const consumed = await rows<{ target: { enforcementPoint: string } }>(
      `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'approval.consumed'`,
      [w.team],
    );
    expect(consumed).toHaveLength(1);
    expect(consumed[0]?.target.enforcementPoint).toBe("server");
    // A repeat of the applied call answers its version; the approval is not reused.
    expect(await result(sb, sendPut(sb, w, "p1", input))).toMatchObject({
      status: "applied",
      version: 1,
    });
  });

  it("a denied approval writes nothing", async () => {
    const w = await world();
    await inProject(w);
    await join(w);
    const sb = await started(w);
    await check(sb, w, "p2", input);
    expect(await result(sb, sendPut(sb, w, "p2", input))).toMatchObject({
      status: "pending_approval",
    });
    const [approval] = await rows<{ id: string }>(
      `SELECT id FROM approvals WHERE team_id = $1 AND run_id = $2`,
      [w.team, w.runId],
    );
    await decide(w.owner, must(approval, "approval").id, "deny");
    await expect.poll(() => refusals(w.team), AUDIT_POLL).toContain("put:approval_denied");
    expect(await docCount(w.team)).toBe(0);
    expect(await updates(w)).toHaveLength(0);
  });

  it("applies at once when the policy check already got the signed approval, and only for that input", async () => {
    const w = await world();
    await inProject(w);
    await join(w);
    const sb = await started(w);
    askProject = true;
    try {
      const requestId = `c${seq++}`;
      sb.send({
        v: 1,
        type: "policy.check",
        request_id: requestId,
        run_id: w.runId,
        thread_id: w.threadId,
        tool_call_id: "p3",
        tool: "remember",
        input,
      });
      const pending = await sb.until(
        () => sb.frames("policy.pending").find((f) => f.request_id === requestId),
        3000,
      );
      await decide(w.owner, String(pending.approval_id), "allow");
      const allowed = await sb.until(
        () => sb.frames("policy.result").find((f) => f.request_id === requestId),
        3000,
      );
      expect(allowed.decision).toBe("allow");
    } finally {
      askProject = false;
    }
    // Sending other content than the approved one is refused: the policy allow binds the hash.
    const forged = await result(sb, sendPut(sb, w, "p3", { ...input, content: "rm -rf" }));
    expect(errorCode(forged)).toBe("not_allowed");
    expect(await docCount(w.team)).toBe(0);
    const ok = await result(sb, sendPut(sb, w, "p3", input));
    expect(ok).toMatchObject({ ok: true, status: "applied", scope: "project", version: 1 });
    expect(await docCount(w.team)).toBe(1);
    // One approval was asked for, none new for the put.
    expect((await rows(`SELECT 1 FROM approvals WHERE team_id = $1`, [w.team])).length).toBe(1);
  });

  it.each([
    ["auto approval mode", `UPDATE runs SET approval_mode = 'auto'`, "mode_auto_not_allowlisted"],
    ["a scheduled run", `UPDATE runs SET trigger = 'schedule'`, "scheduled_run_no_prompt"],
  ])(
    "%s never waits: the project write is denied at once and reported",
    async (_n, update, code) => {
      const w = await world();
      await inProject(w);
      await join(w);
      await fx.admin.query(`${update} WHERE team_id = $1 AND id = $2`, [w.team, w.runId]);
      const sb = await started(w);
      await check(sb, w, "a1", input);
      const res = await result(sb, sendPut(sb, w, "a1", input));
      expect(errorCode(res)).toBe("not_allowed");
      expect(res.status).toBeUndefined();
      expect((await rows(`SELECT 1 FROM approvals WHERE team_id = $1`, [w.team])).length).toBe(0);
      expect(await docCount(w.team)).toBe(0);
      const denied = await rows<{ payload: { tool: string; reasons: { code: string }[] } }>(
        `SELECT payload FROM run_events WHERE team_id = $1 AND run_id = $2 AND type = 'policy.denied'`,
        [w.team, w.runId],
      );
      expect(denied[0]?.payload).toMatchObject({ tool: "remember", reasons: [{ code }] });
      // KOBE-178: only a scheduled run's skipped writes are reported on its run.
      expect(
        await rows(`SELECT tool, reason FROM run_skipped_actions WHERE team_id = $1`, [w.team]),
      ).toEqual(code === "scheduled_run_no_prompt" ? [{ tool: "remember", reason: code }] : []);
      // Personal memory is not an approval matter: it still applies.
      expect((await put(sb, w, "a2", { scope: "user", path: "a.md", content: "x" })).status).toBe(
        "applied",
      );
    },
  );

  it("uses the effective mode: a site floor above the run's own `auto` still asks", async () => {
    const w = await world();
    await inProject(w);
    await join(w);
    await fx.admin.query(`UPDATE runs SET approval_mode = 'auto' WHERE team_id = $1 AND id = $2`, [
      w.team,
      w.runId,
    ]);
    await fx.admin.query(
      `INSERT INTO site_settings (key, value) VALUES ('policy.approval_floor', 'ask-on-write')
       ON CONFLICT (key) DO UPDATE SET value = 'ask-on-write'`,
    );
    try {
      const sb = await started(w);
      await check(sb, w, "f1", input);
      expect(await result(sb, sendPut(sb, w, "f1", input))).toMatchObject({
        status: "pending_approval",
      });
    } finally {
      await fx.admin.query(`DELETE FROM site_settings WHERE key = 'policy.approval_floor'`);
    }
  });

  it("an approval is single use and bound to its input", async () => {
    const w = await world();
    await inProject(w);
    await join(w);
    const sb = await started(w);
    askProject = true;
    try {
      const requestId = `c${seq++}`;
      sb.send({
        v: 1,
        type: "policy.check",
        request_id: requestId,
        run_id: w.runId,
        thread_id: w.threadId,
        tool_call_id: "s1",
        tool: "remember",
        input,
      });
      const pending = await sb.until(
        () => sb.frames("policy.pending").find((f) => f.request_id === requestId),
        3000,
      );
      await decide(w.owner, String(pending.approval_id), "allow");
      await sb.until(
        () => sb.frames("policy.result").find((f) => f.request_id === requestId),
        3000,
      );
    } finally {
      askProject = false;
    }
    const verifier = createApprovalVerifier({ db: fx.db, keys: KEY });
    const call = {
      teamId: w.team,
      userId: w.owner.id,
      runId: w.runId,
      toolCallId: "s1",
      tool: "remember",
    };
    // Another input hash: refused, and the approval is still unspent.
    expect((await verifier.authorize({ ...call, input: { ...input, content: "other" } })).ok).toBe(
      false,
    );
    // The handler spends it exactly once.
    expect(await result(sb, sendPut(sb, w, "s1", input))).toMatchObject({ status: "applied" });
    expect((await verifier.authorize({ ...call, input })).ok).toBe(false);
    // A replayed memory.put answers the stored version and writes nothing more.
    expect(await result(sb, sendPut(sb, w, "s1", input))).toMatchObject({
      status: "applied",
      version: 1,
    });
    expect(
      (await rows(`SELECT 1 FROM memory_doc_versions WHERE team_id = $1`, [w.team])).length,
    ).toBe(1);
  });

  it("refuses threads outside a project and a disabled project scope", async () => {
    const loose = await world();
    await join(loose);
    const sbL = await started(loose);
    await check(sbL, loose, "n2", input);
    expect(errorCode(await result(sbL, sendPut(sbL, loose, "n2", input)))).toBe("not_allowed");
    await expect.poll(() => refusals(loose.team), AUDIT_POLL).toContain("put:no_project");

    const off = await world();
    await inProject(off);
    await join(off);
    await setTeamSwitches(off, { project_memory_enabled: false });
    const sbO = await started(off);
    await check(sbO, off, "n3", input);
    expect(errorCode(await result(sbO, sendPut(sbO, off, "n3", input)))).toBe("memory_disabled");
    // Personal memory still works while project memory is off.
    const personal = await put(sbO, off, "n4", { scope: "user", path: "a.md", content: "x" });
    expect(personal.status).toBe("applied");
  });

  it("a reader's remember into the project is refused plainly; reading and personal memory work (PR6)", async () => {
    const w = await world();
    await inProject(w); // no row: an implicit reader (RV1)
    await asPlainMember(w);
    const sb = await started(w);
    await check(sb, w, "rd1", input);
    const refused = await result(sb, sendPut(sb, w, "rd1", input));
    expect(errorCode(refused)).toBe("not_allowed");
    expect(refused.error.message).toContain("read this project's memory but not change it");
    await expect.poll(() => refusals(w.team), AUDIT_POLL).toContain("put:not_allowed");
    expect((await rows(`SELECT 1 FROM approvals WHERE team_id = $1`, [w.team])).length).toBe(0);
    expect(errorCode(await read(sb, w, { scope: "project" }))).toBeUndefined();
    const personal = await put(sb, w, "rd2", { scope: "user", path: "a.md", content: "x" });
    expect(personal.status).toBe("applied");
  });

  it("members read project memory", async () => {
    const w = await world();
    await inProject(w);
    await join(w);
    const sb = await started(w);
    await check(sb, w, "r1", input);
    expect((await result(sb, sendPut(sb, w, "r1", input))).status).toBe("pending_approval");
    const [approval] = await rows<{ id: string }>(`SELECT id FROM approvals WHERE team_id = $1`, [
      w.team,
    ]);
    await decide(w.owner, must(approval, "approval").id, "allow");
    await eventually(async () => (await docCount(w.team)) === 1);
    const found = await read(sb, w, { query: "pnpm" });
    expect(found.files).toEqual([
      { scope: "project", path: "decisions.md", content: "use pnpm", version: 1 },
    ]);
  });
});
