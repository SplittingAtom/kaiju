import { quantityBytes } from "./config.js";
import { MEMBER_RESOURCE_QUOTA } from "./constants.js";
import { podTermination } from "./pod-termination.js";
import { judgeScheduling } from "./scheduling-message.js";
import type { KubeClient } from "./kube.js";
import type { KubeObject } from "./manifests.js";
import { inspectVolume, type VolumeHealth } from "./volume-loss.js";

/**
 * Why a sandbox pod is not Ready (KOBE-192): classifies the pod's and the workspace volume's
 * events and conditions. `detail` names cluster internals (nodes, volumes) and is for install
 * admins and logs only; members only ever see a fixed message per failure code.
 */
export type StallCause =
  /** The volume's replica could not be scheduled (Longhorn: insufficient storage, strict-local). */
  | "volume_unschedulable"
  /** The volume exists but could not be attached or mounted. */
  | "volume_attach"
  | "scheduling"
  | "image_pull"
  /** The pod ended (evicted, killed: phase Failed or Succeeded); it will never become Ready. */
  | "pod_failed"
  /**
   * The team's ResourceQuota has no room for the workspace volume (PVC count or storage, KOBE-733):
   * the volume cannot be created until volumes are freed or the quota raised.
   */
  | "volume_quota"
  /**
   * The workspace volume is lost for good (KOBE-739, `volume-loss.ts`): its only copy was on a
   * node that is gone, or Kubernetes reports the volume gone or failed. The member may rebuild the
   * workspace from the last sync.
   */
  | "volume_lost"
  | "unknown";

export interface StallDiagnosis {
  readonly cause: StallCause;
  /** One line for admins; control characters removed, bounded. */
  readonly detail: string;
  /** The workspace PVC's phase, if it exists. */
  readonly volumePhase?: string;
  /**
   * A signal that waiting will not fix (replica cannot be scheduled, no nodes, an attach that
   * keeps failing, an image that cannot be pulled). Anything else (Pulling, ContainerCreating, a
   * single FailedMount) is progress and the wake keeps waiting.
   */
  readonly definite: boolean;
}

const MAX_DETAIL = 400;
/** FailedAttachVolume is definite after this many repeats, or once it has lasted this long. */
const ATTACH_REPEATS = 3;
const ATTACH_LASTING_MS = 60_000;
const VOLUME_SCHEDULING = /LocalReplicaSchedulingFailure|insufficient storage|replica scheduling/i;
const VOLUME_ATTACH = /FailedAttachVolume|AttachVolume\.Attach failed|FailedMount|MountVolume/i;
/** A workspace volume still not created or bound after this long is not the first-wake race. */
const VOLUME_PENDING_LASTING_MS = 60_000;
const STORAGE = /insufficient storage|enough free storage/i;
const IMAGE_PULL = /ErrImagePull|ImagePullBackOff|ErrImageNeverPull|InvalidImageName/i;

interface KubeEvent {
  readonly reason: string;
  readonly message: string;
  readonly type: string;
  readonly kind: string;
  readonly name: string;
  readonly at: number;
  readonly first: number;
  readonly count: number;
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");

function toEvent(o: KubeObject): KubeEvent {
  const involved = (o["involvedObject"] ?? {}) as Record<string, unknown>;
  const stamp =
    text(o["lastTimestamp"]) || text(o["eventTime"]) || text(o.metadata.creationTimestamp);
  return {
    reason: text(o["reason"]),
    message: text(o["message"]),
    type: text(o["type"]),
    kind: text(involved["kind"]),
    name: text(involved["name"]),
    at: Date.parse(stamp) || 0,
    first: Date.parse(text(o["firstTimestamp"]) || stamp) || 0,
    count: typeof o["count"] === "number" ? o["count"] : 1,
  };
}

function waitingReasons(pod: KubeObject | undefined): string[] {
  const status = (pod?.["status"] ?? {}) as Record<string, unknown>;
  const all = [
    ...((status["containerStatuses"] as unknown[]) ?? []),
    ...((status["initContainerStatuses"] as unknown[]) ?? []),
  ] as Record<string, Record<string, Record<string, unknown>> | undefined>[];
  return all.map((c) => text(c["state"]?.["waiting"]?.["reason"])).filter((r) => r !== "");
}

const clean = (s: string): string =>
  [...s]
    .map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? " " : ch))
    .join("")
    .replace(/ {2,}/g, " ")
    .trim()
    .slice(0, MAX_DETAIL);

