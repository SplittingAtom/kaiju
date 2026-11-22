import type { KubeClient } from "./kube.js";
import type { KubeObject } from "./manifests.js";

/**
 * Whether a member's workspace volume is lost (KOBE-739, review STO-8): its only copy lived on a
 * node that is gone, or Kubernetes itself reports the volume gone or failed. A lost volume can
 * never be attached again, so the member (or a team admin) may rebuild the workspace from the last
 * sync. Detection must not fire for a volume that is merely slow or briefly unreachable: a rebuild
 * destroys the volume and with it every change that was never synced. So only these count, each
 * read from the Kubernetes API and nothing else:
 *
 * - the claim is `Lost` (its PersistentVolume no longer exists), or it is bound to a
 *   PersistentVolume that does not exist or whose phase is `Failed`;
 * - `node_down`, not yet lost: the volume is pinned to one node (a `kubernetes.io/hostname` node
 *   affinity on the PersistentVolume, as `local-path` writes it; or a Longhorn volume with one
 *   replica and `dataLocality: strict-local`, which lives on the node the claim was first
 *   scheduled to, taken from the claim's `volume.kubernetes.io/selected-node`: Longhorn's own
 *   replica records are not read) and that node is missing or not Ready right now. A node can come
 *   back with its disk intact (re-join, long upgrade, kubelet down), so the caller counts this as
 *   lost only after it has held, by the server's own observations, for the grace period
 *   (`sandbox-lifecycle/volume-verdict.ts`). No controller timestamp is compared with our clock.
 *
 * Anything else (replicated volumes, a node that is Ready, a pending claim, any read error) is
 * `present`: the rebuild is never offered.
 */

const HOSTNAME = "kubernetes.io/hostname";
const SELECTED_NODE = "volume.kubernetes.io/selected-node";
const LONGHORN = "driver.longhorn.io";

export type VolumeLossReason =
  /** The claim is `Lost`: its PersistentVolume was deleted. */
  | "claim_lost"
  /** The claim names a PersistentVolume that does not exist. */
  | "volume_missing"
  /** The PersistentVolume's phase is `Failed`. */
  | "volume_failed"
  /** The node holding the volume's only copy does not exist (now). */
  | "node_gone"
  /** The node holding the volume's only copy is not Ready (now). */
  | "node_not_ready";

/** Reasons that count at once; the node reasons count only after the grace period. */
export type ImmediateLossReason = Exclude<VolumeLossReason, NodeDownReason>;
export type NodeDownReason = "node_gone" | "node_not_ready";

export type VolumeHealth =
  /** No workspace volume (never created, or being deleted: a rebuild or reclaim already ran). */
  | { readonly state: "missing" }
  /** The volume is there, or nothing proves it lost. */
  | { readonly state: "present" }
  | {
      readonly state: "lost";
      readonly reason: ImmediateLossReason;
      /** One line for admins and logs (names cluster objects); never shown to members. */
      readonly detail: string;
    }
  /** The one node holding it is missing or not Ready now: lost only once that has lasted. */
  | {
      readonly state: "node_down";
      readonly reason: NodeDownReason;
      readonly node: string;
      readonly detail: string;
    };

const text = (v: unknown): string => (typeof v === "string" ? v : "");
const rec = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** How the volume is tied to a node: by a hostname label value, or by a node name. */
export type VolumeHome =
  | { readonly by: "hostname"; readonly value: string }
  | { readonly by: "name"; readonly value: string };

/**
 * The single node a volume lives on, or undefined when it is not pinned to one (replicated
 * storage, network storage) or when that cannot be told for sure.
 */
export function volumeHome(pvc: KubeObject, pv: KubeObject): VolumeHome | undefined {
  const spec = rec(pv["spec"]);
  const terms = rec(rec(spec["nodeAffinity"])["required"])["nodeSelectorTerms"];
  if (Array.isArray(terms) && terms.length > 0) {
    // Exactly one term, whose hostname requirement names exactly one node (local-path, local PVs).
    if (terms.length !== 1) return undefined;
    const exprs = rec(terms[0])["matchExpressions"];
    const hosts = (Array.isArray(exprs) ? exprs : [])
      .map(rec)
      .filter((e) => e["key"] === HOSTNAME && e["operator"] === "In");
    const values = hosts.length === 1 ? hosts[0]?.["values"] : undefined;
    if (Array.isArray(values) && values.length === 1 && text(values[0]) !== "") {
      return { by: "hostname", value: text(values[0]) };
    }
    return undefined;
  }
  const csi = rec(spec["csi"]);
  const attrs = rec(csi["volumeAttributes"]);
  const strictLocal =
    csi["driver"] === LONGHORN &&
    attrs["dataLocality"] === "strict-local" &&
    String(attrs["numberOfReplicas"]) === "1";
  const selected = text(pvc.metadata.annotations?.[SELECTED_NODE]);
  return strictLocal && selected !== "" ? { by: "name", value: selected } : undefined;
}

