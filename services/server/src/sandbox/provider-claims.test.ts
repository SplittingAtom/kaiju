import { describe, expect, it, vi } from "vitest";
import { IsolationRuntimeMissingError } from "../isolation/gate.js";
import { createFakeKube, simulateAgentSandbox } from "../testing/fake-kube.js";
import {
  OTHER_TEAM,
  OTHER_USER,
  SETTINGS,
  TEAM,
  USER,
  gateFor,
  must,
  seedCluster,
} from "../testing/sandbox-fixtures.js";
import { LABEL_TEAM_ID } from "./constants.js";
import { createSandboxProvider } from "./provider.js";
import { NS, objectAt, recreateRuntimeClass, setup } from "../testing/provider-setup.js";

/**
 * One sandbox per (user, team) and its isolation checks (D11, KOBE-9; split out of
 * provider.test.ts by KOBE-710).
 */

describe("ensureSandbox: one sandbox per (user, team) (D11)", () => {
  it("claims a sandbox whose claim UID is the sandbox id, and returns its pod", async () => {
    const { kube, provider } = setup();
    const handle = await provider.ensureSandbox(TEAM, USER);
    const claim = objectAt(kube, "SandboxClaim", `u-${USER}`, NS);
    expect(handle).toEqual({
      sandboxId: claim?.metadata.uid,
      namespace: NS,
      claimName: `u-${USER}`,
      sandboxName: `u-${USER}`,
      state: "running",
      podName: `u-${USER}`,
    });
  });

  it("returns the same sandbox on repeat calls and gives each user their own", async () => {
    const { kube, provider } = setup();
    const a = await provider.ensureSandbox(TEAM, USER);
    const again = await provider.ensureSandbox(TEAM, USER);
    const b = await provider.ensureSandbox(TEAM, OTHER_USER);
    expect(again.sandboxId).toBe(a.sandboxId);
    expect(b.sandboxId).not.toBe(a.sandboxId);
    expect(kube.calls.filter((c) => c.verb === "create" && c.kind === "SandboxClaim")).toHaveLength(
      2,
    );
  });

  it("puts the same user's sandboxes for two teams in two namespaces", async () => {
    const { provider } = setup();
    const a = await provider.ensureSandbox(TEAM, USER);
    const b = await provider.ensureSandbox(OTHER_TEAM, USER);
    expect([a.namespace, b.namespace]).toEqual(["kobe-team-finance", "kobe-team-marketing"]);
    expect(b.sandboxId).not.toBe(a.sandboxId);
  });

  it("uses the claim another replica created first (409)", async () => {
    const { kube, provider } = setup();
    const winner = createSandboxProvider({
      kube,
      isolation: gateFor(kube),
      settings: SETTINGS,
      sleep: async () => {},
    });
    const first = await winner.ensureSandbox(TEAM, USER);
    // This replica's first get misses the claim, then its create collides (409).
    const original = kube.get.bind(kube);
    let missed = false;
    kube.get = async (r) => {
      if (r.kind === "SandboxClaim" && !missed) {
        missed = true;
        return undefined;
      }
      return original(r);
    };
    const second = await provider.ensureSandbox(TEAM, USER);
    expect(second.sandboxId).toBe(first.sandboxId);
  });

  it("waits for the controller to bind a pod", async () => {
    const { provider } = setup({ controller: { delayGets: 3 } });
    await expect(provider.ensureSandbox(TEAM, USER)).resolves.toMatchObject({ state: "running" });
  });

  it("times out when no pod appears (quota or capacity)", async () => {
    let t = 0;
    const { provider } = setup({
      controller: { noPods: true },
      provider: { now: () => (t += 1000), podWaitTimeoutMs: 5000 },
    });
    await expect(provider.ensureSandbox(TEAM, USER)).rejects.toThrow(/has no pod after 5000 ms/);
  });

  it("reports a hibernated sandbox as suspended without waiting for a pod", async () => {
    const { kube, provider } = setup();
    const { sandboxName } = await provider.ensureSandbox(TEAM, USER);
    const sandbox = must(objectAt(kube, "Sandbox", sandboxName, NS));
    kube.seed({ ...sandbox, spec: { ...(sandbox.spec as object), operatingMode: "Suspended" } });
    await expect(provider.ensureSandbox(TEAM, USER)).resolves.toMatchObject({ state: "suspended" });
  });

  it("refuses a claim whose identity annotations name someone else", async () => {
    const { kube, provider } = setup({ controller: false });
    kube.seed({
      apiVersion: "extensions.agents.x-k8s.io/v1beta1",
      kind: "SandboxClaim",
      metadata: {
        name: `u-${USER}`,
        namespace: NS,
        annotations: { [LABEL_TEAM_ID]: OTHER_TEAM.id, "kobe.splittingatom.io/user-id": USER },
      },
      spec: {},
    });
    await expect(provider.ensureSandbox(TEAM, USER)).rejects.toThrow(/does not belong/);
  });

  it("validates team and user ids before touching the cluster", async () => {
    const { kube, provider } = setup();
    await expect(provider.ensureSandbox({ id: TEAM.id, slug: "Bad_Slug" }, USER)).rejects.toThrow(
      TypeError,
    );
    await expect(provider.ensureSandbox(TEAM, "../x")).rejects.toThrow(TypeError);
    expect(kube.calls).toHaveLength(0);
  });
});

