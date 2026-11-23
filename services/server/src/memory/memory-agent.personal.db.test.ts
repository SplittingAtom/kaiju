import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runMemoryContextSchema } from "@kobe/protocol";
import { must } from "../testing/event-stream-fixture.js";
import {
  fx,
  auth,
  asCompaction,
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
  sendRead,
  AUDIT_POLL,
  rows,
  docCount,
  updates,
  refusals,
  setTeamSwitches,
  errorCode,
  useMemoryAgentWorld,
} from "./memory-agent.test-helpers.js";

let denyRecall = false;
let seq = 0;
useMemoryAgentWorld({
  askProject: () => false,
  denyRecall: () => denyRecall,
  nextSeq: () => seq++,
});

describe("memory.put / memory.read: personal memory", () => {
  it("remember and recall work end to end, with Undo data, audit and no content in the audit log", async () => {
    const w = await world();
    const sb = await started(w);

    const first = await put(sb, w, "t1", { scope: "user", path: "prefs.md", content: "likes tea" });
    expect(first).toMatchObject({
      ok: true,
      op: "put",
      status: "applied",
      scope: "user",
      version: 1,
    });
    expect(first.previous_version).toBeUndefined();
    const second = await put(sb, w, "t2", {
      scope: "user",
      path: "prefs.md",
      content: "and coffee",
      mode: "append",
    });
    expect(second).toMatchObject({ status: "applied", version: 2, previous_version: 1 });

    const file = await read(sb, w, { scope: "user", path: "prefs.md" });
    expect(file).toMatchObject({ ok: true, op: "read", truncated: false });
    expect(file.files).toEqual([
      { scope: "user", path: "prefs.md", content: "likes tea\nand coffee", version: 2 },
    ]);
    await put(sb, w, "t3", { scope: "user", path: "MEMORY.md", content: "- [prefs](prefs.md)" });
    const listed = await read(sb, w, {});
    expect(listed.files.map((f: { path: string }) => f.path)).toEqual(["MEMORY.md", "prefs.md"]);
    expect(listed.files[0].content).toBeUndefined();
    const found = await read(sb, w, { query: "COFFEE" });
    expect(found.files.map((f: { path: string }) => f.path)).toEqual(["prefs.md"]);
    expect(errorCode(await read(sb, w, { scope: "user", path: "nope.md" }))).toBe("not_found");

    // Events carry what Undo needs, tied to the tool call.
    const ev = await updates(w);
    expect(ev.map((e) => e.payload)).toMatchObject([
      { scope: "user", path: "prefs.md", version: 1, tool_call_id: "t1", mode: "replace" },
      { scope: "user", version: 2, previous_version: 1, tool_call_id: "t2", mode: "append" },
      { path: "MEMORY.md", version: 1, tool_call_id: "t3" },
    ]);
    // The panel sees the same doc; the version is the agent's.
    const detail = (await w.owner.browser.get("/v1/memory?scope=user")).json as {
      docs: { path: string; current_version: number }[];
    };
    expect(detail.docs.map((d) => [d.path, d.current_version]).sort()).toEqual([
      ["MEMORY.md", 1],
      ["prefs.md", 2],
    ]);
    const versions = await rows<{ actor_kind: string; tool_call_id: string; run_id: string }>(
      `SELECT actor_kind, tool_call_id, run_id FROM memory_doc_versions WHERE team_id = $1 ORDER BY created_at`,
      [w.team],
    );
    expect(versions[0]).toMatchObject({ actor_kind: "agent", tool_call_id: "t1", run_id: w.runId });

    const audits = await rows<{ target: Record<string, unknown> }>(
      `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'memory.written' ORDER BY seq`,
      [w.team],
    );
    expect(audits).toHaveLength(3);
    expect(audits[0]?.target).toMatchObject({ scope: "user", actorKind: "agent", version: 1 });
    expect(JSON.stringify(audits)).not.toMatch(/tea|coffee|prefs/);
  });

  it("is idempotent on the tool call id", async () => {
    const w = await world();
    const sb = await started(w);
    const input = { scope: "user", path: "a.md", content: "one" };
    const first = await put(sb, w, "same", input);
    const again = await result(sb, sendPut(sb, w, "same", input));
    expect(again).toMatchObject({ status: "applied", version: first.version });
    expect(
      (await rows(`SELECT 1 FROM memory_doc_versions WHERE team_id = $1`, [w.team])).length,
    ).toBe(1);
    expect(await updates(w)).toHaveLength(1);
  });

  it("refuses a compaction run from the database, for put and read (KOBE-213)", async () => {
    const w = await world();
    const sb = await started(w);
    const input = { scope: "user", path: "a.md", content: "x" };
    expect((await check(sb, w, "c1", input)).decision).toBe("allow");
    expect((await check(sb, w, "rc1", {}, "recall")).decision).toBe("allow");
    await asCompaction(w.team, w.runId);
    expect(errorCode(await result(sb, sendPut(sb, w, "c1", input)))).toBe("not_allowed");
    expect(errorCode(await result(sb, sendRead(sb, w, "rc1", {})))).toBe("not_allowed");
    expect(await docCount(w.team)).toBe(0);
    await expect
      .poll(() => refusals(w.team), AUDIT_POLL)
      .toEqual(expect.arrayContaining(["put:run_not_active", "read:run_not_active"]));
  });

  it("refuses without the capability, an unallowed call, a changed input and an ended run", async () => {
    const w = await world();
    const sb = await started(w, []);
    const input = { scope: "user", path: "a.md", content: "x" };
    expect(errorCode(await result(sb, sendPut(sb, w, "c0", input)))).toBe("not_allowed");
    expect(errorCode(await read(sb, w, {}))).toBe("not_allowed");

    const w2 = await world();
    const sb2 = await started(w2);
    // Never allowed by a policy check.
    expect(errorCode(await result(sb2, sendPut(sb2, w2, "ghost", input)))).toBe("not_allowed");
    // Allowed for one input, sent with another.
    expect((await check(sb2, w2, "c1", input)).decision).toBe("allow");
    const forged = { ...input, content: "something else" };
    expect(errorCode(await result(sb2, sendPut(sb2, w2, "c1", forged)))).toBe("not_allowed");
    // Allowed, then the run ends.
    expect((await check(sb2, w2, "c2", input)).decision).toBe("allow");
    await fx.complete(w2.team, w2.runId);
    const late = await result(sb2, sendPut(sb2, w2, "c2", input));
    expect(errorCode(late)).toBe("not_allowed");
    expect(await docCount(w2.team)).toBe(0);
    expect(await docCount(w.team)).toBe(0);
    await expect
      .poll(() => refusals(w2.team), AUDIT_POLL)
      .toEqual(
        expect.arrayContaining(["put:not_allowed", "put:input_mismatch", "put:run_not_active"]),
      );
    await expect
      .poll(() => refusals(w.team), AUDIT_POLL)
      .toEqual(expect.arrayContaining(["put:capability_missing", "read:capability_missing"]));
  });

  it("refuses an oversized index and returns the store's codes", async () => {
    const w = await world();
    const sb = await started(w);
    const lines = Array(150).fill("- l").join("\n");
    await put(sb, w, "i1", { scope: "user", path: "MEMORY.md", content: lines });
    const full = await put(sb, w, "i2", {
      scope: "user",
      path: "MEMORY.md",
      content: lines,
      mode: "append",
    });
    expect(errorCode(full)).toBe("index_full");
    expect(await updates(w)).toHaveLength(1);
  });
});

