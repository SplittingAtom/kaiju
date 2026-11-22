import { quantityBytes } from "../config.js";
import {
  assertTeamRef,
  assertUserId,
  claimName,
  teamNamespaceName,
  type TeamRef,
} from "../manifests.js";
import { podTermination } from "../pod-termination.js";
import { diagnoseStall, isPodReady } from "../stall-diagnosis.js";
import { SandboxProvisioningError } from "./errors.js";
import { CLAIM, POD, POD_NAME_ANNOTATION, SANDBOX, str, workspacePvcName } from "./kube-objects.js";
import type { ProviderContext } from "./context.js";
import type { SandboxProvider } from "./types.js";
import type { ReadyOutcome } from "./types.js";

/**
 * Waiting for a woken sandbox pod to be Ready, diagnosing it while it is not (KOBE-192; split out
 * of provider.ts by KOBE-710).
 */

const READY_DIAGNOSE_EVERY_MS = 5_000;

export function createReadinessOps(ctx: ProviderContext): Pick<SandboxProvider, "awaitReady"> {
  const { kube, settings, sleep, now, readyTimeoutMs } = ctx;

  /** The claim's Sandbox, pod name and workspace PVC name (undefined while they do not exist). */
  const locate = async (team: TeamRef, userId: string) => {
    const namespace = teamNamespaceName(team);
    const claim = await kube.get(CLAIM(namespace, claimName(userId)));
    const sandboxName = claim ? str(claim, "status", "sandbox", "name") : undefined;
    const sandbox = sandboxName ? await kube.get(SANDBOX(namespace, sandboxName)) : undefined;
    if (!claim?.metadata.uid || !sandboxName || !sandbox) return undefined;
    const podName = sandbox.metadata.annotations?.[POD_NAME_ANNOTATION] ?? sandboxName;
    return {
      namespace,
      sandboxId: claim.metadata.uid,
      sandbox,
      podName,
      pvcName: workspacePvcName(sandboxName),
    };
  };

  const awaitReady = async (
    team: TeamRef,
    userId: string,
    since: number,
  ): Promise<ReadyOutcome> => {
    assertTeamRef(team);
    assertUserId(userId);
    const deadline = now() + readyTimeoutMs;
    let nextDiagnosis = now() + READY_DIAGNOSE_EVERY_MS;
    for (;;) {
      const found = await locate(team, userId);
      if (!found) {
        throw new SandboxProvisioningError(`Sandbox for ${teamNamespaceName(team)} vanished`);
      }
      const pod = await kube.get(POD(found.namespace, found.podName));
      if (isPodReady(pod)) return { ready: true };
      const last = now() >= deadline;
      // An ended pod (KOBE-636) never becomes Ready: diagnose it now, not at the next interval.
      if (last || now() >= nextDiagnosis || podTermination(pod)) {
        nextDiagnosis = now() + READY_DIAGNOSE_EVERY_MS;
        const stall = await diagnoseStall(
          kube,
          found.namespace,
          found.podName,
          found.pvcName,
          since,
          now(),
          quantityBytes(settings.workspace.size),
          settings.volumeLoss.detection,
        );
        // Only a definite signal ends the wait early; otherwise the sandbox gets the whole budget.
        if (last || stall.definite) return { ready: false, sandboxId: found.sandboxId, stall };
      }
      await sleep(1000);
    }
  };

  return { awaitReady };
}
