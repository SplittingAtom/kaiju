import { describe, expect, it } from "vitest";
import { createFakeKube, simulateAgentSandbox, type FakeKube } from "../testing/fake-kube.js";
import { SETTINGS, TEAM, USER, seedCluster } from "../testing/sandbox-fixtures.js";
import { gateFor } from "../testing/sandbox-fixtures.js";
import { createSandboxProvider, workspacePvcName } from "./provider.js";
import { NODE_LOST_AFTER_MS } from "./volume-loss.js";

/** A workspace volume lost with its node (KOBE-739): detection and the rebuild's Kubernetes half. */
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
  it("reports a volume whose only node is gone as lost, and a healthy one as present", async () => {
    const { kube, provider } = setup();
    const handle = await provider.ensureSandbox(TEAM, USER);
    seedLocalVolume(kube, handle.sandboxName, "compute4");
    seedNode(kube, "compute1", "True");

    await expect(provider.volumeHealth(TEAM, USER)).resolves.toMatchObject({
      state: "lost",
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
    await expect(provider.volumeHealth(TEAM, USER)).resolves.toMatchObject({ state: "lost" });
  });
});

describe("discardLostVolume (KOBE-739)", () => {
  it("deletes the claim without keeping the volume, then the volume itself", async () => {
    const { kube, provider } = setup();
    const handle = await provider.ensureSandbox(TEAM, USER);
    const pvc = seedLocalVolume(kube, handle.sandboxName, "compute4");

    const result = await provider.discardLostVolume(TEAM, USER, "compute4");

    expect(result).toEqual({ sandboxId: handle.sandboxId, pvc });
    expect(kube.all("SandboxClaim")).toHaveLength(0);
    expect(kube.peek(PVC(pvc))).toBeUndefined();
    // Never detached from its owner first: nothing is retained.
    expect(kube.calls.some((c) => c.verb === "patch" && c.kind === "PersistentVolumeClaim")).toBe(
      false,
    );
  });

  it("force-deletes a pod stuck on the lost node (it can never finish terminating)", async () => {
    const { kube, provider } = setup();
    const handle = await provider.ensureSandbox(TEAM, USER);
    seedLocalVolume(kube, handle.sandboxName, "compute4");
    placePod(kube, handle.podName as string, "compute4");

    await provider.discardLostVolume(TEAM, USER, "compute4");

    const forced = kube.calls.filter(
      (c) => c.verb === "delete" && c.kind === "Pod" && c.gracePeriodSeconds === 0,
    );
    expect(forced).toHaveLength(1);
  });

  it("deletes a pod on a healthy node normally", async () => {
    const { kube, provider } = setup();
    const handle = await provider.ensureSandbox(TEAM, USER);
    seedLocalVolume(kube, handle.sandboxName, "compute4");
    placePod(kube, handle.podName as string, "compute1");

    await provider.discardLostVolume(TEAM, USER, "compute4");

    expect(kube.calls.some((c) => c.verb === "delete" && c.gracePeriodSeconds === 0)).toBe(false);
  });

  it("is idempotent once everything is gone", async () => {
    const { kube, provider } = setup();
    const handle = await provider.ensureSandbox(TEAM, USER);
    const pvc = seedLocalVolume(kube, handle.sandboxName, "compute4");
    await provider.discardLostVolume(TEAM, USER, undefined);
    await expect(provider.discardLostVolume(TEAM, USER, undefined)).resolves.toEqual({ pvc });
  });

  it("node not Ready for the whole grace period counts as lost", async () => {
    const { kube, provider } = setup();
    const handle = await provider.ensureSandbox(TEAM, USER);
    seedLocalVolume(kube, handle.sandboxName, "compute4");
    seedNode(kube, "compute4", "Unknown", NODE_LOST_AFTER_MS);
    await expect(provider.volumeHealth(TEAM, USER)).resolves.toMatchObject({
      reason: "node_not_ready",
    });
  });
});
