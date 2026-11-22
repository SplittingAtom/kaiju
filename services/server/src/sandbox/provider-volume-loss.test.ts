import { describe, expect, it } from "vitest";
import { createFakeKube, simulateAgentSandbox, type FakeKube } from "../testing/fake-kube.js";
import { SETTINGS, TEAM, USER, seedCluster } from "../testing/sandbox-fixtures.js";
import { gateFor } from "../testing/sandbox-fixtures.js";
import { createSandboxProvider, workspacePvcName } from "./provider.js";

/**
 * A workspace volume lost with its node (KOBE-739): detection and the rebuild's Kubernetes half.
 */
const NS = "kobe-team-finance";
const NOW = Date.parse("2026-11-21T12:00:00Z");
const PVC = (name: string) => ({
  apiVersion: "v1",
  kind: "PersistentVolumeClaim",
  name,
  namespace: NS,
});

function setup() {
  const kube = createFakeKube();
  seedCluster(kube);
  simulateAgentSandbox(kube, {});
  const provider = createSandboxProvider({
    kube,
    isolation: gateFor(kube),
    settings: SETTINGS,
    sleep: async () => undefined,
    now: () => NOW,
  });
  return { kube, provider };
}

/** The sandbox's workspace volume, bound to a local PV on `node`. */
function seedLocalVolume(kube: FakeKube, sandboxName: string, node: string): string {
  const name = workspacePvcName(sandboxName);
  kube.seed({
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: { name, namespace: NS },
    spec: { volumeName: `pv-${sandboxName}` },
    status: { phase: "Bound" },
  });
  kube.seed({
    apiVersion: "v1",
    kind: "PersistentVolume",
    metadata: { name: `pv-${sandboxName}` },
    spec: {
      nodeAffinity: {
        required: {
          nodeSelectorTerms: [
            {
              matchExpressions: [{ key: "kubernetes.io/hostname", operator: "In", values: [node] }],
            },
          ],
        },
      },
    },
    status: { phase: "Bound" },
  });
  return name;
}

function seedNode(kube: FakeKube, name: string, ready: "True" | "Unknown", sinceMs = 0) {
  kube.seed({
    apiVersion: "v1",
    kind: "Node",
    metadata: { name, labels: { "kubernetes.io/hostname": name } },
    status: {
      conditions: [
        { type: "Ready", status: ready, lastTransitionTime: new Date(NOW - sinceMs).toISOString() },
      ],
    },
  });
}

/** Puts the sandbox's pod on `node` (as the scheduler would have). */
function placePod(kube: FakeKube, podName: string, node: string) {
  const pod = kube.peek({ apiVersion: "v1", kind: "Pod", name: podName, namespace: NS });
  if (pod) kube.seed({ ...pod, spec: { ...(pod.spec as object), nodeName: node } });
}

describe("volumeHealth (KOBE-739)", () => {
  it("reports a volume whose only node is missing as node_down, and a healthy one as present", async () => {
    const { kube, provider } = setup();
    const handle = await provider.ensureSandbox(TEAM, USER);
    seedLocalVolume(kube, handle.sandboxName, "compute4");
    seedNode(kube, "compute1", "True");

    await expect(provider.volumeHealth(TEAM, USER)).resolves.toMatchObject({
      state: "node_down",
      reason: "node_gone",
      node: "compute4",
    });
    seedNode(kube, "compute4", "True");
    await expect(provider.volumeHealth(TEAM, USER)).resolves.toEqual({ state: "present" });
  });

  it("finds the volume by name after the claim is gone, and is missing without one", async () => {
    const { kube, provider } = setup();
    await expect(provider.volumeHealth(TEAM, USER)).resolves.toEqual({ state: "missing" });
    seedLocalVolume(kube, `u-${USER}`, "compute4");
    await expect(provider.volumeHealth(TEAM, USER)).resolves.toMatchObject({
      state: "node_down",
    });
  });

  it("never reports anything lost, and reads no Node or PV, with detection off", async () => {
    const { kube } = setup();
    const provider = createSandboxProvider({
      kube,
      isolation: gateFor(kube),
      settings: { ...SETTINGS, volumeLoss: { detection: false, graceMinutes: 30 } },
      sleep: async () => undefined,
    });
    seedLocalVolume(kube, `u-${USER}`, "compute4");
    await expect(provider.volumeHealth(TEAM, USER)).resolves.toEqual({ state: "present" });
    expect(kube.calls.some((c) => c.kind === "Node" || c.kind === "PersistentVolume")).toBe(false);
  });
});

