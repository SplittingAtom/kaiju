import type { VerifiedIsolation } from "../isolation/gate.js";
import type { SandboxSettings } from "./config.js";
import {
  ANNOTATION_EVAL_RUN,
  ANNOTATION_EVAL_THREAD,
  ANNOTATION_TEAM_ID,
  ANNOTATION_USER_ID,
  LABEL_EVAL_THREAD,
  LABEL_SKILL_EVAL,
  LABEL_USER_ID,
  namesOf,
  type NamingSettings,
} from "./constants.js";
import {
  assertUserId,
  isUuid,
  managedLabelsOf,
  sandboxPodSpec,
  type EndpointAddresses,
  type KubeObject,
  type TeamRef,
} from "./manifests.js";
import { evalQuotaHard, memberQuotaHard } from "./eval-quota.js";

// Skill eval sandboxes (KOBE-325, SK16): one ephemeral sandbox per eval execution, in the team
// namespace beside the members' sandboxes. Same pod as a member's (same RuntimeClass, the same
// namespace NetworkPolicy: server wire, model gateway, MCP proxy and egress proxy only; no Secret;
// only session tokens), except: `/workspace` is an emptyDir (gone with the pod), workspace sync
// is off, and the pod has the eval PriorityClass (low, never preempts) that the eval quota counts.

/** One SandboxClaim per eval thread. */
export const evalClaimName = (threadId: string): string => {
  if (!isUuid(threadId)) throw new Error("eval thread id must be a UUID");
  return `e-${threadId}`;
};

/** The eval thread of an eval claim name, or undefined for any other name. */
export const evalThreadOfClaim = (name: string): string | undefined => {
  const id = /^e-(.+)$/.exec(name)?.[1];
  return id && isUuid(id) ? id : undefined;
};

/**
 * The members' share (M1, KOBE-325): every pod but an eval's (`NotIn`, which matches a pod without
 * a priorityClassName too) stays within `teamQuota`, whatever the evals do.
 */
export function memberResourceQuotaManifest(namespace: string, s: SandboxSettings): KubeObject {
  const names = namesOf(s);
  return {
    apiVersion: "v1",
    kind: "ResourceQuota",
    metadata: { name: names.memberResourceQuota, namespace, labels: managedLabelsOf(names) },
    spec: {
      hard: memberQuotaHard(s),
      scopeSelector: {
        matchExpressions: [
          { scopeName: "PriorityClass", operator: "NotIn", values: [names.evalPriorityClass] },
        ],
      },
    },
  };
}

export function evalResourceQuotaManifest(namespace: string, s: SandboxSettings): KubeObject {
  const names = namesOf(s);
  return {
    apiVersion: "v1",
    kind: "ResourceQuota",
    metadata: { name: names.evalResourceQuota, namespace, labels: managedLabelsOf(names) },
    spec: {
      hard: evalQuotaHard(s),
      scopeSelector: {
        matchExpressions: [
          { scopeName: "PriorityClass", operator: "In", values: [names.evalPriorityClass] },
        ],
      },
    },
  };
}

/** The member pod spec, with an emptyDir workspace, workspace sync off and the eval priority. */
export function evalSandboxPodSpec(
  isolation: VerifiedIsolation,
  s: SandboxSettings,
  addresses: EndpointAddresses,
): Record<string, unknown> {
  const spec = sandboxPodSpec(isolation, s, addresses) as {
    containers: { env: { name: string; value: string }[] }[];
    volumes: Record<string, unknown>[];
  } & Record<string, unknown>;
  const containers = spec.containers.map((c) => ({
    ...c,
    env: c.env.map((e) =>
      e.name === "KAIJU_WORKSPACE_SYNC_INTERVAL_MS" ? { ...e, value: "0" } : e,
    ),
  }));
  return {
    ...spec,
    priorityClassName: namesOf(s).evalPriorityClass,
    containers,
    volumes: [
      { name: "workspace", emptyDir: { sizeLimit: s.skillEval.workspaceSize } },
      ...spec.volumes,
    ],
  };
}

export function evalSandboxTemplateManifest(
  namespace: string,
  isolation: VerifiedIsolation,
  s: SandboxSettings,
  addresses: EndpointAddresses,
): KubeObject {
  const names = namesOf(s);
  const managedLabels = managedLabelsOf(names);
  return {
    apiVersion: "extensions.agents.x-k8s.io/v1beta1",
    kind: "SandboxTemplate",
    metadata: { name: names.evalTemplate, namespace, labels: managedLabels },
    spec: {
      networkPolicyManagement: "Unmanaged",
      envVarsInjectionPolicy: "Disallowed",
      volumeClaimTemplatesPolicy: "Disallowed",
      service: false,
      podTemplate: {
        metadata: {
          labels: {
            ...managedLabels,
            "app.kubernetes.io/name": names.sandboxAppName,
            [LABEL_SKILL_EVAL]: "true",
          },
        },
        spec: evalSandboxPodSpec(isolation, s, addresses),
      },
    },
  };
}

/** A claim needs a warm pool (agent-sandbox v1.0.4); this one keeps no idle pods. */
export function evalWarmPoolManifest(namespace: string, s: NamingSettings): KubeObject {
  const names = namesOf(s);
  return {
    apiVersion: "extensions.agents.x-k8s.io/v1beta1",
    kind: "SandboxWarmPool",
    metadata: { name: names.evalWarmPool, namespace, labels: managedLabelsOf(names) },
    spec: {
      replicas: 0,
      sandboxTemplateRef: { name: names.evalTemplate },
      updateStrategy: { type: "Recreate" },
    },
  };
}

export interface EvalClaimSpec {
  readonly userId: string;
  readonly threadId: string;
  readonly evalRunId: string;
  /** When the cluster deletes the claim even if no server replica is left to (backstop). */
  readonly shutdownAt: Date;
}

/** An eval execution's sandbox. Its UID is the sandbox id (session token `sub`). */
export function evalClaimManifest(
  namespace: string,
  team: TeamRef,
  c: EvalClaimSpec,
  s: NamingSettings,
): KubeObject {
  assertUserId(c.userId);
  const names = namesOf(s);
  if (!isUuid(c.evalRunId)) throw new Error("eval run id must be a UUID");
  const identity = {
    [ANNOTATION_TEAM_ID]: team.id,
    [ANNOTATION_USER_ID]: c.userId,
    [ANNOTATION_EVAL_THREAD]: c.threadId,
    [ANNOTATION_EVAL_RUN]: c.evalRunId,
  };
  return {
    apiVersion: "extensions.agents.x-k8s.io/v1beta1",
    kind: "SandboxClaim",
    metadata: {
      name: evalClaimName(c.threadId),
      namespace,
      labels: {
        ...managedLabelsOf(names),
        [LABEL_USER_ID]: c.userId,
        [LABEL_SKILL_EVAL]: "true",
        [LABEL_EVAL_THREAD]: c.threadId,
      },
      annotations: identity,
    },
    spec: {
      warmPoolRef: { name: names.evalWarmPool },
      lifecycle: { shutdownTime: c.shutdownAt.toISOString(), shutdownPolicy: "Delete" },
      additionalPodMetadata: { annotations: identity },
    },
  };
}
