import { AUDIT_EVENTS } from "@kaiju/db";
import { describe, expect, it } from "vitest";
import { IsolationRuntimeMissingError } from "../isolation/gate.js";
import { OTHER_TEAM, SETTINGS, TEAM, USER, must } from "../testing/sandbox-fixtures.js";
import { createSandboxProvider, type SandboxAuditEvent } from "./provider.js";
import { NS, objectAt, recreateRuntimeClass, setup } from "../testing/provider-setup.js";

/**
 * The isolation reconciler, audit events and liveness (KOBE-9, KOBE-15, KOBE-24; split out of
 * provider.test.ts by KOBE-710).
 */

describe("reconcileIsolation", () => {
  async function twoSandboxes() {
    const ctx = setup({ provider: { runtimeClassName: "gvisor" } });
    const a = await ctx.provider.ensureSandbox(TEAM, USER);
    const b = await ctx.provider.ensureSandbox(OTHER_TEAM, USER);
    return { ...ctx, a, b };
  }

  it("leaves verified pods alone", async () => {
    const { kube, provider } = await twoSandboxes();
    await expect(provider.reconcileIsolation()).resolves.toEqual({ deleted: [] });
    expect(kube.all("Pod")).toHaveLength(2);
  });

  it("deletes a team pod under another runtime, with its claim", async () => {
    const { kube, provider, a } = await twoSandboxes();
    const pod = must(objectAt(kube, "Pod", must(a.podName), NS));
    kube.seed({ ...pod, spec: { ...(pod.spec as object), runtimeClassName: "runc" } });
    const result = await provider.reconcileIsolation();
    expect(result.deleted).toEqual([`${NS}/${a.podName}`]);
    expect(kube.all("SandboxClaim").map((c) => c.metadata.namespace)).toEqual([
      "kobe-team-marketing",
    ]);
  });

  it("deletes pods that predate a recreated RuntimeClass", async () => {
    const { kube, provider } = await twoSandboxes();
    recreateRuntimeClass(kube);
    expect((await provider.reconcileIsolation()).deleted).toHaveLength(2);
  });

  it("stops every team pod but keeps claims when isolation is definitively lost", async () => {
    const { kube, provider } = await twoSandboxes();
    recreateRuntimeClass(kube, "runc");
    const result = await provider.reconcileIsolation();
    expect(result).toMatchObject({ reason: expect.stringMatching(/no longer isolates/) });
    expect(result.deleted).toHaveLength(2);
    expect(kube.all("Pod")).toHaveLength(0);
    expect(kube.all("SandboxClaim")).toHaveLength(2);
  });

  it("changes nothing when isolation cannot be checked (API errors are not evidence)", async () => {
    const { kube, provider } = await twoSandboxes();
    const failing = createSandboxProvider({
      kube,
      settings: SETTINGS,
      runtimeClassName: "gvisor",
      sleep: async () => {},
      isolation: {
        require: async () => {
          throw new IsolationRuntimeMissingError("Kubernetes API timed out");
        },
      },
    });
    // The class itself still isolates: a transient failure, not a loss.
    await expect(failing.reconcileIsolation()).resolves.toEqual({ deleted: [] });
    kube.failNext("get", "RuntimeClass", 500);
    await expect(failing.reconcileIsolation()).rejects.toThrow(/500/);
    expect(kube.all("Pod")).toHaveLength(2);
    expect(provider).toBeDefined();
  });

  it("ignores pods outside team namespaces", async () => {
    const { kube, provider } = await twoSandboxes();
    kube.seed({
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: "x", namespace: "default" },
      spec: { runtimeClassName: "runc" },
    });
    expect((await provider.reconcileIsolation()).deleted).toEqual([]);
  });
});

describe("audit events (KOBE-15 taxonomy)", () => {
  function audited(opts: Parameters<typeof setup>[0] = {}) {
    const events: SandboxAuditEvent[] = [];
    const ctx = setup({
      ...opts,
      provider: { ...opts.provider, audit: (e) => void events.push(e) },
    });
    return { ...ctx, events };
  }
  const valid = (e: SandboxAuditEvent) =>
    expect(AUDIT_EVENTS[e.action].target.safeParse(e.target).success).toBe(true);

  it("records sandbox.created once per new claim, with an allowlisted target", async () => {
    const { provider, events } = audited();
    const { sandboxId } = await provider.ensureSandbox(TEAM, USER);
    await provider.ensureSandbox(TEAM, USER);
    expect(events).toEqual([
      { action: "sandbox.created", teamId: TEAM.id, target: { sandboxId, userId: USER } },
    ]);
    events.forEach(valid);
  });

  it("records sandbox.destroyed when an unverified sandbox is deleted", async () => {
    const { provider, events } = audited({ controller: { podRuntimeClass: () => "runc" } });
    await expect(provider.ensureSandbox(TEAM, USER)).rejects.toThrow(IsolationRuntimeMissingError);
    expect(events.map((e) => e.action)).toEqual(["sandbox.created", "sandbox.destroyed"]);
    expect(events[1]).toMatchObject({
      teamId: TEAM.id,
      target: { userId: USER, reason: "isolation_mismatch", pod: `u-${USER}` },
    });
    events.forEach(valid);
  });

  it("records isolation_lost for pods the reconciler stops", async () => {
    const { kube, provider, events } = audited({ provider: { runtimeClassName: "gvisor" } });
    await provider.ensureSandbox(TEAM, USER);
    recreateRuntimeClass(kube, "runc");
    await provider.reconcileIsolation();
    const destroyed = events.filter((e) => e.action === "sandbox.destroyed");
    expect(destroyed).toHaveLength(1);
    expect(destroyed[0]).toMatchObject({ teamId: TEAM.id, target: { reason: "isolation_lost" } });
    events.forEach(valid);
  });

  it("keeps working when recording fails", async () => {
    const { provider } = setup({
      provider: {
        audit: () => {
          throw new Error("audit down");
        },
      },
    });
    await expect(provider.ensureSandbox(TEAM, USER)).resolves.toMatchObject({ state: "running" });
  });
});

describe("isLive (sandbox wire liveness, KOBE-24)", () => {
  it("is true only for the current claim UID of that team and user", async () => {
    const { kube, provider } = setup();
    const handle = await provider.ensureSandbox(TEAM, USER);
    expect(await provider.isLive(TEAM, USER, handle.sandboxId)).toBe(true);
    expect(await provider.isLive(TEAM, USER, "00000000-0000-4000-8000-0000000000aa")).toBe(false);
    const other = "11111111-1111-4111-8111-111111111111";
    expect(await provider.isLive(TEAM, other, handle.sandboxId)).toBe(false);
    expect(await provider.isLive({ ...TEAM, id: other }, USER, handle.sandboxId)).toBe(false);
    const claim = kube.all("SandboxClaim")[0];
    if (!claim) throw new Error("no claim");
    kube.seed({
      ...claim,
      metadata: { ...claim.metadata, deletionTimestamp: new Date().toISOString() },
    });
    expect(await provider.isLive(TEAM, USER, handle.sandboxId)).toBe(false);
  });
});