/** Whether `node` reports a Ready condition that is not True (no condition: cannot tell). */
export function notReady(node: KubeObject): boolean {
  const conditions = rec(node["status"])["conditions"];
  const ready = (Array.isArray(conditions) ? conditions : [])
    .map(rec)
    .find((c) => c["type"] === "Ready");
  return ready !== undefined && ready["status"] !== "True";
}

/**
 * Pure judgement of what was read (tested with fake API objects). `nodes` are the nodes found for
 * the volume's home (by name: zero or one; by hostname label: any number).
 */
export function judgeVolume(input: {
  readonly pvc: KubeObject | undefined;
  readonly pv: KubeObject | undefined;
  /** Whether the PersistentVolume was looked up (the claim names one). */
  readonly pvLookedUp: boolean;
  readonly nodes: readonly KubeObject[] | undefined;
}): VolumeHealth {
  const { pvc, pv, nodes } = input;
  if (!pvc || pvc.metadata.deletionTimestamp) return { state: "missing" };
  const phase = text(rec(pvc["status"])["phase"]);
  const pvName = text(rec(pvc["spec"])["volumeName"]);
  const claim = `${pvc.metadata.namespace ?? ""}/${pvc.metadata.name}`;
  if (phase === "Lost") {
    return { state: "lost", reason: "claim_lost", detail: `claim ${claim} is Lost (${pvName})` };
  }
  if (phase !== "Bound" || pvName === "" || !input.pvLookedUp) return { state: "present" };
  if (!pv) {
    return {
      state: "lost",
      reason: "volume_missing",
      detail: `claim ${claim} is bound to ${pvName}, which does not exist`,
    };
  }
  if (text(rec(pv["status"])["phase"]) === "Failed") {
    return { state: "lost", reason: "volume_failed", detail: `volume ${pvName} is Failed` };
  }
  const home = volumeHome(pvc, pv);
  if (!home || nodes === undefined) return { state: "present" };
  if (nodes.length === 0) {
    return {
      state: "node_down",
      reason: "node_gone",
      node: home.value,
      detail: `volume ${pvName} lives only on node ${home.value}, which does not exist`,
    };
  }
  // Every node that could be its home must be not Ready (a hostname normally names one).
  if (nodes.every(notReady)) {
    return {
      state: "node_down",
      reason: "node_not_ready",
      node: home.value,
      detail: `volume ${pvName} lives only on node ${home.value}, which is not Ready`,
    };
  }
  return { state: "present" };
}

/**
 * Reads the workspace claim, its PersistentVolume and the node it lives on, then judges them.
 * Read errors propagate: the caller treats them as "cannot tell" (never as lost).
 */
export async function inspectVolume(
  kube: KubeClient,
  namespace: string,
  pvcName: string,
): Promise<VolumeHealth> {
  const pvc = await kube.get({
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    name: pvcName,
    namespace,
  });
  const pvName = text(rec(pvc?.["spec"])["volumeName"]);
  const bound = text(rec(pvc?.["status"])["phase"]) === "Bound" && pvName !== "";
  const pv =
    pvc && bound && !pvc.metadata.deletionTimestamp
      ? await kube.get({ apiVersion: "v1", kind: "PersistentVolume", name: pvName })
      : undefined;
  const home = pvc && pv ? volumeHome(pvc, pv) : undefined;
  let nodes: KubeObject[] | undefined;
  if (home?.by === "name") {
    const node = await kube.get({ apiVersion: "v1", kind: "Node", name: home.value });
    nodes = node ? [node] : [];
  } else if (home?.by === "hostname") {
    nodes = await kube.list("v1", "Node", undefined, `${HOSTNAME}=${home.value}`);
  }
  return judgeVolume({ pvc, pv, pvLookedUp: bound, nodes });
}
