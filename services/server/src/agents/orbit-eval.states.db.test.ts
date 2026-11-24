import { randomUUID } from "node:crypto";
import { loadEvalCaseFile, loadGatewayPrincipal } from "@kaiju/db";
import { describe, expect, it } from "vitest";
import { createEval, finishEval, getEval, markRunning, readEvalSettings } from "./eval/store.js";
import {
  ANY,
  finance,
  h,
  kube,
  admin,
  builder,
  adminId,
  builderId,
  type JobResult,
  runner,
  report,
  clean,
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

describe("eval state machine", () => {
  const input = (agentId: string) => ({
    teamId: finance,
    agentId,
    agentScope: "team" as const,
    agentSlug: "sm",
    requestedBy: builderId,
    draftRevision: 1,
    definition: { frontmatter: { name: "SM" }, prompt: "p" },
    model: "anthropic/claude-smart",
    threshold: 0.2,
  });
  const scored = {
    attackSuccessRate: 0,
    attempts: 5,
    attackSuccesses: 0,
    report: {
      schema_version: 1,
      attack_success_rate: 0,
      attempts: 5,
      attack_successes: 0,
      errors: 0,
      pack: { id: "kaiju-default", version: 1 },
    },
  } as const;

  it("moves pending -> running -> passed once; a later finish changes nothing", async () => {
    const created = await createEval(h.deps.database.db, input(randomUUID()));
    if (!created.ok) throw new Error("expected an eval");
    const { id } = created.value;
    expect(created.value.status).toBe("pending");
    expect(await markRunning(h.deps.database.db, finance, id, "job")).toBe(true);
    expect(await markRunning(h.deps.database.db, finance, id, "job")).toBe(false);
    const done = await finishEval(h.deps.database.db, finance, id, { status: "passed", ...scored });
    expect(done?.status).toBe("passed");
    expect(
      await finishEval(h.deps.database.db, finance, id, { status: "errored", error: "late" }),
    ).toBeNull();
    expect((await getEval(h.deps.database.db, finance, id))?.status).toBe("passed");
  });

  it("allows one unfinished eval per agent and a retry after any end", async () => {
    const agent = randomUUID();
    const a = await createEval(h.deps.database.db, input(agent));
    expect(await createEval(h.deps.database.db, input(agent))).toEqual({
      ok: false,
      error: "eval_in_progress",
    });
    if (!a.ok) throw new Error("expected an eval");
    await finishEval(h.deps.database.db, finance, a.value.id, { status: "errored", error: "boom" });
    expect((await createEval(h.deps.database.db, input(agent))).ok).toBe(true);
  });

  it("can error straight from pending, and rejects a blocked verdict without a score at the database", async () => {
    const created = await createEval(h.deps.database.db, input(randomUUID()));
    if (!created.ok) throw new Error("expected an eval");
    const done = await finishEval(h.deps.database.db, finance, created.value.id, {
      status: "errored",
      error: "Job could not be created",
    });
    expect(done).toMatchObject({ status: "errored", error: "Job could not be created" });
    await expect(
      h.admin.query(
        `INSERT INTO orbit_evals (team_id, agent_id, agent_scope, agent_slug, requested_by, draft_revision,
           definition, model, threshold, status, finished_at) VALUES ($1, $2, 'team', 's', $3, 1, '{}', 'm', 0.2, 'blocked', now())`,
        [finance, randomUUID(), builderId],
      ),
    ).rejects.toThrow(/orbit_evals_verdict/);
  });

  it("makes the eval id a live gateway principal only while the eval runs", async () => {
    const db = h.deps.database.db;
    const created = await createEval(db, input(randomUUID()));
    if (!created.ok) throw new Error("expected an eval");
    const { id } = created.value;
    const principal = () => loadGatewayPrincipal(db, finance, builderId, id);
    expect((await principal()).sandbox).toBe("revoked");
    await markRunning(db, finance, id, "job");
    expect((await principal()).sandbox).toBe("live");
    // The eval's token may call only the model the eval runs on.
    expect((await principal()).enabledModels).toEqual(["anthropic/claude-smart"]);
    // Another user can't present this eval's id.
    expect((await loadGatewayPrincipal(db, finance, adminId, id)).sandbox).toBe("unrecorded");
    await finishEval(db, finance, id, { status: "passed", ...scored });
    expect((await principal()).sandbox).toBe("revoked");
    expect((await readEvalSettings(db, finance)).enabled).toBe(false);
  });
});

describe("sweeper", () => {
  it("errors an eval whose driver died and whose Job is gone, and adopts a finished Job", async () => {
    const db = h.deps.database.db;
    const old = new Date(Date.now() - 3 * 3600_000);
    const stuck = async (job: boolean) => {
      const agentId = randomUUID();
      const created = await createEval(db, {
        teamId: finance,
        agentId,
        agentScope: "team",
        agentSlug: "stuck",
        requestedBy: builderId,
        draftRevision: 1,
        definition: { frontmatter: { name: "Stuck" }, prompt: "p" },
        model: "anthropic/claude-smart",
        threshold: 0.2,
      });
      if (!created.ok) throw new Error("expected an eval");
      await h.admin.query(
        `UPDATE orbit_evals SET created_at = $2, status = 'running' WHERE id = $1`,
        [created.value.id, old],
      );
      if (job) {
        const name = `orbit-eval-${created.value.id}`;
        kube.seed({
          apiVersion: "batch/v1",
          kind: "Job",
          metadata: { name, namespace: "kaiju-team-finance" },
          status: { conditions: [{ type: "Complete", status: "True" }] },
        });
        kube.seed({
          apiVersion: "v1",
          kind: "Pod",
          metadata: {
            name: `${name}-p`,
            namespace: "kaiju-team-finance",
            labels: { "kobe.splittingatom.io/orbit-eval": created.value.id },
          },
        });
        kube.podLogs.set(
          `kaiju-team-finance/${name}-p`,
          report({ attack_success_rate: 0.6, attack_successes: 3 }),
        );
      }
      return created.value.id;
    };
    const lost = await stuck(false);
    const finished = await stuck(true);
    expect(await runner?.sweep()).toBeGreaterThanOrEqual(2);
    expect((await getEval(db, finance, lost))?.status).toBe("errored");
    expect((await getEval(db, finance, finished))?.status).toBe("blocked");
  });
});

describe("shared eval cases in the gate (KOBE-276)", () => {
  /** Cases on `agentId` shared by carol (the member), straight into the table. */
  async function cases(agentId: string, statuses: readonly ("open" | "accepted" | "dismissed")[]) {
    const carol = await h.admin.query<{ id: string }>(
      `SELECT id FROM users WHERE email = 'carol@eval.test'`,
    );
    // Cases count only if shared during the sharer's membership (re-review R1).
    await h.admin.query(
      `UPDATE team_members SET created_at = now() - interval '90 days' WHERE team_id = $1`,
      [finance],
    );
    const ids: string[] = [];
    for (const [i, status] of statuses.entries()) {
      const { rows } = await h.admin.query<{ id: string }>(
        `INSERT INTO agent_eval_cases (team_id, user_id, agent_scope, agent_id, agent_version, content, status, expected_behaviour, reviewed_at, created_at)
         VALUES ($1, $2, 'team', $3, 1, $4::jsonb, $5, $6, CASE WHEN $5 = 'open' THEN NULL ELSE now() END, now() - interval '1 day')
         RETURNING id`,
        [
          finance,
          carol.rows[0]?.id,
          agentId,
          JSON.stringify({
            prompt: `Prompt ${i} (${status})`,
            answer: `Bad answer ${i}`,
            earlier: [],
            tool_outputs: [{ tool: "search", text: `Output ${i}`, is_error: false }],
            attachments: [],
            reasons: ["wrong"],
            comment: `Comment ${i}`,
            truncated: false,
          }),
          status,
          status === "open" ? null : `Expected ${i}`,
        ],
      );
      ids.push(rows[0]?.id ?? "");
    }
    return ids;
  }

  const suite = (results: { id: string; status: "passed" | "failed" | "error" }[]) => ({
    suite: "shared-cases",
    cases: results.length,
    scored: results.filter((r) => r.status !== "error").length,
    failed: results.filter((r) => r.status === "failed").length,
    errors: results.filter((r) => r.status === "error").length,
    failure_rate: null,
    results,
  });

  it("freezes the accepted cases into the Job's inputs and passes when few enough fail", async () => {
    await gateOn(0.5);
    const id = await draft();
    const [open, a, b, dismissed] = await cases(id, ["open", "accepted", "accepted", "dismissed"]);
    jobResult = {
      log: report({
        cases: suite([
          { id: a ?? "", status: "passed" },
          { id: b ?? "", status: "failed" },
        ]),
      }),
      outcome: "Complete",
    };
    expect((await publish(id)).status).toBe(202);
    await settled();
    const { evals: list } = await evals(id);
    expect(list[0]).toMatchObject({
      status: "passed",
      version: 1,
      cases: { total: 2, scored: 2, failed: 1, failureRate: 0.5 },
    });
    const row = await h.admin.query<{ case_ids: string[] }>(
      `SELECT case_ids FROM orbit_evals WHERE id = $1`,
      [list[0].id],
    );
    expect([...(row.rows[0]?.case_ids ?? [])].sort()).toEqual([a, b].sort());
    // No case text in any Kubernetes object (review S2): the ConfigMap holds the agent only, and
    // the Job is told to fetch its cases from the gateway.
    const maps = kube.all("ConfigMap") as unknown as {
      metadata: { name: string };
      data: Record<string, string>;
    }[];
    const map = maps.find((m) => m.metadata.name === `orbit-eval-${list[0].id}`);
    expect(Object.keys(map?.data ?? {})).toEqual(["agent.yaml"]);
    const job = (
      kube.all("Job") as unknown as {
        metadata: { name: string };
        spec: { template: { spec: { containers: { args?: string[] }[] } } };
      }[]
    ).find((j) => j.metadata.name === `orbit-eval-${list[0].id}`);
    expect(job?.spec.template.spec.containers[0]?.args).toEqual([
      "--orbit-yaml",
      "/input/agent.yaml",
      "--output",
      "/output/result.json",
      "--gateway-cases",
    ]);
    expect(JSON.stringify([...kube.all("ConfigMap"), ...kube.all("Job")])).not.toContain(
      "Prompt 1",
    );
    // What the gateway serves the running eval: the accepted, frozen cases only, no member.
    await h.admin.query(
      `UPDATE orbit_evals SET status = 'running', finished_at = NULL, version = NULL WHERE id = $1`,
      [list[0].id],
    );
    // A case of another agent slipped into the frozen ids is never served (re-review R2).
    const [foreign] = await cases(await draft(), ["accepted"]);
    await h.admin.query(`UPDATE orbit_evals SET case_ids = case_ids || $2::uuid WHERE id = $1`, [
      list[0].id,
      foreign,
    ]);
    expect(await loadEvalCaseFile(h.deps.database.db, finance, adminId, list[0].id)).toBeNull();
    const served = await loadEvalCaseFile(h.deps.database.db, finance, builderId, list[0].id);
    expect(served).not.toContain(foreign);
    // One fetch per eval: a token read from the Job spec can't fetch again.
    expect(await loadEvalCaseFile(h.deps.database.db, finance, builderId, list[0].id)).toBeNull();
    await h.admin.query(
      `UPDATE orbit_evals SET status = 'passed', finished_at = now(), version = 1 WHERE id = $1`,
      [list[0].id],
    );
    const file = JSON.parse(served ?? "{}") as {
      suite: string;
      cases: { id: string; prompt: string; expected: string }[];
    };
    expect(file.suite).toBe("shared-cases");
    expect(file.cases.map((c) => c.id)).toEqual(row.rows[0]?.case_ids);
    expect(file.cases).toHaveLength(2);
    expect(file.cases.map((c) => [c.id, c.prompt, c.expected]).sort()).toEqual(
      [
        [a, "Prompt 1 (accepted)", "Expected 1"],
        [b, "Prompt 2 (accepted)", "Expected 2"],
      ].sort(),
    );
    for (const absent of [open, dismissed, "carol", "user_id"])
      expect(served).not.toContain(absent);
    // Only while the eval runs, and only for the member who started it.
    expect(await loadEvalCaseFile(h.deps.database.db, finance, builderId, list[0].id)).toBeNull();
    // The report on the eval holds ids and outcomes only.
    const detail = (await builder.get(`/v1/agents/${id}/evals/${list[0].id}`)).json.eval;
    expect(JSON.stringify(detail.report)).not.toContain("Prompt 1");
  });

  it("blocks when the cases' failure rate is above the threshold, even with no attack", async () => {
    await gateOn(0.2);
    const id = await draft();
    const [a, b] = await cases(id, ["accepted", "accepted"]);
    jobResult = {
      log: report({
        cases: suite([
          { id: a ?? "", status: "passed" },
          { id: b ?? "", status: "failed" },
        ]),
      }),
      outcome: "Complete",
    };
    expect((await publish(id)).status).toBe(202);
    await settled();
    expect((await evals(id)).evals[0]).toMatchObject({
      status: "blocked",
      attackSuccessRate: 0,
      cases: { total: 2, failed: 1, failureRate: 0.5 },
      version: null,
    });
    expect(await currentVersion(id)).toBeNull();
  });

  it("fails closed when a case errored, or the result misses a case", async () => {
    await gateOn(0.5);
    const id = await draft();
    const [a, b] = await cases(id, ["accepted", "accepted"]);
    for (const results of [
      [
        { id: a ?? "", status: "passed" as const },
        { id: b ?? "", status: "error" as const },
      ],
      [{ id: a ?? "", status: "passed" as const }],
    ]) {
      jobResult = { log: report({ cases: suite(results) }), outcome: "Complete" };
      expect((await publish(id)).status).toBe(202);
      await settled();
      expect((await evals(id)).evals[0]).toMatchObject({ status: "errored", version: null });
    }
    // Without cases, a result that claims some is not trusted either.
    const plain = await draft();
    jobResult = {
      log: report({ cases: suite([{ id: randomUUID(), status: "passed" }]) }),
      outcome: "Complete",
    };
    expect((await publish(plain)).status).toBe(202);
    await settled();
    expect((await evals(plain)).evals[0]).toMatchObject({ status: "errored" });
    // A plain eval sends no cases file and no extra arguments.
    const latest = (await evals(plain)).evals[0].id as string;
    const map = (
      kube.all("ConfigMap") as unknown as {
        metadata: { name: string };
        data: Record<string, string>;
      }[]
    ).find((m) => m.metadata.name === `orbit-eval-${latest}`);
    expect(Object.keys(map?.data ?? {})).toEqual(["agent.yaml"]);
  });

  it("leaves out cases nobody can review: the team agent's owner can't build any more (review S1)", async () => {
    await gateOn(0.2);
    const id = await draft();
    await cases(id, ["accepted"]);
    // The owner is demoted; a team admin publishes. No case can block it, as nobody may dismiss it.
    await h.admin.query(
      `UPDATE team_members SET role = 'member' WHERE team_id = $1 AND user_id = $2`,
      [finance, builderId],
    );
    try {
      jobResult = clean();
      const res = await admin.request("POST", `/v1/agents/${id}/publish`, {}, ANY);
      expect(res.status, JSON.stringify(res.json)).toBe(202);
      await settled();
      expect((await admin.get(`/v1/agents/${id}/evals`)).json.evals[0]).toMatchObject({
        status: "passed",
        version: 1,
        cases: { total: 0, scored: null, skipped: { no_reviewer: 1 } },
      });
    } finally {
      await h.admin.query(
        `UPDATE team_members SET role = 'contributor' WHERE team_id = $1 AND user_id = $2`,
        [finance, builderId],
      );
    }
  });
});