describe("discardLostVolume (KOBE-739)", () => {
  it("deletes the claim without keeping the volume, then the volume itself", async () => {
    const { kube, provider } = setup();
    const handle = await provider.ensureSandbox(TEAM, USER);
    const pvc = seedLocalVolume(kube, handle.sandboxName, "compute4");

    const result = await provider.discardLostVolume(TEAM, USER);

    expect(result).toEqual({ sandboxId: handle.sandboxId, pvc });
    expect(kube.all("SandboxClaim")).toHaveLength(0);
    expect(kube.peek(PVC(pvc))).toBeUndefined();
    // Never detached from its owner first: nothing is retained.
    expect(kube.calls.some((c) => c.verb === "patch" && c.kind === "PersistentVolumeClaim")).toBe(
      false,
    );
  });

  it("force-deletes a pod stuck on a missing node (it can never finish terminating)", async () => {
    const { kube, provider } = setup();
    const handle = await provider.ensureSandbox(TEAM, USER);
    seedLocalVolume(kube, handle.sandboxName, "compute4");
    placePod(kube, handle.podName as string, "compute4");

    await provider.discardLostVolume(TEAM, USER);

    const forced = kube.calls.filter(
      (c) => c.verb === "delete" && c.kind === "Pod" && c.gracePeriodSeconds === 0,
    );
    expect(forced).toHaveLength(1);
  });

  it("deletes a pod on a healthy node normally, and force-deletes one on a not-Ready node", async () => {
    const { kube, provider } = setup();
    const handle = await provider.ensureSandbox(TEAM, USER);
    seedLocalVolume(kube, handle.sandboxName, "compute4");
    seedNode(kube, "compute1", "True");
    placePod(kube, handle.podName as string, "compute1");

    await provider.discardLostVolume(TEAM, USER);

    expect(kube.calls.some((c) => c.verb === "delete" && c.gracePeriodSeconds === 0)).toBe(false);

    const again = setup();
    const h2 = await again.provider.ensureSandbox(TEAM, USER);
    seedLocalVolume(again.kube, h2.sandboxName, "compute4");
    seedNode(again.kube, "compute2", "Unknown");
    placePod(again.kube, h2.podName as string, "compute2");
    await again.provider.discardLostVolume(TEAM, USER);
    expect(again.kube.calls.some((c) => c.verb === "delete" && c.gracePeriodSeconds === 0)).toBe(
      true,
    );
  });

  it("is idempotent once everything is gone", async () => {
    const { kube, provider } = setup();
    const handle = await provider.ensureSandbox(TEAM, USER);
    const pvc = seedLocalVolume(kube, handle.sandboxName, "compute4");
    await provider.discardLostVolume(TEAM, USER);
    await expect(provider.discardLostVolume(TEAM, USER)).resolves.toEqual({ pvc });
  });

  it("a node that is not Ready is node_down (the grace period is the lifecycle's)", async () => {
    const { kube, provider } = setup();
    const handle = await provider.ensureSandbox(TEAM, USER);
    seedLocalVolume(kube, handle.sandboxName, "compute4");
    seedNode(kube, "compute4", "Unknown");
    await expect(provider.volumeHealth(TEAM, USER)).resolves.toMatchObject({
      reason: "node_not_ready",
    });
  });

  it("refuses, deleting nothing, a claim newer than the confirmed rebuild (review g72-2)", async () => {
    const { kube, provider } = setup();
    const handle = await provider.ensureSandbox(TEAM, USER);
    const pvc = seedLocalVolume(kube, handle.sandboxName, "compute4");
    const claim = kube.all("SandboxClaim")[0];
    const created = Date.parse(claim?.metadata.creationTimestamp ?? "");

    // Marked before the claim was created: a fresh sandbox, never deleted.
    const early = { claimUid: handle.sandboxId, notCreatedAfter: new Date(created - 1000) };
    await expect(provider.discardLostVolume(TEAM, USER, early)).resolves.toEqual({
      pvc,
      refused: "newer_claim",
    });
    // Another UID than recorded, created just before the mark (clock skew margin): refused.
    const other = { claimUid: crypto.randomUUID(), notCreatedAfter: new Date(created + 60_000) };
    await expect(provider.discardLostVolume(TEAM, USER, other)).resolves.toMatchObject({
      refused: "newer_claim",
    });
    expect(kube.all("SandboxClaim")).toHaveLength(1);
    expect(kube.peek(PVC(pvc))).toBeDefined();
    expect(kube.calls.some((c) => c.verb === "delete")).toBe(false);

    // The recorded claim, created before the mark: deleted.
    const ok = { claimUid: handle.sandboxId, notCreatedAfter: new Date(created + 60_000) };
    await expect(provider.discardLostVolume(TEAM, USER, ok)).resolves.toEqual({
      sandboxId: handle.sandboxId,
      pvc,
    });
    expect(kube.all("SandboxClaim")).toHaveLength(0);
  });

  it("a leftover discard after a retry and a same-named new claim deletes nothing (review g72-3)", async () => {
    const kube = createFakeKube();
    seedCluster(kube);
    simulateAgentSandbox(kube, {});
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let gated = false;
    const provider = createSandboxProvider({
      kube,
      isolation: gateFor(kube),
      settings: SETTINGS,
      // The first retry wait of the leftover discard is held until the new claim exists.
      sleep: async () => {
        if (!gated) {
          gated = true;
          await gate;
        }
      },
      now: () => NOW,
    });
    const old = await provider.ensureSandbox(TEAM, USER);
    const pvc = seedLocalVolume(kube, old.sandboxName, "compute4");
    kube.failNext("delete", "SandboxClaim", 500, 1);
    const leftover = provider.discardLostVolume(TEAM, USER);
    await new Promise((r) => setTimeout(r, 10));
    // Meanwhile a retry deleted the old claim and volume, and the member woke a new sandbox
    // under the same names.
    await kube.delete({ ...PVC(pvc) });
    await kube.delete({
      apiVersion: "extensions.agents.x-k8s.io/v1beta1",
      kind: "SandboxClaim",
      name: `u-${USER}`,
      namespace: NS,
    });
    const fresh = await provider.ensureSandbox(TEAM, USER);
    seedLocalVolume(kube, fresh.sandboxName, "compute1");
    const freshPvcUid = kube.peek(PVC(pvc))?.metadata.uid;
    release();

    await expect(leftover).resolves.toMatchObject({ refused: "replaced" });
    expect(kube.all("SandboxClaim").map((c) => c.metadata.uid)).toEqual([fresh.sandboxId]);
    expect(kube.peek(PVC(pvc))?.metadata.uid).toBe(freshPvcUid);
  });

  it("an aborted discard stops its retries", async () => {
    const kube = createFakeKube();
    seedCluster(kube);
    simulateAgentSandbox(kube, {});
    const controller = new AbortController();
    const provider = createSandboxProvider({
      kube,
      isolation: gateFor(kube),
      settings: SETTINGS,
      sleep: async () => controller.abort(),
      now: () => NOW,
    });
    const handle = await provider.ensureSandbox(TEAM, USER);
    seedLocalVolume(kube, handle.sandboxName, "compute4");
    kube.failNext("delete", "SandboxClaim", 500, 10);
    await expect(
      provider.discardLostVolume(TEAM, USER, undefined, controller.signal),
    ).rejects.toThrow(/stopped/);
    expect(kube.calls.filter((c) => c.verb === "delete")).toHaveLength(1);
    expect(kube.all("SandboxClaim")).toHaveLength(1);
  });

  it("every delete of the discard names the object's UID", async () => {
    const { kube, provider } = setup();
    const handle = await provider.ensureSandbox(TEAM, USER);
    seedLocalVolume(kube, handle.sandboxName, "compute4");
    await provider.discardLostVolume(TEAM, USER);
    const deletes = kube.calls.filter((c) => c.verb === "delete");
    expect(deletes.length).toBeGreaterThan(0);
    expect(deletes.every((c) => typeof c.uid === "string")).toBe(true);
  });
});
