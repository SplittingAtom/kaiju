import { randomUUID } from "node:crypto";
import { verifySessionToken } from "@kaiju/session-token";
import { describe, expect, it } from "vitest";
import { enableConnector, piName, registerConnector } from "../testing/mcp-fixtures.js";
import { VERIFY_KEYS } from "../testing/sandbox-fixtures.js";
import {
  ANY,
  finance,
  h,
  kube,
  admin,
  builder,
  member,
  adminId,
  builderId,
  type JobResult,
  report,
  clean,
  attacked,
  finishJob,
  gateOn,
  draft,
  publish,
  evals,
  settled,
  currentVersion,
  useOrbitEvalHarness,
} from "./orbit-eval.test-helpers.js";

let jobResult: JobResult;
let gateOpen = true;
useOrbitEvalHarness({
  jobResult: () => jobResult,
  gateOpen: () => gateOpen,
  reset: () => {
    jobResult = clean();
    gateOpen = true;
  },
});

describe("team eval settings", () => {
  it("is off by default and a team admin turns it on, with a threshold, audited", async () => {
    expect((await member.get("/v1/team/eval-settings")).json).toEqual({
      enabled: false,
      maxAttackSuccessRate: 0.2,
    });
    await gateOn(0.4);
    expect((await member.get("/v1/team/eval-settings")).json).toEqual({
      enabled: true,
      maxAttackSuccessRate: 0.4,
    });
    const audit = await h.admin.query(
      `SELECT target FROM audit_log WHERE action = 'agent.eval.settings_changed' AND team_id = $1`,
      [finance],
    );
    expect(audit.rows.at(-1)?.target).toEqual({ enabled: true, maxAttackSuccessRate: 0.4 });
  });

  it("is for team admins only, and validates its input", async () => {
    expect((await builder.put("/v1/team/eval-settings", { enabled: true })).status).toBe(403);
    expect((await admin.put("/v1/team/eval-settings", { maxAttackSuccessRate: 2 })).status).toBe(
      400,
    );
    expect((await admin.put("/v1/team/eval-settings", {})).status).toBe(400);
  });
});