describe("recall is bound to the policy check (D-3)", () => {
  it("a recall that policy denied, never checked or changed is refused", async () => {
    const w = await world();
    const sb = await started(w);
    await put(sb, w, "k1", { scope: "user", path: "a.md", content: "secret" });
    // Never checked.
    const ghost = await result(sb, sendRead(sb, w, "ghost", {}));
    expect(errorCode(ghost)).toBe("not_allowed");
    // Checked for one input, sent with another.
    expect((await check(sb, w, "rc-x", { query: "none" }, "recall")).decision).toBe("allow");
    expect(errorCode(await result(sb, sendRead(sb, w, "rc-x", { query: "secret" })))).toBe(
      "not_allowed",
    );
    // Denied by policy.
    denyRecall = true;
    try {
      expect((await check(sb, w, "rc-d", {}, "recall")).decision).toBe("deny");
    } finally {
      denyRecall = false;
    }
    const denied = await result(sb, sendRead(sb, w, "rc-d", {}));
    expect(errorCode(denied)).toBe("not_allowed");
    expect(JSON.stringify(denied)).not.toContain("secret");
    await expect
      .poll(() => refusals(w.team), AUDIT_POLL)
      .toEqual(expect.arrayContaining(["read:not_allowed", "read:input_mismatch"]));
  });
});