describe("ensureSandbox: isolation (KOBE-9 binding requirements)", () => {
  it("runs a fresh isolation check before every sandbox creation", async () => {
    const kube = createFakeKube();
    seedCluster(kube);
    simulateAgentSandbox(kube);
    const gate = gateFor(kube);
    const require = vi.spyOn(gate, "require");
    const provider = createSandboxProvider({
      kube,
      isolation: gate,
      settings: SETTINGS,
      sleep: async () => {},
    });
    await provider.ensureSandbox(TEAM, USER);
    await provider.ensureSandbox(TEAM, OTHER_USER);
    expect(require).toHaveBeenCalledTimes(2);
  });

  it("creates nothing and returns isolation_runtime_missing (503) without gVisor", async () => {
    const kube = createFakeKube();
    seedCluster(kube, "runc");
    simulateAgentSandbox(kube);
    const provider = createSandboxProvider({
      kube,
      isolation: gateFor(kube),
      settings: SETTINGS,
      sleep: async () => {},
    });
    const err = await provider.ensureSandbox(TEAM, USER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IsolationRuntimeMissingError);
    expect((err as IsolationRuntimeMissingError).status).toBe(503);
    expect((err as IsolationRuntimeMissingError).toResponseBody().code).toBe(
      "isolation_runtime_missing",
    );
    expect(kube.calls.filter((c) => c.verb !== "get" && c.verb !== "list")).toEqual([]);
  });

  it("deletes a sandbox whose pod is not under the verified RuntimeClass", async () => {
    const { kube, provider } = setup({ controller: { podRuntimeClass: () => "runc" } });
    await expect(provider.ensureSandbox(TEAM, USER)).rejects.toThrow(IsolationRuntimeMissingError);
    expect(kube.all("SandboxClaim")).toHaveLength(0);
    expect(kube.all("Sandbox")).toHaveLength(0);
    expect(kube.all("Pod")).toHaveLength(0);
  });

  it("deletes a sandbox when the RuntimeClass handler changed after the check", async () => {
    const { kube, provider } = setup({ controller: { delayGets: 1 } });
    const original = kube.get.bind(kube);
    kube.get = async (r) => {
      const result = await original(r);
      // Swap the handler right after the pod shows up (between require() and the read-back).
      if (r.kind === "Pod" && result) {
        kube.seed({
          apiVersion: "node.k8s.io/v1",
          kind: "RuntimeClass",
          metadata: { name: "gvisor" },
          handler: "runc",
        });
      }
      return result;
    };
    await expect(provider.ensureSandbox(TEAM, USER)).rejects.toThrow(/handler changed/);
    expect(kube.all("SandboxClaim")).toHaveLength(0);
  });

  it("deletes an existing sandbox whose template predates a RuntimeClass change", async () => {
    const { kube, provider } = setup();
    const { sandboxName } = await provider.ensureSandbox(TEAM, USER);
    const sandbox = must(objectAt(kube, "Sandbox", sandboxName, NS));
    const spec = structuredClone(sandbox.spec) as {
      podTemplate: { spec: Record<string, unknown> };
    };
    spec.podTemplate.spec.runtimeClassName = "kata";
    kube.seed({ ...sandbox, spec });
    await expect(provider.ensureSandbox(TEAM, USER)).rejects.toThrow(/template uses "kata"/);
    expect(kube.all("SandboxClaim")).toHaveLength(0);
  });
});

describe("deleting unverified sandboxes", () => {
  it("retries a failed delete and also deletes the pod itself", async () => {
    const { kube, provider } = setup({ controller: { podRuntimeClass: () => "runc" } });
    kube.failNext("delete", "SandboxClaim", 500, 2);
    await expect(provider.ensureSandbox(TEAM, USER)).rejects.toThrow(/was deleted/);
    expect(kube.all("SandboxClaim")).toHaveLength(0);
    expect(kube.calls.filter((c) => c.verb === "delete" && c.kind === "Pod")).toHaveLength(1);
  });

  it("refuses a pod older than its RuntimeClass (class recreated, even with the same name)", async () => {
    const { kube, provider } = setup();
    await provider.ensureSandbox(TEAM, USER);
    recreateRuntimeClass(kube);
    await expect(provider.ensureSandbox(TEAM, USER)).rejects.toThrow(/recreated/);
    expect(kube.all("SandboxClaim")).toHaveLength(0);
  });
});
