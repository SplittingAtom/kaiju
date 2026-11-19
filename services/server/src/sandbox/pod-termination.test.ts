import { describe, expect, it } from "vitest";
import type { KubeObject } from "./manifests.js";
import { podTermination } from "./pod-termination.js";

const pod = (status: Record<string, unknown>): KubeObject => ({
  apiVersion: "v1",
  kind: "Pod",
  metadata: { name: "u-1", namespace: "kobe-team-finance" },
  status,
});

/** The shape the kubelet leaves behind for a home emptyDir over its sizeLimit (gate1, 2026-11-12). */
const EVICTED_HOME = {
  phase: "Failed",
  reason: "Evicted",
  message: 'Usage of EmptyDir volume "home" exceeds the limit "1Gi". ',
  containerStatuses: [
    {
      name: "agent",
      ready: false,
      state: { terminated: { exitCode: 137, reason: "Error" } },
    },
  ],
};

describe("podTermination (KOBE-636)", () => {
  it("reads an emptyDir eviction as out of space, keeping the kubelet's words", () => {
    expect(podTermination(pod(EVICTED_HOME))).toEqual({
      phase: "Failed",
      cause: "out_of_space",
      reason: "Evicted",
      message: 'Usage of EmptyDir volume "home" exceeds the limit "1Gi".',
    });
  });

  it("knows container and node ephemeral-storage evictions as out of space", () => {
    for (const message of [
      "Pod ephemeral local storage usage exceeds the total limit of containers 4Gi.",
      "The node was low on resource: ephemeral-storage. Threshold quantity: 10Gi, available: 2Gi.",
    ]) {
      expect(podTermination(pod({ phase: "Failed", reason: "Evicted", message }))?.cause).toBe(
        "out_of_space",
      );
    }
  });

  it("knows memory evictions and OOM kills", () => {
    expect(
      podTermination(
        pod({
          phase: "Failed",
          reason: "Evicted",
          message: "The node was low on resource: memory.",
        }),
      )?.cause,
    ).toBe("out_of_memory");
    expect(
      podTermination(
        pod({
          phase: "Failed",
          containerStatuses: [{ state: { terminated: { reason: "OOMKilled", exitCode: 137 } } }],
        }),
      ),
    ).toMatchObject({ cause: "out_of_memory", reason: "OOMKilled" });
  });

  it("calls anything else stopped, and a live or missing pod not terminated", () => {
    expect(podTermination(pod({ phase: "Succeeded" }))).toMatchObject({
      phase: "Succeeded",
      cause: "stopped",
      reason: "",
    });
    for (const phase of ["Pending", "Running", "Unknown", undefined]) {
      expect(podTermination(pod({ phase }))).toBeUndefined();
    }
    expect(podTermination(undefined)).toBeUndefined();
  });

  it("strips control characters and bounds what it keeps", () => {
    const t = podTermination(
      pod({
        phase: "Failed",
        reason: `Evicted\n${"x".repeat(100)}`,
        message: "a\u0000b".repeat(500),
      }),
    );
    expect(t?.reason.length).toBeLessThanOrEqual(64);
    expect(t?.message.length).toBeLessThanOrEqual(400);
    // eslint-disable-next-line no-control-regex
    expect(`${t?.reason}${t?.message}`).not.toMatch(/[\u0000-\u001f]/);
  });
});
