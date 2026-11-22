import { describe, expect, it } from "vitest";
import { createFakeKube } from "../testing/fake-kube.js";
import type { KubeObject } from "./manifests.js";
import { NODE_LOST_AFTER_MS, inspectVolume, judgeVolume, volumeHome } from "./volume-loss.js";

/** Lost-volume detection (KOBE-739): only hard evidence counts; anything unsure is "present". */
const NS = "kobe-team-finance";
const NOW = Date.parse("2026-11-21T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function pvc(
  over: { phase?: string; annotations?: Record<string, string>; deleting?: boolean } = {},
) {
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      name: "workspace-u-1",
      namespace: NS,
      ...(over.annotations ? { annotations: over.annotations } : {}),
      ...(over.deleting ? { deletionTimestamp: ago(1000) } : {}),
    },
    spec: { volumeName: "pvc-abc" },
    status: { phase: over.phase ?? "Bound" },
  } as KubeObject;
}

const localPv = (host = "node-a", phase = "Bound") =>
  ({
    apiVersion: "v1",
    kind: "PersistentVolume",
    metadata: { name: "pvc-abc" },
    spec: {
      nodeAffinity: {
        required: {
          nodeSelectorTerms: [
            {
              matchExpressions: [{ key: "kubernetes.io/hostname", operator: "In", values: [host] }],
            },
          ],
        },
      },
    },
    status: { phase },
  }) as KubeObject;

const longhornPv = (attrs: Record<string, string>) =>
  ({
    apiVersion: "v1",
    kind: "PersistentVolume",
    metadata: { name: "pvc-abc" },
    spec: {
      csi: { driver: "driver.longhorn.io", volumeHandle: "pvc-abc", volumeAttributes: attrs },
    },
    status: { phase: "Bound" },
  }) as KubeObject;

const STRICT = { dataLocality: "strict-local", numberOfReplicas: "1" };
const SELECTED = { "volume.kubernetes.io/selected-node": "node-a" };

const node = (name: string, ready: "True" | "False" | "Unknown", sinceMs: number) =>
  ({
    apiVersion: "v1",
    kind: "Node",
    metadata: { name, labels: { "kubernetes.io/hostname": name } },
    status: { conditions: [{ type: "Ready", status: ready, lastTransitionTime: ago(sinceMs) }] },
  }) as KubeObject;

const judge = (p: KubeObject | undefined, v: KubeObject | undefined, nodes?: KubeObject[]) =>
  judgeVolume({ pvc: p, pv: v, pvLookedUp: true, nodes, now: NOW });

describe("volumeHome", () => {
  it("is the hostname of a local volume's node affinity", () => {
    expect(volumeHome(pvc(), localPv())).toEqual({ by: "hostname", value: "node-a" });
  });

  it("is the selected node of a strict-local single-replica Longhorn volume", () => {
    expect(volumeHome(pvc({ annotations: SELECTED }), longhornPv(STRICT))).toEqual({
      by: "name",
      value: "node-a",
    });
  });

  it("is unknown for replicated or non-local Longhorn volumes and without a selected node", () => {
    expect(volumeHome(pvc({ annotations: SELECTED }), longhornPv({ numberOfReplicas: "3" }))).toBe(
      undefined,
    );
    const twoReplicas = { dataLocality: "strict-local", numberOfReplicas: "2" };
    expect(volumeHome(pvc({ annotations: SELECTED }), longhornPv(twoReplicas))).toBe(undefined);
    expect(volumeHome(pvc(), longhornPv(STRICT))).toBe(undefined);
  });

  it("is unknown when the affinity allows more than one node", () => {
    const pv = localPv();
    const terms = (pv["spec"] as Record<string, any>).nodeAffinity.required.nodeSelectorTerms;
    terms[0].matchExpressions[0].values = ["node-a", "node-b"];
    expect(volumeHome(pvc(), pv)).toBe(undefined);
  });
});

