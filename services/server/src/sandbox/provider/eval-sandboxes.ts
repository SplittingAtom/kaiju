import {
  ANNOTATION_EVAL_RUN,
  ANNOTATION_USER_ID,
  LABEL_SKILL_EVAL,
  LABEL_TEAM_ID,
  LABEL_TEAM_NAMESPACE,
  namesOf,
} from "../constants.js";
import { evalClaimName, evalThreadOfClaim, type EvalClaimSpec } from "../eval-manifests.js";
import { isUuid, teamNamespaceName, type TeamRef } from "../manifests.js";
import type { ClaimOps } from "./claims.js";
import { SandboxProvisioningError } from "./errors.js";
import { CLAIM } from "./kube-objects.js";
import type { ProviderContext } from "./context.js";
import type { SandboxProvider } from "./types.js";
import type { EvalSandboxInfo, SandboxHandle } from "./types.js";

/**
 * Skill eval sandboxes (KOBE-325): an eval thread's own short-lived claim from the eval pool, its
 * deletion, and the reaper's list across team namespaces (split out of provider.ts by KOBE-710).
 */

export function createEvalSandboxOps(
  ctx: ProviderContext,
  { provision }: Pick<ClaimOps, "provision">,
): Pick<SandboxProvider, "createEvalSandbox" | "deleteEvalSandbox" | "listEvalSandboxes"> {
  const { kube, deleteWithRetry, settings } = ctx;
  const { prefix } = namesOf(settings);

  const createEvalSandbox = async (
    team: TeamRef,
    spec: EvalClaimSpec,
    podWaitMs?: number,
  ): Promise<SandboxHandle> => {
    const { handle } = await provision(team, spec.userId, false, spec, podWaitMs);
    if (handle.state !== "running") {
      throw new SandboxProvisioningError(`Eval sandbox ${handle.claimName} is not running`);
    }
    return handle;
  };

  const deleteEvalSandbox = async (team: TeamRef, threadId: string): Promise<boolean> =>
    deleteWithRetry(CLAIM(teamNamespaceName(team, settings), evalClaimName(threadId)));

  const listEvalSandboxes = async (): Promise<EvalSandboxInfo[]> => {
    const namespaces = await kube.list(
      "v1",
      "Namespace",
      undefined,
      `${LABEL_TEAM_NAMESPACE}=true`,
    );
    const out: EvalSandboxInfo[] = [];
    for (const ns of namespaces) {
      const teamId = ns.metadata.labels?.[LABEL_TEAM_ID];
      if (!teamId || !isUuid(teamId) || !ns.metadata.name.startsWith(prefix)) continue;
      const claims = await kube.list(
        CLAIM(ns.metadata.name, "x").apiVersion,
        "SandboxClaim",
        ns.metadata.name,
        `${LABEL_SKILL_EVAL}=true`,
      );
      for (const c of claims) {
        const threadId = evalThreadOfClaim(c.metadata.name);
        if (!threadId) continue;
        const a = c.metadata.annotations ?? {};
        out.push({
          teamId,
          namespace: ns.metadata.name,
          claimName: c.metadata.name,
          threadId,
          userId: a[ANNOTATION_USER_ID],
          evalRunId: a[ANNOTATION_EVAL_RUN],
          createdAt: Date.parse(c.metadata.creationTimestamp ?? "") || 0,
        });
      }
    }
    return out;
  };

  return { createEvalSandbox, deleteEvalSandbox, listEvalSandboxes };
}
