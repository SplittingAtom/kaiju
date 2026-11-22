import { describe, expect, it } from "vitest";
import { TEAM, USER, must } from "../testing/sandbox-fixtures.js";
import { BOOTSTRAP_TOKEN_AUDIENCE } from "./constants.js";
import { NS, objectAt, setup } from "../testing/provider-setup.js";

/** Skill eval sandboxes (KOBE-325; split out of provider.test.ts by KOBE-710). */

describe("skill eval sandboxes (KOBE-325)", () => {
  const THREAD = "22222222-2222-4222-8222-222222222222";
  const RUN = "33333333-3333-4333-8333-333333333333";
  const TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ5In0.c2lnbmF0dXJl";
  const spec = {
    userId: USER,
    threadId: THREAD,
    evalRunId: RUN,
    shutdownAt: new Date(Date.UTC(2030, 0, 1)),
  };

  it("claims e-<thread> from the eval pool, beside the member's own claim, with a cluster-side shutdown", async () => {
    const { kube, provider } = setup();
    const own = await provider.ensureSandbox(TEAM, USER);
    const handle = await provider.createEvalSandbox(TEAM, spec);
    expect(handle.claimName).toBe(`e-${THREAD}`);
    expect(handle.sandboxId).not.toBe(own.sandboxId);
    const claim = must(objectAt(kube, "SandboxClaim", `e-${THREAD}`, NS));
    expect(claim.metadata.labels).toMatchObject({
      "kobe.splittingatom.io/skill-eval": "true",
      "kobe.splittingatom.io/eval-thread-id": THREAD,
    });
    expect(claim.spec).toMatchObject({
      warmPoolRef: { name: "kobe-skill-eval" },
      lifecycle: { shutdownTime: "2030-01-01T00:00:00.000Z", shutdownPolicy: "Delete" },
    });
    expect(objectAt(kube, "SandboxClaim", `u-${USER}`, NS)).toBeDefined();
    expect(await provider.listEvalSandboxes()).toMatchObject([
      { teamId: TEAM.id, threadId: THREAD, userId: USER, evalRunId: RUN },
    ]);
  });

  it("is live only as its own claim, never as the member's, and identifies its pod as the eval thread's", async () => {
    const { kube, provider } = setup();
    const own = await provider.ensureSandbox(TEAM, USER);
    const handle = await provider.createEvalSandbox(TEAM, spec);
    expect(await provider.isLive(TEAM, USER, handle.sandboxId, THREAD)).toBe(true);
    expect(await provider.isLive(TEAM, USER, handle.sandboxId)).toBe(false);
    expect(await provider.isLive(TEAM, USER, own.sandboxId, THREAD)).toBe(false);
    const pod = must(objectAt(kube, "Pod", must(handle.podName), NS));
    kube.tokens.set(TOKEN, {
      authenticated: true,
      audiences: [BOOTSTRAP_TOKEN_AUDIENCE],
      username: `system:serviceaccount:${NS}:kobe-sandbox`,
      extra: {
        "authentication.kubernetes.io/pod-name": [pod.metadata.name],
        "authentication.kubernetes.io/pod-uid": [pod.metadata.uid as string],
      },
    });
    await expect(provider.identifyBootstrapToken(TOKEN)).resolves.toMatchObject({
      state: "assigned",
      principal: {
        sandboxId: handle.sandboxId,
        teamId: TEAM.id,
        userId: USER,
        evalThreadId: THREAD,
      },
    });
    expect(await provider.deleteEvalSandbox(TEAM, THREAD)).toBe(true);
    expect(await provider.isLive(TEAM, USER, handle.sandboxId, THREAD)).toBe(false);
  });
});
