import { POD_SCOPED_QUOTA_KEYS } from "./eval-quota.js";
import { describe, expect, it } from "vitest";
import { OTHER_TEAM, OTHER_USER, SETTINGS, TEAM, USER } from "../testing/sandbox-fixtures.js";
import { LABEL_TEAM_ID, LABEL_TEAM_NAMESPACE } from "./constants.js";
import {
  ADMISSION_PROBE_NAMESPACE,
  SandboxProvisioningError,
  TEAM_RECONVERGE_MS,
} from "./provider.js";
import { NS, objectAt, setup } from "../testing/provider-setup.js";

/**
 * Team namespaces and the admission self-check (KOBE-22, KOBE-115; split out of provider.test.ts
 * by KOBE-710).
 */

describe("ensureSandbox: team namespace (D11)", () => {
  it("creates the team namespace with its team id and Pod Security 'baseline' (KOBE-71)", async () => {
    const { kube, provider } = setup();
    await provider.ensureSandbox(TEAM, USER);
    const ns = objectAt(kube, "Namespace", NS);
    expect(ns?.metadata.labels).toMatchObject({
      [LABEL_TEAM_ID]: TEAM.id,
      [LABEL_TEAM_NAMESPACE]: "true",
      "pod-security.kubernetes.io/enforce": "baseline",
      "pod-security.kubernetes.io/warn": "restricted",
      "pod-security.kubernetes.io/audit": "restricted",
    });
  });

  it("binds the server to the manager ClusterRole in that namespace only", async () => {
    const { kube, provider } = setup();
    await provider.ensureSandbox(TEAM, USER);
    const bindings = kube.all("RoleBinding");
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      metadata: { namespace: NS },
      roleRef: { kind: "ClusterRole", name: SETTINGS.managerClusterRole },
      subjects: [{ kind: "ServiceAccount", name: "kaiju-server", namespace: "kaiju" }],
    });
  });

  it("applies the default-deny NetworkPolicy before anything that can start a pod", async () => {
    const { kube, provider } = setup();
    await provider.ensureSandbox(TEAM, USER);
    const writes = kube.calls.filter((c) => c.verb === "apply" || c.verb === "create");
    const at = (kind: string) => writes.findIndex((c) => c.kind === kind);
    expect(at("NetworkPolicy")).toBeGreaterThan(-1);
    for (const kind of ["SandboxTemplate", "SandboxWarmPool", "SandboxClaim"]) {
      expect(at("NetworkPolicy")).toBeLessThan(at(kind));
    }
  });

  it("puts a quota, container defaults, the sandbox ServiceAccount, template and warm pool there", async () => {
    const { kube, provider } = setup();
    await provider.ensureSandbox(TEAM, USER);
    // The members' quota plus the skill-eval share: 4 eval pods (KOBE-325).
    const gi = (n: number) => String(n * 2 ** 30);
    expect(objectAt(kube, "ResourceQuota", "kobe-team-quota", NS)?.spec).toEqual({
      hard: {
        ...SETTINGS.teamQuota,
        "requests.cpu": "22",
        "requests.memory": gi(44),
        "limits.cpu": "48",
        "limits.memory": gi(96),
        "requests.ephemeral-storage": gi(44),
        "limits.ephemeral-storage": gi(176),
        ...(SETTINGS.teamQuota.pods ? { pods: String(Number(SETTINGS.teamQuota.pods) + 4) } : {}),
      },
    });
    expect(objectAt(kube, "ResourceQuota", "kobe-skill-eval-quota", NS)?.spec).toEqual({
      hard: {
        pods: "4",
        "requests.cpu": "2",
        "requests.memory": gi(4),
        "limits.cpu": "8",
        "limits.memory": gi(16),
      },
      scopeSelector: {
        matchExpressions: [
          { scopeName: "PriorityClass", operator: "In", values: ["kobe-skill-eval"] },
        ],
      },
    });
    // Members stay within teamQuota (pod count, CPU and memory only: the PriorityClass scope
    // allows nothing else, ephemeral storage included).
    expect(objectAt(kube, "ResourceQuota", "kobe-team-member-quota", NS)?.spec).toEqual({
      hard: Object.fromEntries(
        Object.entries(SETTINGS.teamQuota).filter(([k]) => POD_SCOPED_QUOTA_KEYS.has(k)),
      ),
      scopeSelector: {
        matchExpressions: [
          { scopeName: "PriorityClass", operator: "NotIn", values: ["kobe-skill-eval"] },
        ],
      },
    });
    const evalTemplate = objectAt(kube, "SandboxTemplate", "kobe-skill-eval", NS);
    expect(evalTemplate?.spec).toMatchObject({
      podTemplate: {
        metadata: { labels: { "kobe.splittingatom.io/skill-eval": "true" } },
        spec: {
          runtimeClassName: "gvisor",
          priorityClassName: "kobe-skill-eval",
          volumes: expect.arrayContaining([{ name: "workspace", emptyDir: { sizeLimit: "2Gi" } }]),
        },
      },
    });
    expect(JSON.stringify(evalTemplate?.spec)).not.toContain('volumeClaimTemplates":[');
    expect(JSON.stringify(evalTemplate?.spec)).toContain(
      '{"name":"KAIJU_WORKSPACE_SYNC_INTERVAL_MS","value":"0"}',
    );
    expect(objectAt(kube, "SandboxWarmPool", "kobe-skill-eval", NS)?.spec).toMatchObject({
      replicas: 0,
      sandboxTemplateRef: { name: "kobe-skill-eval" },
    });
    expect(objectAt(kube, "LimitRange", "kobe-sandbox-defaults", NS)).toBeDefined();
    expect(objectAt(kube, "ServiceAccount", "kobe-sandbox", NS)).toMatchObject({
      automountServiceAccountToken: false,
    });
    const template = objectAt(kube, "SandboxTemplate", "kobe-sandbox", NS);
    expect(template?.spec).toMatchObject({
      networkPolicyManagement: "Unmanaged",
      podTemplate: {
        spec: {
          runtimeClassName: "gvisor",
          hostAliases: expect.arrayContaining([
            { ip: "10.43.0.10", hostnames: ["server.kaiju.internal"] },
          ]),
        },
      },
    });
    expect(objectAt(kube, "SandboxWarmPool", "kobe-sandbox", NS)?.spec).toMatchObject({
      replicas: 1,
      sandboxTemplateRef: { name: "kobe-sandbox" },
    });
  });

  it("refuses a namespace that is labelled for another team (no volume reuse)", async () => {
    const { kube, provider } = setup();
    kube.seed({
      apiVersion: "v1",
      kind: "Namespace",
      metadata: { name: NS, labels: { [LABEL_TEAM_ID]: OTHER_TEAM.id } },
    });
    await expect(provider.ensureSandbox(TEAM, USER)).rejects.toThrow(SandboxProvisioningError);
    expect(kube.all("SandboxClaim")).toHaveLength(0);
  });

  it("refuses a pre-existing unlabelled namespace with the same name", async () => {
    const { kube, provider } = setup();
    kube.seed({ apiVersion: "v1", kind: "Namespace", metadata: { name: NS } });
    await expect(provider.ensureSandbox(TEAM, USER)).rejects.toThrow(/not labelled for team/);
  });

  it("retries while a fresh RoleBinding reaches the authorizer (403)", async () => {
    const { kube, provider } = setup();
    kube.failNext("apply", "NetworkPolicy", 403, 2);
    await expect(provider.ensureSandbox(TEAM, USER)).resolves.toMatchObject({ state: "running" });
  });

  it("names Rancher's namespace webhook and the chart value when Rancher refuses the namespace", async () => {
    const { kube, provider } = setup();
    kube.failNext(
      "apply",
      "Namespace",
      400,
      1,
      `Kubernetes API apply Namespace ${NS}: admission webhook ` +
        `"rancher.cattle.io.namespaces.create-non-kubesystem" denied the request: Unauthorized`,
    );
    const err = await provider.ensureSandbox(TEAM, USER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxProvisioningError);
    expect(String(err)).toMatch(/rancher\.cattle\.io\.namespaces/);
    expect(String(err)).toMatch(/rancher\.enabled=true/);
    expect(String(err)).toMatch(/updatepsa/);
    expect(kube.all("SandboxClaim")).toHaveLength(0);
  });

  it("passes other namespace failures through unchanged", async () => {
    const { kube, provider } = setup();
    kube.failNext("apply", "Namespace", 500);
    const err = await provider.ensureSandbox(TEAM, USER).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(SandboxProvisioningError);
    expect(String(err)).toMatch(/injected 500/);
  });

  it("gives up on a persistent 403 without creating any sandbox", async () => {
    const { kube, provider } = setup();
    kube.failNext("apply", "NetworkPolicy", 403, 100);
    await expect(provider.ensureSandbox(TEAM, USER)).rejects.toThrow(/403/);
    expect(kube.all("SandboxClaim")).toHaveLength(0);
    expect(kube.all("SandboxTemplate")).toHaveLength(0);
  });

  it("converges a team once per process, and retries after a failure", async () => {
    const { kube, provider } = setup();
    kube.failNext("apply", "ResourceQuota", 500);
    await expect(provider.ensureSandbox(TEAM, USER)).rejects.toThrow();
    await provider.ensureSandbox(TEAM, USER);
    await provider.ensureSandbox(TEAM, OTHER_USER);
    const quotaApplies = kube.calls.filter(
      (c) => c.verb === "apply" && c.kind === "ResourceQuota" && c.name === "kobe-team-quota",
    );
    expect(quotaApplies).toHaveLength(2);
  });

  it("re-converges a team after TEAM_RECONVERGE_MS (repairs a deleted NetworkPolicy)", async () => {
    let t = 0;
    const { kube, provider } = setup({ provider: { now: () => t } });
    await provider.ensureSandbox(TEAM, USER);
    await kube.delete({
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      name: "kobe-sandbox-isolation",
      namespace: NS,
    });
    await provider.ensureSandbox(TEAM, USER);
    expect(objectAt(kube, "NetworkPolicy", "kobe-sandbox-isolation", NS)).toBeUndefined();
    t += TEAM_RECONVERGE_MS;
    await provider.ensureSandbox(TEAM, USER);
    expect(objectAt(kube, "NetworkPolicy", "kobe-sandbox-isolation", NS)).toBeDefined();
  });

  it("copies image pull Secrets into the team namespace for the kubelet", async () => {
    const settings = { ...SETTINGS, imagePullSecrets: ["ghcr-pull"] };
    const { kube, provider } = setup({ settings });
    kube.seed({
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "ghcr-pull", namespace: "kaiju", labels: { other: "x" } },
      type: "kubernetes.io/dockerconfigjson",
      data: { ".dockerconfigjson": "e30=" },
    });
    await provider.ensureSandbox(TEAM, USER);
    expect(objectAt(kube, "Secret", "ghcr-pull", NS)).toMatchObject({
      type: "kubernetes.io/dockerconfigjson",
      data: { ".dockerconfigjson": "e30=" },
      metadata: { labels: { "app.kubernetes.io/managed-by": "kobe-server" } },
    });
    const template = objectAt(kube, "SandboxTemplate", "kobe-sandbox", NS);
    expect(template?.spec).toMatchObject({
      podTemplate: { spec: { imagePullSecrets: [{ name: "ghcr-pull" }] } },
    });
  });

  it("fails clearly when a pull Secret or a Service ClusterIP is missing", async () => {
    const withSecret = setup({ settings: { ...SETTINGS, imagePullSecrets: ["missing"] } });
    await expect(withSecret.provider.ensureSandbox(TEAM, USER)).rejects.toThrow(/missing/);
    const { kube, provider } = setup();
    kube.seed({
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: "kaiju-bifrost", namespace: "kaiju" },
      spec: { clusterIP: "None" },
    });
    await expect(provider.ensureSandbox(TEAM, USER)).rejects.toThrow(/no ClusterIP/);
  });
});

