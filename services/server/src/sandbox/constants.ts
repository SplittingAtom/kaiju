/**
 * Names and labels shared by the sandbox provider, the chart (templates/sandbox-*.yaml) and the
 * e2e suite. A chart render test keeps the chart's copies equal to these.
 */

/**
 * Spec D11: one namespace per team, `<prefix><slug>` (slug ≤ 32 chars, so ≤ 43 chars). The prefix
 * is configuration (KOBE-751, chart value `sandbox.teamNamespacePrefix`): `kaiju-team-` on a fresh
 * install, `kobe-team-` on an install created before the rename, which keeps its namespaces.
 * Exactly these two: a free-form prefix would let the admission policy (which confines the
 * server's cluster-wide namespace writes to the prefix) cover namespaces Kaiju never created.
 */
export const TEAM_NAMESPACE_PREFIXES = ["kaiju-team-", "kobe-team-"] as const;
export type TeamNamespacePrefix = (typeof TEAM_NAMESPACE_PREFIXES)[number];
export const DEFAULT_TEAM_NAMESPACE_PREFIX: TeamNamespacePrefix = "kaiju-team-";

const DOMAIN = "kobe.splittingatom.io";
/** On every team namespace; the Bifrost NetworkPolicy admits sandboxes by it. */
export const LABEL_TEAM_NAMESPACE = `${DOMAIN}/team-namespace`;
/** Team id on the namespace: a namespace whose label names another team is never reused. */
export const LABEL_TEAM_ID = `${DOMAIN}/team-id`;
/** User id on a SandboxClaim (label, for listing) and on its pod (annotation, for operators). */
export const LABEL_USER_ID = `${DOMAIN}/user-id`;
export const ANNOTATION_TEAM_ID = LABEL_TEAM_ID;
export const ANNOTATION_USER_ID = LABEL_USER_ID;
/** On the pods (and Job, ConfigMap) of an Orbit eval (KOBE-93); the value is the eval id. */
export const LABEL_ORBIT_EVAL = `${DOMAIN}/orbit-eval`;
/**
 * On the pods (and Job, ConfigMap) of an external skill scan (KOBE-341); the value is the Registry
 * version id. Their own NetworkPolicy allows nothing (`skillScanNetworkPolicyManifest`).
 */
export const LABEL_SKILL_SCAN = `${DOMAIN}/skill-scan`;
/**
 * Skill eval sandboxes (KOBE-325): label `true` on their claims and pods (the reaper lists them by
 * it); the eval thread on the claim and pod (label for listing, annotation for identity).
 */
export const LABEL_SKILL_EVAL = `${DOMAIN}/skill-eval`;
export const LABEL_EVAL_THREAD = `${DOMAIN}/eval-thread-id`;
export const ANNOTATION_EVAL_THREAD = LABEL_EVAL_THREAD;
export const ANNOTATION_EVAL_RUN = `${DOMAIN}/eval-run-id`;
export const LABEL_MANAGED_BY = "app.kubernetes.io/managed-by";

/** Pod label the agent-sandbox claim controller sets to the owning claim's UID. */
export const LABEL_CLAIM_UID = "agents.x-k8s.io/claim-uid";

/**
 * Names of everything the server keeps in team namespaces, and the names it writes them under
 * (KOBE-751). One naming generation per prefix, so namespace names and object names can never
 * mix: `kaiju-team-` gives `kaiju-sandbox`, `kaiju-server`, ...; `kobe-team-` keeps the names an
 * install created before the rename already has (nothing is recreated on upgrade). The chart
 * derives the same generation for its own copies (the skill eval PriorityClass, the admission
 * policy's prefix): `kaiju.sandboxGeneration` in templates/_sandbox.tpl.
 */
