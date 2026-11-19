import type { KubeObject } from "./manifests.js";

/**
 * A sandbox pod that has ended for good (KOBE-636): phase Failed (evicted, killed) or Succeeded.
 * agent-sandbox v1.0.4 leaves such a pod in place (its Sandbox only reports Ready=False,
 * `PodFailed`) and never starts another while it exists, so every wake would wait for it in vain.
 */
export interface PodTermination {
  readonly phase: "Failed" | "Succeeded";
  /** Why, in words a member can be told: `out_of_space` covers the home/tmp emptyDirs too. */
  readonly cause: PodTerminationCause;
  /** The pod's own reason (`Evicted`, `OOMKilled`, ...), bounded; empty when it gave none. */
  readonly reason: string;
  /** The kubelet's message (may name volumes and limits; logs and admins only), bounded. */
  readonly message: string;
}

export type PodTerminationCause = "out_of_space" | "out_of_memory" | "stopped";

const MAX_REASON = 64;
const MAX_MESSAGE = 400;
/** Kubelet eviction messages for emptyDir `sizeLimit`, container and node ephemeral storage. */
const OUT_OF_SPACE = /EmptyDir volume|ephemeral[- ](local[- ])?storage|DiskPressure|nodefs/i;
const OUT_OF_MEMORY = /OOMKilled|\bmemory\b|MemoryPressure/i;

const text = (v: unknown): string => (typeof v === "string" ? v : "");

const clean = (s: string, max: number): string =>
  [...s]
    .map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? " " : ch))
    .join("")
    .replace(/ {2,}/g, " ")
    .trim()
    .slice(0, max);

/** A terminated container's reason (e.g. OOMKilled), for a pod that names none itself. */
function containerReason(status: Record<string, unknown>): string {
  const all = [
    ...((status["containerStatuses"] as unknown[] | undefined) ?? []),
    ...((status["initContainerStatuses"] as unknown[] | undefined) ?? []),
  ] as { state?: { terminated?: { reason?: unknown } } }[];
  return all.map((c) => text(c.state?.terminated?.reason)).find((r) => r !== "") ?? "";
}

/** The pod's termination, or undefined while it is (or may still become) live. */
export function podTermination(pod: KubeObject | undefined): PodTermination | undefined {
  const status = (pod?.["status"] ?? {}) as Record<string, unknown>;
  const phase = text(status["phase"]);
  if (phase !== "Failed" && phase !== "Succeeded") return undefined;
  const reason = clean(text(status["reason"]) || containerReason(status), MAX_REASON);
  const message = clean(text(status["message"]), MAX_MESSAGE);
  const said = `${reason} ${message}`;
  const cause: PodTerminationCause = OUT_OF_SPACE.test(said)
    ? "out_of_space"
    : OUT_OF_MEMORY.test(said)
      ? "out_of_memory"
      : "stopped";
  return { phase, cause, reason, message };
}
