// Shared setup for the orbit-eval.*.db.test.ts files (split from orbit-eval.db.test.ts, KOBE-725).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect } from "vitest";
import { EvalRunner } from "./eval/service.js";
import type { SandboxSettings } from "../sandbox/config.js";
import type { KubeObject } from "../sandbox/manifests.js";
import { createFakeKube, type FakeKube } from "../testing/fake-kube.js";
import { openHarness, type Harness } from "../testing/harness.js";
import type { TestBrowser } from "../testing/browser.js";
import { KEYS, SETTINGS, gateFor, seedCluster } from "../testing/sandbox-fixtures.js";

/**
 * The pre-publish eval gate (KOBE-93) end to end on a fake cluster: the Job's result is
 * simulated (what the eval image prints), everything else is real: settings, the Publish route,
 * the Job manifest, the gateway token, the verdict, the publish that follows a pass, retries.
 */
export const ANY = { "if-match": "*" };
export const finance = randomUUID();
export const sandbox: SandboxSettings = {
  ...SETTINGS,
  modelGatewayAccess: true,
  orbitEval: {
    image: "ghcr.io/splittingatom/kaiju-orbit-eval:0.1.0",
    deadlineSeconds: 600,
    resources: { requests: { cpu: "250m", memory: "512Mi" }, limits: { cpu: "1", memory: "2Gi" } },
  },
};

export let h: Harness;
export let kube: FakeKube;
export let admin: TestBrowser;
export let builder: TestBrowser;
export let member: TestBrowser;
export let adminId: string;
export let builderId: string;
/** What the simulated eval Job does when it is created: its log and how it ends. */
export type JobResult = { log: string; outcome: "Complete" | "Failed"; reason?: string } | "hang";
/**
 * State each test file owns because its tests assign it (`jobResult = ...`, `gateOpen = false`):
 * the shared fakes read it through these accessors, and `reset` restores it before each test.
 */
export interface OrbitEvalKnobs {
  jobResult(): JobResult;
  gateOpen(): boolean;
  reset(): void;
}
let knobs: OrbitEvalKnobs;
export let runner: EvalRunner | undefined;

export const report = (over: Record<string, unknown> = {}) =>
  `ok: 5 scenarios\n${JSON.stringify(
    {
      schema_version: 1,
      attack_success_rate: 0,
      attempts: 5,
      attack_successes: 0,
      errors: 0,
      pack: { id: "kaiju-default", version: 1 },
      ...over,
    },
    null,
    2,
  )}\n`;
export const clean = () => ({ log: report(), outcome: "Complete" as const });
export const attacked = () => ({
  log: report({ attack_success_rate: 0.6, attack_successes: 3 }),
  outcome: "Complete" as const,
});

/** The cluster as the Job controller would leave it after the server creates the Job. */
export function finishJob(fake: FakeKube, object: KubeObject): void {
  {
    const jobResult = knobs.jobResult();
    if (object.kind !== "Job" || jobResult === "hang") return;
    const ns = object.metadata.namespace as string;
    const evalId = object.metadata.labels?.["kobe.splittingatom.io/orbit-eval"] as string;
    const podName = `${object.metadata.name}-x7k2p`;
    fake.seed({
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: podName,
        namespace: ns,
        labels: { "kobe.splittingatom.io/orbit-eval": evalId },
      },
    });
    fake.podLogs.set(`${ns}/${podName}`, jobResult.log);
    fake.seed({
      ...object,
      status: {
        conditions: [
          {
            type: jobResult.outcome,
            status: "True",
            ...(jobResult.reason ? { reason: jobResult.reason } : {}),
          },
        ],
      },
    });
  }
}

export const simulateJobController = (fake: FakeKube): void => {
  fake.afterWrite = (object) => finishJob(fake, object);
};

export const gateOn = async (maxAttackSuccessRate?: number) => {
  const res = await admin.put("/v1/team/eval-settings", {
    enabled: true,
    ...(maxAttackSuccessRate === undefined ? {} : { maxAttackSuccessRate }),
  });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
};

export async function draft(scope: "team" | "personal" = "team"): Promise<string> {
  const created = await builder.post("/v1/agents", {
    scope,
    frontmatter: { name: `Gated ${randomUUID().slice(0, 6)}` },
    prompt: "You are careful.",
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  return created.json.agent.id as string;
}

export const publish = (id: string) => builder.request("POST", `/v1/agents/${id}/publish`, {}, ANY);
export const evals = async (id: string) => (await builder.get(`/v1/agents/${id}/evals`)).json;
export const settled = async () => {
  await h.deps.background.idle();
};
export const currentVersion = async (id: string) =>
  (
    await h.admin.query<{ current_version: number | null }>(
      `SELECT current_version FROM team_agents WHERE id = $1`,
      [id],
    )
  ).rows[0]?.current_version;

/**
 * Registers the shared hooks; call once at the top level of each orbit-eval.*.db.test.ts file
 * with its knobs.
 */
export function useOrbitEvalHarness(fileKnobs: OrbitEvalKnobs): void {
  knobs = fileKnobs;
  beforeAll(async () => {
    kube = createFakeKube();
    seedCluster(kube);
    simulateJobController(kube);
    const isolation = gateFor(kube);
    h = await openHarness(
      { agents: { publishRate: { windowMs: 60_000, max: 10_000 } } },
      (deps) => {
        runner = new EvalRunner({
          db: deps.database.db,
          kube,
          provider: { ensureTeam: async () => "kaiju-team-finance" },
          isolation: {
            require: () =>
              knobs.gateOpen()
                ? isolation.require()
                : isolation.require().then(() => {
                    throw new Error("no isolation");
                  }),
          },
          settings: sandbox,
          sessionKeys: KEYS,
          pollMs: 1,
        });
        return { evals: runner };
      },
    );
    adminId = await h.createUser("alice@eval.test");
    builderId = await h.createUser("bob@eval.test");
    const memberId = await h.createUser("carol@eval.test");
    await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, 'finance', 'Finance')`, [
      finance,
    ]);
    for (const [id, role] of [
      [adminId, "team_admin"],
      [builderId, "contributor"],
      [memberId, "member"],
    ] as const) {
      await h.admin.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3)`, [
        finance,
        id,
        role,
      ]);
    }
    await h.admin.query(
      `INSERT INTO model_providers (id, kind, name, api_key_enc, created_by)
       VALUES ('anthropic', 'anthropic', 'anthropic', 'v2.test.sealed-provider-key', $1)`,
      [adminId],
    );
    await h.admin.query(
      `INSERT INTO model_catalog (alias, provider_id, model, created_by) VALUES ('smart', 'anthropic', 'claude-smart', $1)`,
      [adminId],
    );
    await h.admin.query(
      `INSERT INTO team_models (team_id, alias, is_default, enabled_by) VALUES ($1, 'smart', true, $2)`,
      [finance, adminId],
    );
    for (const [who, name] of [
      ["alice", "admin"],
      ["bob", "contributor"],
      ["carol", "member"],
    ] as const) {
      const b = await h.signIn(`${who}@eval.test`);
      expect((await b.put("/v1/me/teams/active", { teamId: finance })).status).toBe(200);
      b.team = finance;
      if (name === "admin") admin = b;
      else if (name === "contributor") builder = b;
      else member = b;
    }
  });

  afterAll(async () => {
    await h?.close();
  });

  beforeEach(async () => {
    knobs.reset();
    await h.admin.query(`DELETE FROM team_eval_settings`);
  });
}
