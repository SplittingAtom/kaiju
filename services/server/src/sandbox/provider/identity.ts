import type { VerifiedIsolation } from "../../isolation/gate.js";
import {
  ANNOTATION_EVAL_THREAD,
  ANNOTATION_TEAM_ID,
  ANNOTATION_USER_ID,
  BOOTSTRAP_TOKEN_AUDIENCE,
  LABEL_CLAIM_UID,
  LABEL_TEAM_ID,
  SANDBOX_SERVICE_ACCOUNT,
  TEAM_NAMESPACE_PREFIX,
} from "../constants.js";
import { evalClaimName } from "../eval-manifests.js";
import { claimName, isUuid, type KubeObject } from "../manifests.js";
import { SandboxAuthError } from "./errors.js";
import { CLAIM, POD, ref, str } from "./kube-objects.js";
import type { ProviderContext } from "./context.js";
import type { SandboxProvider } from "./types.js";
import type { BootstrapIdentity, UnassignedIdentity } from "./types.js";

/**
 * Who a sandbox pod is (KOBE-22, KOBE-417): its projected bootstrap token reviewed, its pod and
 * claim matched by UID and identity annotations, and its runtime re-verified before any
 * credentials are handed out (split out of provider.ts by KOBE-710).
 */

const POD_NAME_EXTRA = "authentication.kubernetes.io/pod-name";
const POD_UID_EXTRA = "authentication.kubernetes.io/pod-uid";
const SANDBOX_USER = new RegExp(
  `^system:serviceaccount:(${TEAM_NAMESPACE_PREFIX}[a-z0-9]([a-z0-9-]*[a-z0-9])?):${SANDBOX_SERVICE_ACCOUNT}$`,
);

export function createIdentityOps(
  ctx: ProviderContext,
): Pick<SandboxProvider, "identifyBootstrapToken" | "recheckAssignment"> {
  const { kube, isolation, stillVerified, rejectAndDelete } = ctx;

  const identifyBootstrapToken = async (token: string): Promise<BootstrapIdentity> => {
    if (!/^[A-Za-z0-9_.-]{20,8192}$/.test(token)) throw new SandboxAuthError("malformed token");
    const review = await kube.reviewToken(token, [BOOTSTRAP_TOKEN_AUDIENCE]);
    if (!review.authenticated || !review.audiences.includes(BOOTSTRAP_TOKEN_AUDIENCE)) {
      throw new SandboxAuthError("token rejected by the TokenReview");
    }
    const namespace = SANDBOX_USER.exec(review.username ?? "")?.[1];
    const podName = review.extra[POD_NAME_EXTRA]?.[0];
    const podUid = review.extra[POD_UID_EXTRA]?.[0];
    if (!namespace || !podName || !podUid) {
      throw new SandboxAuthError("not a pod-bound token of a team sandbox ServiceAccount");
    }
    // Agent work again: a fresh isolation check before handing out credentials.
    const verified = await isolation.require();
    const pod = await kube.get(POD(namespace, podName));
    if (!pod || pod.metadata.uid !== podUid || pod.metadata.deletionTimestamp) {
      throw new SandboxAuthError(`pod ${namespace}/${podName} is gone`);
    }
    const ns = await kube.get(ref("v1", "Namespace", namespace));
    const teamId = ns?.metadata.labels?.[LABEL_TEAM_ID];
    if (!teamId) throw new SandboxAuthError(`namespace ${namespace} is not a team namespace`);
    return resolvePod(pod, { state: "unassigned", namespace, podName, podUid, teamId }, verified);
  };

  const recheckAssignment = async (u: UnassignedIdentity): Promise<BootstrapIdentity> => {
    const pod = await kube.get(POD(u.namespace, u.podName));
    if (!pod || pod.metadata.uid !== u.podUid || pod.metadata.deletionTimestamp) {
      throw new SandboxAuthError(`pod ${u.namespace}/${u.podName} is gone`);
    }
    if (!pod.metadata.labels?.[LABEL_CLAIM_UID]) return u;
    return resolvePod(pod, u, await isolation.require());
  };

  /** The pod's claim, checked against the claim object and the verified runtime. */
  const resolvePod = async (
    pod: KubeObject,
    unassigned: UnassignedIdentity,
    verified: VerifiedIsolation,
  ): Promise<BootstrapIdentity> => {
    const { namespace, podName, teamId } = unassigned;
    const claimUid = pod.metadata.labels?.[LABEL_CLAIM_UID];
    const userId = pod.metadata.annotations?.[ANNOTATION_USER_ID];
    // KOBE-325: an eval sandbox's pod names its eval thread; its claim is `e-<thread>`, never the
    // member's, and the claim (found by name, matched by UID below) must name the same thread.
    const evalThreadId = pod.metadata.annotations?.[ANNOTATION_EVAL_THREAD];
    if (!claimUid || !userId) return unassigned;
    if (!isUuid(userId) || (evalThreadId !== undefined && !isUuid(evalThreadId)))
      throw new SandboxAuthError(`pod ${namespace}/${podName} has a malformed identity`);
    const claim = await kube.get(
      CLAIM(namespace, evalThreadId ? evalClaimName(evalThreadId) : claimName(userId)),
    );
    const controller = pod.metadata.ownerReferences?.find((o) => o.controller);
    if (
      !claim ||
      claim.metadata.uid !== claimUid ||
      claim.metadata.deletionTimestamp ||
      controller?.kind !== "Sandbox" ||
      str(claim, "status", "sandbox", "name") !== controller.name
    ) {
      return unassigned;
    }
    const annotations = claim.metadata.annotations ?? {};
    if (
      annotations[ANNOTATION_TEAM_ID] !== teamId ||
      annotations[ANNOTATION_USER_ID] !== userId ||
      annotations[ANNOTATION_EVAL_THREAD] !== evalThreadId
    ) {
      throw new SandboxAuthError(`claim ${namespace}/${claim.metadata.name} identity mismatch`);
    }
    if (
      str(pod, "spec", "runtimeClassName") !== verified.runtimeClassName ||
      !(await stillVerified(verified, pod))
    ) {
      return rejectAndDelete(
        { teamId, userId, sandboxId: claimUid },
        namespace,
        claim.metadata.name,
        "its pod is not under the verified runtime",
        podName,
      );
    }
    return {
      state: "assigned",
      principal: { sandboxId: claimUid, teamId, userId, ...(evalThreadId ? { evalThreadId } : {}) },
      namespace,
      podName,
    };
  };

  return { identifyBootstrapToken, recheckAssignment };
}