describe("judgeVolume", () => {
  it("is missing without a claim or while the claim is being deleted", () => {
    expect(judge(undefined, undefined)).toEqual({ state: "missing" });
    expect(judge(pvc({ deleting: true }), localPv(), [])).toEqual({ state: "missing" });
  });

  it("is lost when Kubernetes says so: claim Lost, volume missing or Failed", () => {
    expect(judge(pvc({ phase: "Lost" }), undefined)).toMatchObject({ reason: "claim_lost" });
    expect(judge(pvc(), undefined)).toMatchObject({ state: "lost", reason: "volume_missing" });
    expect(judge(pvc(), localPv("node-a", "Failed"), [node("node-a", "True", 0)])).toMatchObject({
      reason: "volume_failed",
    });
  });

  it("is lost when the only node holding it is gone", () => {
    expect(judge(pvc(), localPv(), [])).toMatchObject({
      state: "lost",
      reason: "node_gone",
      node: "node-a",
    });
    expect(judge(pvc({ annotations: SELECTED }), longhornPv(STRICT), [])).toMatchObject({
      reason: "node_gone",
    });
  });

  it("is lost when that node has not been Ready for the whole grace period", () => {
    const down = node("node-a", "Unknown", NODE_LOST_AFTER_MS);
    expect(judge(pvc(), localPv(), [down])).toMatchObject({ reason: "node_not_ready" });
  });

  it("is present while the node is Ready, or not Ready only briefly (a reboot)", () => {
    expect(judge(pvc(), localPv(), [node("node-a", "True", 0)])).toEqual({ state: "present" });
    const brief = node("node-a", "False", NODE_LOST_AFTER_MS - 1000);
    expect(judge(pvc(), localPv(), [brief])).toEqual({ state: "present" });
  });

  it("is present for a pending claim and for volumes not pinned to a node", () => {
    expect(judge(pvc({ phase: "Pending" }), undefined)).toEqual({ state: "present" });
    expect(
      judge(pvc({ annotations: SELECTED }), longhornPv({ numberOfReplicas: "3" }), []),
    ).toEqual({ state: "present" });
  });

  it("is present when the node was not looked up", () => {
    expect(judge(pvc(), localPv(), undefined)).toEqual({ state: "present" });
  });
});

describe("inspectVolume", () => {
  const seedPvc = (kube: ReturnType<typeof createFakeKube>, p: KubeObject) => kube.seed(p);

  it("finds a local volume's node by its hostname label and reports it gone", async () => {
    const kube = createFakeKube();
    seedPvc(kube, pvc());
    kube.seed(localPv("node-a"));
    kube.seed(node("node-b", "True", 0));
    await expect(inspectVolume(kube, NS, "workspace-u-1", NOW)).resolves.toMatchObject({
      reason: "node_gone",
    });
    kube.seed(node("node-a", "True", 0));
    await expect(inspectVolume(kube, NS, "workspace-u-1", NOW)).resolves.toEqual({
      state: "present",
    });
  });

  it("looks a strict-local volume's node up by name", async () => {
    const kube = createFakeKube();
    seedPvc(kube, pvc({ annotations: SELECTED }));
    kube.seed(longhornPv(STRICT));
    kube.seed(node("node-a", "Unknown", NODE_LOST_AFTER_MS + 1));
    await expect(inspectVolume(kube, NS, "workspace-u-1", NOW)).resolves.toMatchObject({
      reason: "node_not_ready",
      node: "node-a",
    });
  });

  it("is missing without a claim and propagates read errors (never lost on doubt)", async () => {
    const kube = createFakeKube();
    await expect(inspectVolume(kube, NS, "workspace-u-1", NOW)).resolves.toEqual({
      state: "missing",
    });
    seedPvc(kube, pvc());
    kube.seed(localPv());
    kube.failNext("list", "Node", 403);
    await expect(inspectVolume(kube, NS, "workspace-u-1", NOW)).rejects.toThrow();
  });
});