describe("admission self-check (fail closed)", () => {
  it("dry-runs an out-of-prefix namespace once and provisions when the policy refuses it", async () => {
    const { kube, provider } = setup();
    await provider.ensureSandbox(TEAM, USER);
    await provider.ensureSandbox(OTHER_TEAM, USER);
    const probes = kube.calls.filter((c) => c.verb === "create" && c.kind === "Namespace");
    expect(probes).toEqual([
      {
        verb: "create",
        kind: "Namespace",
        name: ADMISSION_PROBE_NAMESPACE,
        labels: expect.any(Object),
      },
    ]);
  });

  it("refuses to provision anything when the admission policy is not in effect", async () => {
    const { kube, provider } = setup();
    kube.dryRun = (o) => o;
    await expect(provider.ensureSandbox(TEAM, USER)).rejects.toThrow(
      /admission policies are not in effect/,
    );
    expect(kube.all("Namespace")).toHaveLength(0);
    expect(kube.all("SandboxClaim")).toHaveLength(0);
  });

  it("refuses when the dry run fails for any other reason (e.g. RBAC), and retries later", async () => {
    const { kube, provider } = setup();
    kube.dryRun = () => {
      throw new Error("namespaces is forbidden");
    };
    await expect(provider.ensureSandbox(TEAM, USER)).rejects.toThrow(/forbidden/);
    delete kube.dryRun;
    await expect(provider.ensureSandbox(TEAM, USER)).resolves.toMatchObject({ state: "running" });
  });
});