describe("switches", () => {
  it("a disabled scope answers memory_disabled and is left out of run.start.memory", async () => {
    const w = await world();
    await setTeamSwitches(w, { memory_enabled: false });
    const sb = await started(w);
    const start = sb.frames("run.start")[0] as { memory?: unknown } | undefined;
    expect(runMemoryContextSchema.parse(start?.memory)).toEqual({ scopes: [], indexes: [] });
    const refused = await put(sb, w, "d1", { scope: "user", path: "a.md", content: "x" });
    expect(errorCode(refused)).toBe("memory_disabled");
    expect(errorCode(await read(sb, w, { scope: "user" }))).toBe("memory_disabled");
    expect(await docCount(w.team)).toBe(0);
    await expect.poll(() => refusals(w.team), AUDIT_POLL).toContain("put:memory_disabled");
  });

  it("the site switch is ANDed with the team's", async () => {
    const w = await world();
    const sb = await started(w);
    await fx.admin.query(
      `INSERT INTO site_settings (key, value) VALUES ('memory.enabled', 'false')
       ON CONFLICT (key) DO UPDATE SET value = 'false'`,
    );
    try {
      const refused = await put(sb, w, "d1", { scope: "user", path: "a.md", content: "x" });
      expect(errorCode(refused)).toBe("memory_disabled");
    } finally {
      await fx.admin.query(`DELETE FROM site_settings WHERE key = 'memory.enabled'`);
    }
    const ok = await put(sb, w, "d2", { scope: "user", path: "a.md", content: "x" });
    expect(ok.status).toBe("applied");
  });
});

describe("run.start.memory", () => {
  it("carries the indexes of the enabled scopes, only for agents with the capability", async () => {
    const w = await world();
    const first = await started(w);
    await put(first, w, "x1", { scope: "user", path: "MEMORY.md", content: "- tea\n- coffee" });
    first.close();

    // A new run of the same user sees the stored index.
    const w2 = { ...w, runId: await fx.run(w.team, w.owner), sandboxId: randomUUID() };
    const { rows: t } = await fx.admin.query<{ thread_id: string }>(
      `SELECT thread_id FROM runs WHERE team_id = $1 AND id = $2`,
      [w.team, w2.runId],
    );
    const world2 = {
      ...w2,
      threadId: must(t[0], "thread").thread_id,
      token: auth.issue({ sandboxId: w2.sandboxId, teamId: w.team, userId: w.owner.id }),
    };
    const sb = await started(world2);
    const start = sb.frames("run.start")[0] as { memory?: unknown } | undefined;
    expect(runMemoryContextSchema.parse(start?.memory)).toEqual({
      scopes: ["user"],
      // written_by: the index was last written by the agent (provenance for the model, KOBE-157).
      indexes: [
        {
          scope: "user",
          content: "- tea\n- coffee",
          version: 1,
          truncated: false,
          written_by: "agent",
        },
      ],
    });

    const w3 = await world();
    const old = await started(w3, []);
    expect(old.frames("run.start")[0]).not.toHaveProperty("memory");
  });

  it("lists project for every member of the thread's workspace, with its index", async () => {
    const w = await world();
    const projectId = await inProject(w);
    await join(w);
    const sb0 = await started(w);
    const start = sb0.frames("run.start")[0] as { memory?: unknown } | undefined;
    expect(runMemoryContextSchema.parse(start?.memory)).toEqual({
      scopes: ["user", "project"],
      indexes: [
        { scope: "user", content: "", version: 0, truncated: false },
        { scope: "project", content: "", version: 0, truncated: false },
      ],
    });
    expect(projectId).toBeTruthy();

    const w2 = await world();
    await inProject(w2);
    await asPlainMember(w2); // no row: an implicit reader (RV1) still reads project memory
    const sb = await started(w2);
    const memory = runMemoryContextSchema.parse(
      (sb.frames("run.start")[0] as { memory?: unknown } | undefined)?.memory,
    );
    expect(memory.scopes).toEqual(["user", "project"]);

    const w3 = await world();
    await inProject(w3);
    await join(w3);
    await setTeamSwitches(w3, { project_memory_enabled: false });
    const sb3 = await started(w3);
    expect(
      runMemoryContextSchema.parse(
        (sb3.frames("run.start")[0] as { memory?: unknown } | undefined)?.memory,
      ).scopes,
    ).toEqual(["user"]);
  });
});