describe("Publish with the gate on (KOBE-93)", () => {
  it("publishes at once when the gate is off", async () => {
    const id = await draft();
    expect((await publish(id)).status).toBe(201);
    expect(kube.all("Job")).toHaveLength(0);
  });

  it("starts an eval and publishes when it passes: score on the version, Job as strict as a sandbox", async () => {
    await gateOn(0.2);
    const id = await draft();
    const res = await publish(id);
    expect(res.status, JSON.stringify(res.json)).toBe(202);
    expect(res.json.eval.status).toBe("pending");
    expect(await currentVersion(id)).toBeNull();
    await settled();

    const { evals: list, active } = await evals(id);
    expect(active).toBeNull();
    expect(list[0]).toMatchObject({
      status: "passed",
      attackSuccessRate: 0,
      attempts: 5,
      version: 1,
      threshold: 0.2,
    });
    expect(await currentVersion(id)).toBe(1);
    const versions = (await builder.get(`/v1/agents/${id}/versions`)).json.versions;
    expect(versions[0].score).toMatchObject({ attackSuccessRate: 0, threshold: 0.2 });
    const detail = (await builder.get(`/v1/agents/${id}/evals/${list[0].id}`)).json.eval;
    expect(detail.report.pack).toEqual({ id: "kaiju-default", version: 1 });

    const [job] = kube.all("Job") as unknown as {
      metadata: { namespace: string };
      spec: { activeDeadlineSeconds: number; template: { spec: Record<string, any> } };
    }[];
    expect(job?.metadata.namespace).toBe("kobe-team-finance");
    expect(job?.spec.activeDeadlineSeconds).toBe(600);
    expect(job?.spec.template.spec.runtimeClassName).toBe("gvisor");
    const env = Object.fromEntries(
      (job?.spec.template.spec.containers[0].env as { name: string; value: string }[]).map((e) => [
        e.name,
        e.value,
      ]),
    );
    // The gateway token is scoped to this team and eval, short-lived, and the only credential.
    const claims = verifySessionToken(
      env.KAIJU_MODEL_SESSION_TOKEN as string,
      "kobe.model-gateway",
      VERIFY_KEYS["kobe.model-gateway"],
    );
    expect(claims).toMatchObject({ sub: list[0].id, team_id: finance, user_id: builderId });
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(15 * 60 + 60);
    expect(env.KAIJU_EVAL_MODEL).toBe("anthropic/claude-smart");
    expect(JSON.stringify(job)).not.toContain("sealed-provider-key");
    const map = kube.all("ConfigMap")[0] as unknown as { data: Record<string, string> };
    expect(map.data["agent.yaml"]).toContain("You are careful.");

    const events = await h.admin.query(
      `SELECT action FROM audit_log WHERE team_id = $1 AND action IN ('agent.eval.requested', 'agent.eval.finished') ORDER BY seq`,
      [finance],
    );
    expect(events.rows.map((r) => r.action)).toEqual([
      "agent.eval.requested",
      "agent.eval.finished",
    ]);
  });

  it("evaluates the same MCP tool surface the agent runs with, by name only (KOBE-112 ac-2)", async () => {
    await gateOn(0.2);
    const connector = await registerConnector(h.admin, {
      url: "https://mcp.example.com/hook/secret-path-4711",
      authKind: "api_key",
    });
    await enableConnector(h.admin, finance, connector.id, adminId, "read_only", []);
    const created = await builder.post("/v1/agents", {
      scope: "team",
      frontmatter: { name: `Mcp ${randomUUID().slice(0, 6)}`, connectors: [connector.name] },
      prompt: "You use Jira.",
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    expect((await publish(created.json.agent.id as string)).status).toBe(202);
    await settled();
    const maps = kube.all("ConfigMap") as unknown as { data: Record<string, string> }[];
    const yaml = maps
      .map((m) => m.data["agent.yaml"] ?? "")
      .find((y) => y.includes("You use Jira."));
    expect(yaml).toContain(`- ${piName(connector.name, "get_issue")}`);
    expect(yaml).not.toContain("create_issue");
    expect(yaml).not.toContain("secret-path-4711");
    expect(yaml).not.toContain("mcp.example.com");
  });

  it("blocks above the threshold: no version, a clear result, the draft stays", async () => {
    await gateOn(0.2);
    jobResult = attacked();
    const id = await draft();
    expect((await publish(id)).status).toBe(202);
    await settled();
    const { evals: list } = await evals(id);
    expect(list[0]).toMatchObject({
      status: "blocked",
      attackSuccessRate: 0.6,
      threshold: 0.2,
      version: null,
    });
    expect(await currentVersion(id)).toBeNull();
  });

  it("errors when a scenario errored or the Job failed: publish stays blocked, then retry succeeds", async () => {
    await gateOn(0.2);
    const id = await draft();
    jobResult = {
      log: report({ errors: 2, attempts: 3 }),
      outcome: "Failed",
      reason: "BackoffLimitExceeded",
    };
    expect((await publish(id)).status).toBe(202);
    await settled();
    let list = (await evals(id)).evals;
    expect(list[0].status).toBe("errored");
    expect(list[0].error).toMatch(/Nothing was published/);
    expect(await currentVersion(id)).toBeNull();

    // A timeout is an error too.
    jobResult = { log: "", outcome: "Failed", reason: "DeadlineExceeded" };
    expect((await publish(id)).status).toBe(202);
    await settled();
    list = (await evals(id)).evals;
    expect(list[0]).toMatchObject({ status: "errored" });
    expect(list[0].error).toMatch(/DeadlineExceeded/);

    // Retry: publishing again is allowed and creates a new eval.
    jobResult = clean();
    expect((await publish(id)).status).toBe(202);
    await settled();
    list = (await evals(id)).evals;
    expect(list.map((e: { status: string }) => e.status)).toEqual(["passed", "errored", "errored"]);
    expect(await currentVersion(id)).toBe(1);
  });

  it("fails closed without the isolation runtime: errored, nothing published", async () => {
    await gateOn();
    gateOpen = false;
    const id = await draft();
    expect((await publish(id)).status).toBe(202);
    await settled();
    const first = (await evals(id)).evals[0];
    expect(first.status).toBe("errored");
    expect(await currentVersion(id)).toBeNull();
  });

  it("publishes exactly what was evaluated, even if the draft changed meanwhile", async () => {
    await gateOn();
    const id = await draft();
    const res = await publish(id);
    expect(res.status).toBe(202);
    await builder.put(
      `/v1/agents/${id}`,
      { frontmatter: { name: "Renamed" }, prompt: "Changed." },
      { "if-match": '"1"' },
    );
    await settled();
    const version = (await builder.get(`/v1/agents/${id}/versions/1`)).json.version;
    expect(version.prompt).toBe("You are careful.");
  });

  it("gates personal agents used in the team too", async () => {
    await gateOn();
    const id = await draft("personal");
    const res = await publish(id);
    expect(res.status, JSON.stringify(res.json)).toBe(202);
    await settled();
    expect((await evals(id)).evals[0]).toMatchObject({ status: "passed", version: 1 });
  });

  it("refuses an unchanged draft, an unresolvable model and a second concurrent eval", async () => {
    await gateOn();
    const id = await draft();
    expect((await publish(id)).status).toBe(202);
    await settled();
    expect((await publish(id)).json.code).toBe("unchanged");

    const pinned = await builder.post("/v1/agents", {
      scope: "team",
      frontmatter: { name: "Pinned elsewhere", model: "not-enabled" },
      prompt: "x",
    });
    const res = await publish(pinned.json.agent.id);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("model_not_resolvable");

    jobResult = "hang";
    const slow = await draft();
    expect((await publish(slow)).status).toBe(202);
    const second = await publish(slow);
    expect(second.status).toBe(409);
    expect(second.json.code).toBe("eval_in_progress");
    expect((await evals(slow)).active.status).toBe("running");
    // Let the Job end so its driver finishes.
    jobResult = clean();
    for (const job of kube.all("Job")) if (!job.status) finishJob(kube, job);
    await settled();
    expect((await evals(slow)).evals[0].status).toBe("passed");
  });

  it("members can't publish, so they can't start evals", async () => {
    await gateOn();
    const id = await draft();
    expect((await member.request("POST", `/v1/agents/${id}/publish`, {}, ANY)).status).toBe(403);
  });
});

describe("Rollback with the gate on (KOBE-93)", () => {
  const rollback = (id: string, version: number) =>
    builder.post(`/v1/agents/${id}/rollback`, { version });
  const edit = async (id: string, revision: number, prompt: string) => {
    const res = await builder.put(
      `/v1/agents/${id}`,
      { frontmatter: { name: "Rolled" }, prompt },
      { "if-match": `"${revision}"` },
    );
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res;
  };

  it("restores a version that passed under the current limit without a new eval", async () => {
    await gateOn(0.2);
    const id = await draft();
    await publish(id);
    await settled();
    await edit(id, 1, "v2 text");
    await publish(id);
    await settled();
    const jobs = kube.all("Job").length;
    const res = await rollback(id, 1);
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(kube.all("Job").length).toBe(jobs);
  });

  it("evaluates a version with no passing score first, and restores it only if it passes", async () => {
    const id = await draft();
    expect((await publish(id)).status).toBe(201); // gate off: v1 has no score
    await edit(id, 1, "v2 text");
    expect((await publish(id)).status).toBe(201);
    await gateOn(0.2);
    jobResult = attacked();
    const blocked = await rollback(id, 1);
    expect(blocked.status).toBe(202);
    await settled();
    expect((await evals(id)).evals[0]).toMatchObject({ status: "blocked", version: null });
    expect(await currentVersion(id)).toBe(2);

    jobResult = clean();
    expect((await rollback(id, 1)).status).toBe(202);
    await settled();
    expect((await evals(id)).evals[0]).toMatchObject({ status: "passed", version: 3 });
    expect(await currentVersion(id)).toBe(3);
    const v3 = (await builder.get(`/v1/agents/${id}/versions/3`)).json.version;
    expect(v3.prompt).toBe("You are careful.");
  });

  it("re-evaluates when the limit was tightened below the version's score, and fails closed on error", async () => {
    await gateOn(0.6);
    jobResult = {
      log: report({ attack_success_rate: 0.4, attack_successes: 2 }),
      outcome: "Complete",
    };
    const id = await draft();
    await publish(id);
    await settled();
    await edit(id, 1, "v2 text");
    jobResult = clean();
    await publish(id);
    await settled();
    await gateOn(0.2);
    jobResult = { log: "", outcome: "Failed", reason: "DeadlineExceeded" };
    expect((await rollback(id, 1)).status).toBe(202);
    await settled();
    expect((await evals(id)).evals[0].status).toBe("errored");
    expect(await currentVersion(id)).toBe(2);
  });
});

describe("Evaluated manifest (KOBE-93)", () => {
  it("refuses to publish when the tool manifest changed since the eval, and says to re-run", async () => {
    await gateOn();
    jobResult = "hang";
    const id = await draft();
    expect((await publish(id)).status).toBe(202);
    const running = (await evals(id)).active;
    // The policy floor changed while the eval ran: the manifest it scored no longer applies.
    await h.admin.query(
      `UPDATE orbit_evals SET tool_manifest = '{"tampered":true}' WHERE id = $1`,
      [running.id],
    );
    jobResult = clean();
    for (const job of kube.all("Job")) if (!job.status) finishJob(kube, job);
    await settled();
    const [first] = (await evals(id)).evals;
    expect(first).toMatchObject({ status: "passed", version: null });
    expect(first.error).toMatch(/tool policy changed.*re-run/);
    expect(await currentVersion(id)).toBeNull();
  });
});

describe("Publish with the gate on but no runner", () => {
  it("blocks with a clear message instead of publishing unevaluated", async () => {
    await gateOn();
    const app = (await import("../app.js")).createApp(h.deps);
    const { TestBrowser } = await import("../testing/browser.js");
    const b = new TestBrowser(app, "http://kaiju.test");
    await b.post("/api/auth/sign-in/email", {
      email: "bob@eval.test",
      password: "a long enough password",
    });
    await b.put("/v1/me/teams/active", { teamId: finance });
    b.team = finance;
    const id = await draft();
    const res = await b.request("POST", `/v1/agents/${id}/publish`, {}, ANY);
    expect(res.status, JSON.stringify(res.json)).toBe(503);
    expect(res.json.code).toBe("eval_unavailable");
    expect(await currentVersion(id)).toBeNull();
  });
});