export interface SandboxNames {
  readonly prefix: TeamNamespacePrefix;
  /** `app.kubernetes.io/managed-by` on every object the server creates there. */
  readonly managedBy: string;
  /** Server-side apply field manager (a new one would conflict with the old one's fields). */
  readonly fieldManager: string;
  /** The sandbox pods' identity (bootstrap token only: no RBAC binding, no API token). */
  readonly serviceAccount: string;
  /** Template and warm pool of members' sandboxes. */
  readonly template: string;
  readonly warmPool: string;
  /** The namespace-wide default-deny policy. */
  readonly networkPolicy: string;
  /** Egress policy for Orbit eval pods only (the namespace-wide policy leaves them out). */
  readonly evalNetworkPolicy: string;
  /**
   * No traffic for external skill scan pods (KOBE-341; the namespace-wide policy leaves them out).
   * Kept in every team namespace, so a pod with the scan label is never left without a policy.
   */
  readonly skillScanNetworkPolicy: string;
  readonly resourceQuota: string;
  /** Skill eval sandboxes (KOBE-325): their own template and (empty) warm pool per team. */
  readonly evalTemplate: string;
  readonly evalWarmPool: string;
  /**
   * Their own quota (scoped to their PriorityClass) inside the team's: the team quota is the
   * members' quota plus this one, so evals never use what members' sandboxes need.
   */
  readonly evalResourceQuota: string;
  /** The members' share: every pod but an eval's stays within `teamQuota`. */
  readonly memberResourceQuota: string;
  /** Low priority that never preempts: under node pressure a member's sandbox wins (chart object). */
  readonly evalPriorityClass: string;
  readonly limitRange: string;
  readonly serverRoleBinding: string;
  /** The projected bootstrap-token volume of sandbox pods. */
  readonly bootstrapVolume: string;
  /** `app.kubernetes.io/name` of sandbox, Orbit eval and skill scan pods. */
  readonly sandboxAppName: string;
  readonly orbitEvalAppName: string;
  readonly skillScanAppName: string;
}

const TEAM_SUFFIX = "-team-";

function namesOfGeneration(prefix: TeamNamespacePrefix): SandboxNames {
  const g = prefix.slice(0, -TEAM_SUFFIX.length);
  return Object.freeze({
    prefix,
    managedBy: `${g}-server`,
    fieldManager: `${g}-server`,
    serviceAccount: `${g}-sandbox`,
    template: `${g}-sandbox`,
    warmPool: `${g}-sandbox`,
    networkPolicy: `${g}-sandbox-isolation`,
    evalNetworkPolicy: `${g}-orbit-eval-isolation`,
    skillScanNetworkPolicy: `${g}-skill-scan`,
    resourceQuota: `${g}-team-quota`,
    evalTemplate: `${g}-skill-eval`,
    evalWarmPool: `${g}-skill-eval`,
    evalResourceQuota: `${g}-skill-eval-quota`,
    memberResourceQuota: `${g}-team-member-quota`,
    evalPriorityClass: `${g}-skill-eval`,
    limitRange: `${g}-sandbox-defaults`,
    serverRoleBinding: `${g}-server`,
    bootstrapVolume: `${g}-bootstrap`,
    sandboxAppName: `${g}-sandbox`,
    orbitEvalAppName: `${g}-orbit-eval`,
    skillScanAppName: `${g}-skill-scan`,
  });
}

const NAMES: Readonly<Record<TeamNamespacePrefix, SandboxNames>> = Object.freeze(
  Object.fromEntries(TEAM_NAMESPACE_PREFIXES.map((p) => [p, namesOfGeneration(p)])) as Record<
    TeamNamespacePrefix,
    SandboxNames
  >,
);

/** The naming generation of a team namespace prefix. */
export const sandboxNames = (prefix: TeamNamespacePrefix): SandboxNames => {
  const names = NAMES[prefix];
  if (!names) throw new TypeError(`unknown team namespace prefix "${String(prefix)}"`);
  return names;
};

/** Anything carrying the configured prefix (the sandbox settings). */
export interface NamingSettings {
  readonly teamNamespacePrefix: TeamNamespacePrefix;
}

export const namesOf = (s: NamingSettings): SandboxNames => sandboxNames(s.teamNamespacePrefix);

export const SANDBOX_CONTAINER = "agent";

/**
 * Audience of the projected ServiceAccount token in each sandbox pod. The pod trades it at the
 * server (POST /v1/sandbox/session, verified with a TokenReview) for its audience-bound session
 * tokens. The Kubernetes API rejects tokens with this audience, so it grants no API access.
 */
export const BOOTSTRAP_TOKEN_AUDIENCE = "kobe.sandbox-bootstrap";
/**
 * Under the image's agent-only directory (`/run/kaiju-agent`, 0700, KOBE-71): the projected file
 * itself is group-readable by the pod's fsGroup, which every Pi identity shares (the workspace
 * group), so only the parent keeps sandbox code out.
 */
