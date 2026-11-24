import { describe, expect, it, vi } from "vitest";
import { IsolationRuntimeMissingError } from "../isolation/gate.js";
import { OTHER_TEAM, TEAM, USER, must } from "../testing/sandbox-fixtures.js";
import { BOOTSTRAP_TOKEN_AUDIENCE, LABEL_CLAIM_UID, LABEL_TEAM_ID } from "./constants.js";
import type { TokenReviewResult } from "./kube.js";
import { SandboxAuthError } from "./provider.js";
import { NS, objectAt, recreateRuntimeClass, setup } from "../testing/provider-setup.js";

/** Bootstrap token identity (KOBE-22, KOBE-417; split out of provider.test.ts by KOBE-710). */

describe("identifyBootstrapToken", () => {
  const TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl";

  async function withSandbox() {
    const ctx = setup();
    const handle = await ctx.provider.ensureSandbox(TEAM, USER);
    const pod = must(objectAt(ctx.kube, "Pod", must(handle.podName), NS));
    const review = (over: Partial<TokenReviewResult> = {}): TokenReviewResult => ({
      authenticated: true,
      audiences: [BOOTSTRAP_TOKEN_AUDIENCE],
      username: `system:serviceaccount:${NS}:kaiju-sandbox`,
      extra: {
        "authentication.kubernetes.io/pod-name": [pod.metadata.name],
        "authentication.kubernetes.io/pod-uid": [pod.metadata.uid as string],
      },
      ...over,
    });
    ctx.kube.tokens.set(TOKEN, review());
    return { ...ctx, handle, pod, review };
  }

  it("resolves a claimed sandbox pod to (sandbox, team, user)", async () => {
    const { provider, handle } = await withSandbox();
    await expect(provider.identifyBootstrapToken(TOKEN)).resolves.toEqual({
      state: "assigned",
      principal: { sandboxId: handle.sandboxId, teamId: TEAM.id, userId: USER },
      namespace: NS,
      podName: handle.podName,
    });
  });

  it("asks the TokenReview for the bootstrap audience only", async () => {
    const { kube, provider } = await withSandbox();
    const review = vi.spyOn(kube, "reviewToken");
    await provider.identifyBootstrapToken(TOKEN);
    expect(review).toHaveBeenCalledWith(TOKEN, [BOOTSTRAP_TOKEN_AUDIENCE]);
  });

  it.each([
    ["unauthenticated", { authenticated: false }],
    ["another audience", { audiences: ["https://kubernetes.default.svc"] }],
    ["another ServiceAccount", { username: `system:serviceaccount:${NS}:default` }],
    ["a non-team namespace", { username: "system:serviceaccount:kube-system:kaiju-sandbox" }],
    ["a token not bound to a pod", { extra: {} }],
  ])("rejects %s", async (_, over) => {
    const { kube, provider, review } = await withSandbox();
    kube.tokens.set(TOKEN, review(over as Partial<TokenReviewResult>));
    await expect(provider.identifyBootstrapToken(TOKEN)).rejects.toThrow(SandboxAuthError);
  });

  it("rejects malformed tokens without a TokenReview", async () => {
    const { kube, provider } = await withSandbox();
    const review = vi.spyOn(kube, "reviewToken");
    await expect(provider.identifyBootstrapToken("short")).rejects.toThrow(SandboxAuthError);
    await expect(provider.identifyBootstrapToken(`${TOKEN} x`)).rejects.toThrow(SandboxAuthError);
    expect(review).not.toHaveBeenCalled();
  });

  it("rejects a token of a deleted or replaced pod", async () => {
    const { kube, provider, review, pod } = await withSandbox();
    kube.tokens.set(
      TOKEN,
      review({
        extra: {
          "authentication.kubernetes.io/pod-name": [pod.metadata.name],
          "authentication.kubernetes.io/pod-uid": ["00000000-0000-4000-8000-000000000000"],
        },
      }),
    );
    await expect(provider.identifyBootstrapToken(TOKEN)).rejects.toThrow(/is gone/);
  });

  it("reports an unclaimed warm-pool pod as unassigned", async () => {
    const { kube, provider, pod } = await withSandbox();
    const labels = Object.fromEntries(
      Object.entries(pod.metadata.labels ?? {}).filter(([k]) => k !== LABEL_CLAIM_UID),
    );
    kube.seed({ ...pod, metadata: { ...pod.metadata, labels } });
    await expect(provider.identifyBootstrapToken(TOKEN)).resolves.toMatchObject({
      state: "unassigned",
    });
  });

  describe("recheckAssignment (KOBE-417 long-poll)", () => {
    async function unassignedPod() {
      const ctx = await withSandbox();
      const labels = ctx.pod.metadata.labels ?? {};
      const without = Object.fromEntries(
        Object.entries(labels).filter(([k]) => k !== LABEL_CLAIM_UID),
      );
      ctx.kube.seed({ ...ctx.pod, metadata: { ...ctx.pod.metadata, labels: without } });
      const identity = await ctx.provider.identifyBootstrapToken(TOKEN);
      if (identity.state !== "unassigned") throw new Error("expected unassigned");
      ctx.kube.calls.length = 0;
      return { ...ctx, identity, labels };
    }

    it("costs one pod GET while the pod stays unclaimed (no TokenReview, no namespace)", async () => {
      const { kube, provider, identity } = await unassignedPod();
      const review = vi.spyOn(kube, "reviewToken");
      await expect(provider.recheckAssignment(identity)).resolves.toEqual(identity);
      expect(kube.calls.map((c) => `${c.verb} ${c.kind}`)).toEqual(["get Pod"]);
      expect(review).not.toHaveBeenCalled();
    });

    it("resolves the principal once the claim label lands", async () => {
      const { kube, provider, identity, pod, handle, labels } = await unassignedPod();
      kube.seed({ ...pod, metadata: { ...pod.metadata, labels } });
      await expect(provider.recheckAssignment(identity)).resolves.toEqual({
        state: "assigned",
        principal: { sandboxId: handle.sandboxId, teamId: TEAM.id, userId: USER },
        namespace: NS,
        podName: handle.podName,
      });
    });

    it("refuses once the pod is gone or replaced", async () => {
      const { kube, provider, identity, pod } = await unassignedPod();
      kube.seed({
        ...pod,
        metadata: { ...pod.metadata, uid: "00000000-0000-4000-8000-000000000000" },
      });
      await expect(provider.recheckAssignment(identity)).rejects.toThrow(SandboxAuthError);
    });
  });

  it("does not trust a pod's claim label that does not match the claim", async () => {
    const { kube, provider, pod } = await withSandbox();
    kube.seed({
      ...pod,
      metadata: {
        ...pod.metadata,
        labels: {
          ...pod.metadata.labels,
          [LABEL_CLAIM_UID]: "00000000-0000-4000-8000-000000000000",
        },
      },
    });
    await expect(provider.identifyBootstrapToken(TOKEN)).resolves.toMatchObject({
      state: "unassigned",
    });
  });

  it("takes the team from the namespace, refusing a claim that names another team", async () => {
    const { kube, provider, handle } = await withSandbox();
    const claim = must(objectAt(kube, "SandboxClaim", handle.claimName, NS));
    kube.seed({
      ...claim,
      metadata: {
        ...claim.metadata,
        annotations: { ...claim.metadata.annotations, [LABEL_TEAM_ID]: OTHER_TEAM.id },
      },
    });
    await expect(provider.identifyBootstrapToken(TOKEN)).rejects.toThrow(/identity mismatch/);
  });

  it("deletes a claimed sandbox whose pod is not under the verified runtime", async () => {
    const { kube, provider, pod } = await withSandbox();
    kube.seed({ ...pod, spec: { ...(pod.spec as object), runtimeClassName: "runc" } });
    await expect(provider.identifyBootstrapToken(TOKEN)).rejects.toThrow(
      IsolationRuntimeMissingError,
    );
    expect(kube.all("SandboxClaim")).toHaveLength(0);
  });

  it("refuses a malformed user id annotation with 401, not an internal error", async () => {
    const { kube, provider, pod } = await withSandbox();
    kube.seed({
      ...pod,
      metadata: {
        ...pod.metadata,
        annotations: {
          ...pod.metadata.annotations,
          "kobe.splittingatom.io/user-id": "-".repeat(36),
        },
      },
    });
    await expect(provider.identifyBootstrapToken(TOKEN)).rejects.toThrow(SandboxAuthError);
  });

  it("refuses a pod that predates a recreated RuntimeClass", async () => {
    const { kube, provider } = await withSandbox();
    recreateRuntimeClass(kube);
    await expect(provider.identifyBootstrapToken(TOKEN)).rejects.toThrow(
      IsolationRuntimeMissingError,
    );
  });

  it("hands out nothing without isolation", async () => {
    const { kube, provider } = await withSandbox();
    kube.seed({
      apiVersion: "node.k8s.io/v1",
      kind: "RuntimeClass",
      metadata: { name: "gvisor" },
      handler: "runc",
    });
    await expect(provider.identifyBootstrapToken(TOKEN)).rejects.toThrow(
      IsolationRuntimeMissingError,
    );
  });
});
