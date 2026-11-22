import { describe, expect, it, vi } from "vitest";
import { FAILURE_MESSAGES } from "../runs/failure-codes.js";
import { SandboxWakeError } from "../sandbox-wire/types.js";
import {
  ensureReady,
  SANDBOX_FAILED_MESSAGE,
  WORKSPACE_QUOTA_MESSAGE,
  WORKSPACE_UNAVAILABLE_MESSAGE,
  WORKSPACE_VOLUME_LOST_MESSAGE,
  WORKSPACE_VOLUME_UNREACHABLE_MESSAGE,
  type ReadyProvider,
} from "./ready.js";

const stall = {
  cause: "volume_unschedulable",
  detail: "FailedAttachVolume: insufficient storage on node compute2",
  definite: true,
} as const;
const log = { warn: vi.fn(), error: vi.fn() } as never;
const TEAM = { id: "t", slug: "finance" };

function run(awaitReady: ReadyProvider["awaitReady"]) {
  const onStalled = vi.fn(async () => {});
  const result = ensureReady({
    provider: { awaitReady },
    team: TEAM,
    userId: "u",
    since: 123,
    log,
    onStalled,
  });
  return { result, onStalled, awaitReady };
}

describe("ensureReady", () => {
  it("does nothing more for a Ready sandbox", async () => {
    const r = run(vi.fn(async () => ({ ready: true as const })));
    await expect(r.result).resolves.toBeUndefined();
    expect(r.onStalled).not.toHaveBeenCalled();
    expect(r.awaitReady).toHaveBeenCalledWith(TEAM, "u", 123);
  });

  it("fails with a member-safe error and tells admins the reason", async () => {
    const r = run(async () => ({ ready: false, sandboxId: "sb-1", stall }));
    const err = await r.result.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxWakeError);
    expect(err).toMatchObject({
      code: "workspace_unavailable",
      message: WORKSPACE_UNAVAILABLE_MESSAGE,
    });
    expect((err as Error).message).not.toMatch(/compute2|volume|storage on node/);
    expect(r.onStalled).toHaveBeenCalledWith({ sandboxId: "sb-1", stall });
  });

  it("an ended pod (KOBE-636) fails `sandbox_failed` in plain words, and admins still get why", async () => {
    const ended = {
      cause: "pod_failed",
      detail: 'pod Failed: Evicted: Usage of EmptyDir volume "home" exceeds the limit "1Gi".',
      definite: true,
    } as const;
    const r = run(async () => ({ ready: false, sandboxId: "sb-1", stall: ended }));
    const err = await r.result.catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "sandbox_failed", message: SANDBOX_FAILED_MESSAGE });
    expect(SANDBOX_FAILED_MESSAGE).toMatch(/\/workspace/);
    // The run's card shows the server's own text for the code: the same words.
    expect(FAILURE_MESSAGES["sandbox_failed"]).toBe(SANDBOX_FAILED_MESSAGE);
    expect(r.onStalled).toHaveBeenCalledWith({ sandboxId: "sb-1", stall: ended });
  });

  it("a full team volume quota (KOBE-733) fails with its own code and words", async () => {
    const full = {
      cause: "volume_quota",
      detail: "quota kobe-team-member-quota: persistentvolumeclaims used 50 of 50",
      definite: true,
    } as const;
    const r = run(async () => ({ ready: false, sandboxId: "sb-1", stall: full }));
    const err = await r.result.catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: "workspace_quota_exhausted",
      message: WORKSPACE_QUOTA_MESSAGE,
    });
    expect(WORKSPACE_QUOTA_MESSAGE).toMatch(/team admin/);
    expect(WORKSPACE_QUOTA_MESSAGE).not.toMatch(/kobe-team|50 of 50/);
    expect(FAILURE_MESSAGES["workspace_quota_exhausted"]).toBe(WORKSPACE_QUOTA_MESSAGE);
    expect(r.onStalled).toHaveBeenCalledWith({ sandboxId: "sb-1", stall: full });
  });

  it("a lost volume (KOBE-739) fails with its own code; the member is offered the rebuild", async () => {
    const lost = {
      cause: "volume_lost",
      detail: "volume pvc-abc lives only on node compute4, which no longer exists",
      definite: true,
    } as const;
    const r = run(async () => ({ ready: false, sandboxId: "sb-1", stall: lost }));
    const err = await r.result.catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: "workspace_volume_lost",
      message: WORKSPACE_VOLUME_LOST_MESSAGE,
    });
    expect(WORKSPACE_VOLUME_LOST_MESSAGE).toMatch(/last sync/);
    expect(WORKSPACE_VOLUME_LOST_MESSAGE).not.toMatch(/compute4|pvc-abc/);
    expect(FAILURE_MESSAGES["workspace_volume_lost"]).toBe(WORKSPACE_VOLUME_LOST_MESSAGE);
    expect(r.onStalled).toHaveBeenCalledWith({ sandboxId: "sb-1", stall: lost });
  });

  it("a node that is down (KOBE-739) is unreachable until the grace verdict says lost", async () => {
    const down = {
      cause: "volume_node_down",
      detail: "volume pvc-abc lives only on node compute4, which does not exist",
      definite: true,
      volume: {
        state: "node_down",
        reason: "node_gone",
        node: "compute4",
        detail: "volume pvc-abc lives only on node compute4, which does not exist",
      },
    } as const;
    const awaitReady = async () => ({ ready: false as const, sandboxId: "sb-1", stall: down });
    const run2 = (nodeDownIsLost?: () => Promise<boolean>) =>
      ensureReady({
        provider: { awaitReady },
        team: TEAM,
        userId: "u",
        since: 1,
        log,
        onStalled: async () => {},
        ...(nodeDownIsLost ? { nodeDownIsLost } : {}),
      }).catch((e: unknown) => e);
    expect(await run2()).toMatchObject({ code: "workspace_volume_unreachable" });
    expect(await run2(async () => false)).toMatchObject({
      code: "workspace_volume_unreachable",
      message: WORKSPACE_VOLUME_UNREACHABLE_MESSAGE,
    });
    expect(await run2(async () => true)).toMatchObject({ code: "workspace_volume_lost" });
    expect(FAILURE_MESSAGES["workspace_volume_unreachable"]).toBe(
      WORKSPACE_VOLUME_UNREACHABLE_MESSAGE,
    );
    // The lost text says the files are not recovered even if the server comes back.
    expect(WORKSPACE_VOLUME_LOST_MESSAGE).toMatch(/even if that server comes back/);
  });
});