export const BOOTSTRAP_TOKEN_DIR = "/run/kaiju-agent/bootstrap";
export const BOOTSTRAP_TOKEN_FILE = `${BOOTSTRAP_TOKEN_DIR}/bootstrap-token`;
/** Kubelet refreshes the projected token at 80% of this lifetime. */
export const BOOTSTRAP_TOKEN_SECONDS = 3600;

/**
 * Hostnames sandboxes use for Kaiju's services. They resolve through /etc/hosts (pod hostAliases
 * pointing at the Services' ClusterIPs): sandboxes get no DNS at all, so DNS cannot be used as an
 * exfiltration channel around the default-deny egress policy. `.internal` is reserved for private use.
 */
export const SANDBOX_HOSTS = {
  server: "server.kaiju.internal",
  modelGateway: "model-gateway.kaiju.internal",
  mcpProxy: "mcp-proxy.kaiju.internal",
  egressProxy: "egress-proxy.kaiju.internal",
} as const;
export type KaijuEndpoint = keyof typeof SANDBOX_HOSTS;
export const KAIJU_ENDPOINTS = Object.keys(SANDBOX_HOSTS) as KaijuEndpoint[];

/**
 * Pod Security Admission level enforced on team namespaces. "baseline", not "restricted", for
 * one reason only (KOBE-71): the sandbox container adds the SETUID and SETGID capabilities and
 * allows privilege escalation, so the image's kaiju-runas helper can start each Pi process under
 * its own uid. Everything else "restricted" demands (non-root, seccomp, drop ALL, volume types)
 * is enforced by Kaiju's own admission policy for team pods (chart: sandbox-admission.yaml).
 */
export const POD_SECURITY_LEVEL = "baseline";
/** UID/GID of the `kaiju` user in images/sandbox/Dockerfile (the agent; the workspace group). */
export const SANDBOX_UID = 1000;
/** Group `kaiju-agent` in the image: the only group allowed to execute kaiju-runas (KOBE-71). */
export const SANDBOX_AGENT_GID = 1001;
/** First Pi identity (`kaiju-pi-0`, uid = gid) in the image; kaiju-runas accepts 2000-2063. */
export const PI_IDENTITY_BASE = 2000;
/**
 * First partner (tool) identity (`kaiju-tool-0`, uid = gid; KOBE-166): Pi identity `n` is paired
 * with `PARTNER_IDENTITY_BASE + n`, which kaiju-runas accepts in 3000-3063. The agent gets their
 * groups as well as the Pi ones. Keep equal to PI_IDENTITY_BASE + 1000
 * (services/sandbox-agent `PARTNER_UID_OFFSET`).
 */
export const PARTNER_IDENTITY_BASE = 3000;
/**
 * Pi identities per sandbox: more than the agent's Pi process cap (8 by default) so a new Pi need
 * not wait while an exited one's identity is being reclaimed.
 */
export const PI_IDENTITIES = 16;
/**
 * Where each Pi process gets its private runtime directory (KOBE-71): a memory-backed emptyDir,
 * because its root is sticky (3777) and a mount point, so no Pi identity can rename the agent's
 * directories in it (on the disk-backed /tmp, 2777, any of them could). Small: Pi keeps only its
 * credential and catalog stores and the model file there.
 */
export const PI_RUNTIME_DIR = "/run/kaiju-pi";
export const PI_RUNTIME_SIZE = "64Mi";
/**
 * Where kaiju-sandbox-agent materializes a run's effective skills (KOBE-82): a second memory-backed
 * emptyDir for the same reason as PI_RUNTIME_DIR (sticky root no Pi identity can rename in), so
 * the agent's read-only skill directories can't be swapped by a tool. Sized for the agent's cap
 * (96 MiB across all live threads' skills, services/sandbox-agent skills/store.ts).
 */
export const SKILLS_DIR = "/run/kaiju-skills";
export const SKILLS_SIZE = "128Mi";
/**
 * The agent's own store under SKILLS_DIR: one `sk-<sha256>/` per bundle (sandbox-agent
 * skills/store.ts `STORE_DIR`, `dirOf`). KOBE-297 matches SKILL.md reads against it.
 */
export const SKILLS_STORE_SUBDIR = "store";
/** The helper that starts Pi under its identity (images/sandbox/runas). */
export const PI_RUNAS_HELPER = "/opt/kaiju/bin/kaiju-runas";
/** The only capabilities a sandbox container adds (after dropping ALL), for kaiju-runas. */
export const SANDBOX_CAPABILITIES = ["SETUID", "SETGID"] as const;