const QUOTA_EVENT = /exceeded quota/i;
const QUOTA_VOLUME = /persistentvolumeclaims|requests\.storage/i;

const bytesOf = (q: unknown): number | undefined => {
  if (typeof q !== "string" && typeof q !== "number") return undefined;
  try {
    return quantityBytes(String(q));
  } catch {
    return undefined;
  }
};

/**
 * Why the team's member quota (`kobe-team-member-quota`) cannot take one more workspace volume of
 * `volumeBytes`: no PVC left, or not enough storage left. Undefined when it can (or is unknown).
 */
export function quotaShortfall(
  quota: KubeObject | undefined,
  volumeBytes: number | undefined,
): string | undefined {
  const status = (quota?.["status"] ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const hard = status["hard"] ?? {};
  const used = status["used"] ?? {};
  const count = (k: string) => bytesOf(hard[k]) !== undefined && bytesOf(used[k]) !== undefined;
  if (count("persistentvolumeclaims")) {
    const h = bytesOf(hard["persistentvolumeclaims"]) as number;
    const u = bytesOf(used["persistentvolumeclaims"]) as number;
    if (u >= h) return `quota ${MEMBER_RESOURCE_QUOTA}: persistentvolumeclaims used ${u} of ${h}`;
  }
  if (count("requests.storage")) {
    const h = bytesOf(hard["requests.storage"]) as number;
    const u = bytesOf(used["requests.storage"]) as number;
    if (u + (volumeBytes ?? 1) > h) {
      return `quota ${MEMBER_RESOURCE_QUOTA}: requests.storage used ${String(used["requests.storage"])} of ${String(hard["requests.storage"])}`;
    }
  }
  return undefined;
}

/**
 * Pure classification of what was read (tested with fake API responses). Only events of this
 * wake (`since`, epoch ms) about this very pod or volume (matched by uid, not just name) count:
 * an earlier wake leftovers say nothing about now.
 */
export function classifyStall(input: {
  readonly pod: KubeObject | undefined;
  readonly pvc: KubeObject | undefined;
  readonly events: readonly KubeObject[];
  readonly since: number;
  readonly now: number;
  /** The team's member ResourceQuota (KOBE-733), when it could be read. */
  readonly quota?: KubeObject | undefined;
  /** The workspace volume's requested size in bytes. */
  readonly volumeBytes?: number | undefined;
  /** Whether the workspace volume is lost (KOBE-739), when it could be read. */
  readonly volume?: VolumeHealth | undefined;
}): StallDiagnosis {
  const { pod, pvc, since, now } = input;
  const uids = new Set(
    [pod?.metadata.uid, pvc?.metadata.uid].filter((u): u is string => typeof u === "string"),
  );
  const events = input.events
    .filter((o) => uids.has(text((o["involvedObject"] as Record<string, unknown>)?.["uid"])))
    .map(toEvent)
    .filter((e) => e.type !== "Normal" && e.at >= since)
    .sort((a, b) => b.at - a.at);
  const waiting = waitingReasons(pod);
  const volumePhase = text((pvc?.["status"] as Record<string, unknown> | undefined)?.["phase"]);
  const pick = (re: RegExp) => events.find((e) => re.test(`${e.reason} ${e.message}`));
  const line = (e: KubeEvent) => `${e.reason}: ${e.message}`;
  const make = (cause: StallCause, e: string, definite: boolean): StallDiagnosis => ({
    cause,
    detail: clean(e),
    definite,
    ...(volumePhase ? { volumePhase } : {}),
  });

  // A lost volume (KOBE-739) can never attach again: nothing else the events say matters.
  if (input.volume?.state === "lost") return make("volume_lost", input.volume.detail, true);
  // An ended pod never becomes Ready (KOBE-636): say so at once, in the kubelet's words.
  const ended = podTermination(pod);
  if (ended) {
    const why = [ended.reason, ended.message].filter((p) => p !== "").join(": ");
    return make("pod_failed", `pod ${ended.phase}${why ? `: ${why}` : ""}`, true);
  }
  // No workspace volume, and the team's quota has no room for one (KOBE-733): waiting will not
  // help. The quota's own numbers, or a controller's "exceeded quota" event of this wake (it names
  // the volume, which has no uid yet, so any object's event counts).
  if (!pvc) {
    const refused = input.events
      .map(toEvent)
      .filter((e) => e.type !== "Normal" && e.at >= since)
      .sort((a, b) => b.at - a.at)
      .find((e) => QUOTA_EVENT.test(e.message) && QUOTA_VOLUME.test(e.message));
    if (refused) return make("volume_quota", line(refused), true);
    // The quota's own numbers lag its controller (just after volumes were freed): the cause, but
    // not definite on its own, so the wake keeps waiting for its budget.
    const shortfall = quotaShortfall(input.quota, input.volumeBytes);
    if (shortfall) return make("volume_quota", shortfall, false);
  }
  // Longhorn's replica scheduling (FailedAttachVolume etc.); the scheduler's own words below.
  const replica = events.find(
    (e) => e.reason !== "FailedScheduling" && VOLUME_SCHEDULING.test(`${e.reason} ${e.message}`),
  );
  if (replica) return make("volume_unschedulable", line(replica), true);
  // The newest FailedScheduling says where scheduling stands now (KOBE-277).
  const scheduling = events.find((e) => e.reason === "FailedScheduling");
  const verdict = scheduling ? judgeScheduling(scheduling.message) : "unknown";
  if (scheduling && verdict === "blocked") {
    const cause = STORAGE.test(scheduling.message) ? "volume_unschedulable" : "scheduling";
    return make(cause, line(scheduling), true);
  }
  if (scheduling && verdict === "volume_pending") {
    const lasting = now - scheduling.first >= VOLUME_PENDING_LASTING_MS;
    if (lasting) return make("volume_unschedulable", line(scheduling), true);
  }
  const pull = pick(IMAGE_PULL);
  const pullWaiting = waiting.find((w) => IMAGE_PULL.test(w));
  if (pull || pullWaiting) return make("image_pull", pull ? line(pull) : (pullWaiting ?? ""), true);
  const attach = pick(VOLUME_ATTACH);
  if (attach) {
    // One FailedMount is normal while a volume attaches; a repeating FailedAttachVolume is not.
    const lasting =
      attach.reason === "FailedAttachVolume" &&
      (attach.count >= ATTACH_REPEATS || now - attach.first >= ATTACH_LASTING_MS);
    return make("volume_attach", line(attach), lasting);
  }
  const unschedulable = pick(/FailedScheduling/);
  if (unschedulable) return make("scheduling", line(unschedulable), false);
  const failedProvision = pick(/ProvisioningFailed/);
  if (failedProvision) return make("volume_unschedulable", line(failedProvision), false);
  const phase = text((pod?.["status"] as Record<string, unknown> | undefined)?.["phase"]);
  return make(
    "unknown",
    `pod ${phase || "missing"}${waiting.length ? ` (${waiting.join(", ")})` : ""}, volume ${volumePhase || "missing"}`,
    false,
  );
}

/** Reads the pod, the workspace PVC and the namespace events, then classifies them. */
export async function diagnoseStall(
  kube: KubeClient,
  namespace: string,
  podName: string,
  pvcName: string,
  since: number,
  now: number,
  volumeBytes?: number,
): Promise<StallDiagnosis> {
  const [pod, pvc, events] = await Promise.all([
    kube.get({ apiVersion: "v1", kind: "Pod", name: podName, namespace }),
    kube.get({ apiVersion: "v1", kind: "PersistentVolumeClaim", name: pvcName, namespace }),
    kube.list("v1", "Event", namespace),
  ]);
  // KOBE-733: only when the volume is missing; a read failure (older RBAC) is no diagnosis.
  const quota = pvc
    ? undefined
    : await kube
        .get({ apiVersion: "v1", kind: "ResourceQuota", name: MEMBER_RESOURCE_QUOTA, namespace })
        .catch(() => undefined);
  // KOBE-739: only with a volume; a read failure (older RBAC: no PV or Node reads) is no diagnosis.
  const volume = pvc
    ? await inspectVolume(kube, namespace, pvcName, now).catch(() => undefined)
    : undefined;
  return classifyStall({ pod, pvc, events, since, now, quota, volumeBytes, volume });
}

/** Whether the pod Ready condition is True. */
export function isPodReady(pod: KubeObject | undefined): boolean {
  const conditions = ((pod?.["status"] as Record<string, unknown> | undefined)?.["conditions"] ??
    []) as { type?: string; status?: string }[];
  return conditions.some((c) => c.type === "Ready" && c.status === "True");
}
