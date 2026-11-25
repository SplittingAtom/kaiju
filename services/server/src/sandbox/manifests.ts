import type { VerifiedIsolation } from "../isolation/gate.js";
import type { SandboxSettings } from "./config.js";
import { teamQuotaHard } from "./eval-quota.js";
import {
  ANNOTATION_TEAM_ID,
  ANNOTATION_USER_ID,
  BOOTSTRAP_TOKEN_AUDIENCE,
  BOOTSTRAP_TOKEN_DIR,
  BOOTSTRAP_TOKEN_FILE,
  BOOTSTRAP_TOKEN_SECONDS,
  KAIJU_ENDPOINTS,
  LABEL_MANAGED_BY,
  LABEL_ORBIT_EVAL,
  LABEL_SKILL_SCAN,
  LABEL_TEAM_ID,
  LABEL_TEAM_NAMESPACE,
  LABEL_USER_ID,
  PARTNER_IDENTITY_BASE,
  PI_IDENTITIES,
  PI_IDENTITY_BASE,
  PI_RUNAS_HELPER,
  PI_RUNTIME_DIR,
  PI_RUNTIME_SIZE,
  SKILLS_DIR,
  SKILLS_SIZE,
  POD_SECURITY_LEVEL,
  SANDBOX_AGENT_GID,
  SANDBOX_CAPABILITIES,
  SANDBOX_CONTAINER,
  SANDBOX_HOSTS,
  SANDBOX_UID,
  namesOf,
  type KaijuEndpoint,
  type NamingSettings,
  type SandboxNames,
} from "./constants.js";

/**
 * Pure builders for everything Kaiju puts into a team namespace (spec D11, D12). No I/O: the
 * provider applies them. Anything that builds a pod spec takes a VerifiedIsolation (KOBE-9
 * binding requirement), never a RuntimeClass name string.
 */

export interface KubeMetadata {
  readonly name: string;
  readonly namespace?: string;
  readonly uid?: string;
  /** Optimistic concurrency token (a merge patch carrying it fails with 409 if it changed). */
  readonly resourceVersion?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly annotations?: Readonly<Record<string, string>>;
  readonly creationTimestamp?: string;
  readonly deletionTimestamp?: string;
  readonly ownerReferences?: readonly {
    readonly apiVersion: string;
    readonly kind: string;
    readonly name: string;
    readonly uid: string;
    readonly controller?: boolean;
  }[];
}

/** A Kubernetes object as JSON (spec/status shapes are checked where they are read). */
export interface KubeObject {
  readonly apiVersion: string;
  readonly kind: string;
  readonly metadata: KubeMetadata;
  readonly [field: string]: unknown;
}

export interface TeamRef {
  /** teams.id (uuid). */
  readonly id: string;
  /** teams.slug: immutable, `^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$`. */
  readonly slug: string;
}

const SLUG = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function assertTeamRef(team: TeamRef): void {
  if (!SLUG.test(team.slug)) throw new TypeError(`invalid team slug "${team.slug}"`);
  if (!UUID.test(team.id)) throw new TypeError("team id must be a lowercase uuid");
}

export const isUuid = (value: string): boolean => UUID.test(value);

export function assertUserId(userId: string): void {
  if (!UUID.test(userId)) throw new TypeError("user id must be a lowercase uuid");
}

/** The team's namespace under the configured prefix (KOBE-751). */
export const teamNamespaceName = (team: TeamRef, s: NamingSettings): string => {
  assertTeamRef(team);
  return `${namesOf(s).prefix}${team.slug}`;
};

/** One SandboxClaim per (user, team): its name is derived from the user id. */
export const claimName = (userId: string): string => {
  assertUserId(userId);
  return `u-${userId}`;
};

/** `app.kubernetes.io/managed-by` of the objects the server creates in team namespaces. */
export const managedLabelsOf = (names: SandboxNames): Readonly<Record<string, string>> => ({
  [LABEL_MANAGED_BY]: names.managedBy,
});

export function namespaceManifest(team: TeamRef, s: NamingSettings): KubeObject {
  return {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: teamNamespaceName(team, s),
      labels: {
        ...managedLabelsOf(namesOf(s)),
        [LABEL_TEAM_NAMESPACE]: "true",
        [LABEL_TEAM_ID]: team.id,
        // Pod Security Admission: sandboxes are non-root, no privilege escalation, no capabilities.
        "pod-security.kubernetes.io/enforce": POD_SECURITY_LEVEL,
        "pod-security.kubernetes.io/enforce-version": "latest",
        // KOBE-71: enforced "baseline" (SETUID/SETGID for Pi identities); everything beyond that is
        // still reported against "restricted" (and Kaiju's admission policy enforces the rest).
        "pod-security.kubernetes.io/warn": "restricted",
        "pod-security.kubernetes.io/warn-version": "latest",
        "pod-security.kubernetes.io/audit": "restricted",
        "pod-security.kubernetes.io/audit-version": "latest",
      },
    },
  };
}

/** Grants the server the namespaced verbs it needs here, and nothing in any other namespace. */
export function serverRoleBindingManifest(namespace: string, s: SandboxSettings): KubeObject {
  return {
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "RoleBinding",
    metadata: {
      name: namesOf(s).serverRoleBinding,
      namespace,
      labels: managedLabelsOf(namesOf(s)),
    },
    roleRef: {
      apiGroup: "rbac.authorization.k8s.io",
      kind: "ClusterRole",
      name: s.managerClusterRole,
    },
    subjects: [
      { kind: "ServiceAccount", name: s.serverServiceAccount, namespace: s.releaseNamespace },
    ],
  };
}

/** Kaiju services sandboxes may open connections to (the model gateway only with modelGatewayAccess). */
export const sandboxEgressEndpoints = (s: SandboxSettings): KaijuEndpoint[] =>
  KAIJU_ENDPOINTS.filter((e) => e !== "modelGateway" || s.modelGatewayAccess);

/**
 * Default deny (spec D11, D28): no ingress at all; egress only to the Kaiju server, the model
 * gateway, the MCP proxy and the egress proxy pods, on their pod ports. No DNS (see SANDBOX_HOSTS).
 * Selects every pod in the namespace, so warm-pool pods and future Jobs are covered too.
 */
export function networkPolicyManifest(namespace: string, s: SandboxSettings): KubeObject {
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: namesOf(s).networkPolicy, namespace, labels: managedLabelsOf(namesOf(s)) },
    spec: {
      // Not eval pods (KOBE-93) or external skill scans (KOBE-341): policies are additive, so
      // they get their own, narrower ones.
      podSelector: {
        matchExpressions: [
          { key: LABEL_ORBIT_EVAL, operator: "DoesNotExist" },
          { key: LABEL_SKILL_SCAN, operator: "DoesNotExist" },
        ],
      },
      policyTypes: ["Ingress", "Egress"],
      ingress: [],
      egress: sandboxEgressEndpoints(s).map((e) => ({
        to: [
          {
            namespaceSelector: {
              matchLabels: { "kubernetes.io/metadata.name": s.releaseNamespace },
            },
            podSelector: { matchLabels: { ...s.endpoints[e].podLabels } },
          },
        ],
        ports: [{ protocol: "TCP", port: s.endpoints[e].targetPort }],
      })),
    },
  };
}

/**
 * Orbit eval pods (KOBE-93) may reach the model gateway and nothing else: no ingress, no DNS, no
 * server, MCP proxy or egress proxy. Selected by the eval label, which the namespace-wide policy
 * excludes, so this is the only policy that applies to them.
 */
export function evalNetworkPolicyManifest(namespace: string, s: SandboxSettings): KubeObject {
  const gateway = s.endpoints.modelGateway;
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: {
      name: namesOf(s).evalNetworkPolicy,
      namespace,
      labels: managedLabelsOf(namesOf(s)),
    },
    spec: {
      podSelector: { matchExpressions: [{ key: LABEL_ORBIT_EVAL, operator: "Exists" }] },
      policyTypes: ["Ingress", "Egress"],
      ingress: [],
      egress: [
        {
          to: [
            {
              namespaceSelector: {
                matchLabels: { "kubernetes.io/metadata.name": s.releaseNamespace },
              },
              podSelector: { matchLabels: { ...gateway.podLabels } },
            },
          ],
          ports: [{ protocol: "TCP", port: gateway.targetPort }],
        },
      ],
    },
  };
}

/**
 * External skill scans (KOBE-341): no ingress and no egress at all. The scan reads its package
 * from a ConfigMap and writes its result to its log; it needs nothing on the network.
 */
export function skillScanNetworkPolicyManifest(namespace: string, s: NamingSettings): KubeObject {
  const names = namesOf(s);
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: names.skillScanNetworkPolicy, namespace, labels: managedLabelsOf(names) },
    spec: {
      podSelector: { matchExpressions: [{ key: LABEL_SKILL_SCAN, operator: "Exists" }] },
      policyTypes: ["Ingress", "Egress"],
      ingress: [],
      egress: [],
    },
  };
}

export function resourceQuotaManifest(namespace: string, s: SandboxSettings): KubeObject {
  return {
    apiVersion: "v1",
    kind: "ResourceQuota",
    metadata: { name: namesOf(s).resourceQuota, namespace, labels: managedLabelsOf(namesOf(s)) },
    // The members' quota plus the skill-eval share (KOBE-325, `evalResourceQuota`).
    spec: { hard: teamQuotaHard(s) },
  };
}

/** Defaults for any container without resources, so the quota never rejects them for that. */
export function limitRangeManifest(namespace: string, s: SandboxSettings): KubeObject {
  return {
    apiVersion: "v1",
    kind: "LimitRange",
    metadata: { name: namesOf(s).limitRange, namespace, labels: managedLabelsOf(namesOf(s)) },
    spec: {
      limits: [
        {
          type: "Container",
          default: { ...s.resources.limits, "ephemeral-storage": s.ephemeralStorage.limit },
          defaultRequest: {
            ...s.resources.requests,
            "ephemeral-storage": s.ephemeralStorage.request,
          },
        },
      ],
    },
  };
}

/** Identity for the bootstrap token only: no RBAC binding, no auto-mounted API token. */
export function sandboxServiceAccountManifest(namespace: string, s: NamingSettings): KubeObject {
  const names = namesOf(s);
  return {
    apiVersion: "v1",
    kind: "ServiceAccount",
    metadata: { name: names.serviceAccount, namespace, labels: managedLabelsOf(names) },
    automountServiceAccountToken: false,
  };
}

/** Copy of a registry pull Secret for the kubelet (pods can't mount Secrets: admission policy). */
export function pullSecretManifest(
  namespace: string,
  source: KubeObject,
  s: NamingSettings,
): KubeObject {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: source.metadata.name, namespace, labels: managedLabelsOf(namesOf(s)) },
    type: source.type,
    data: source.data,
  };
}

/** ClusterIPs of the Kaiju Services, by endpoint (for /etc/hosts in sandboxes). */
export type EndpointAddresses = Readonly<Record<KaijuEndpoint, string>>;

const url = (scheme: string, host: string, port: number, defaultPort: number): string =>
  `${scheme}://${host}${port === defaultPort ? "" : `:${port}`}`;

function sandboxEnv(s: SandboxSettings): { name: string; value: string }[] {
  const e = s.endpoints;
  // Always with the port: curl and git (libcurl) default a proxy URL without one to 1080, not 80.
  const egress = `http://${SANDBOX_HOSTS.egressProxy}:${e.egressProxy.port}`;
  const noProxy = [
    SANDBOX_HOSTS.server,
    SANDBOX_HOSTS.modelGateway,
    SANDBOX_HOSTS.mcpProxy,
    "localhost",
    "127.0.0.1",
  ].join(",");
  return [
    // The agent dials out (D13); it trades the bootstrap token at the same host over HTTP.
    { name: "KAIJU_SERVER_URL", value: url("ws", SANDBOX_HOSTS.server, e.server.port, 80) },
    {
      name: "KAIJU_MODEL_GATEWAY_URL",
      value: url("http", SANDBOX_HOSTS.modelGateway, e.modelGateway.port, 80),
    },
    {
      name: "KAIJU_MCP_PROXY_URL",
      value: url("http", SANDBOX_HOSTS.mcpProxy, e.mcpProxy.port, 80),
    },
    { name: "KAIJU_EGRESS_PROXY_URL", value: egress },
    { name: "KAIJU_BOOTSTRAP_TOKEN_FILE", value: BOOTSTRAP_TOKEN_FILE },
    // KOBE-71: every Pi process (and the tools it runs) under a uid of its own; the agent refuses
    // to start when it cannot do that.
    { name: "KAIJU_PI_RUNAS", value: PI_RUNAS_HELPER },
    { name: "KAIJU_PI_RUNTIME_DIR", value: PI_RUNTIME_DIR },
    { name: "KAIJU_SKILLS_DIR", value: SKILLS_DIR },
    { name: "HTTP_PROXY", value: egress },
    { name: "HTTPS_PROXY", value: egress },
    { name: "http_proxy", value: egress },
    { name: "https_proxy", value: egress },
    { name: "NO_PROXY", value: noProxy },
    { name: "no_proxy", value: noProxy },
    { name: "HOME", value: "/home/kaiju" },
    // KOBE-167: Pi's built-in tools in an executor under the partner uid (needs the partner
    // groups in the pod spec above); the agent refuses to start if it is on and they are missing.
    { name: "KAIJU_TOOL_EXECUTOR", value: String(s.toolExecutor.enabled) },
    // KOBE-27: how often the agent pushes /workspace changes (through the server); 0 = sync off.
    {
      name: "KAIJU_WORKSPACE_SYNC_INTERVAL_MS",
      value: String(s.workspaceSync.enabled ? s.workspaceSync.pushIntervalSeconds * 1000 : 0),
    },
  ];
}

/**
 * How long the sandbox agent has between SIGTERM and SIGKILL (KOBE-444). Kubernetes' default 30 s
 * is shorter than the agent's worst case: a 10 s drain, up to 5 s to stop each Pi (3 s stdin grace
 * + 2 s TERM), up to 3 s for the server to ack a lost run's frames before `pi.exited`, then up to
 * 15 s of workspace flush (about 33 s). The lost-run report comes before the flush, so a SIGKILL
 * would only cut the flush (edits since the last periodic push). Raised rather than shortening
 * those waits: an agent that finishes sooner exits sooner; only a stuck one is killed later.
 */
export const SANDBOX_TERMINATION_GRACE_SECONDS = 45;

/**
 * The sandbox pod (spec D12, D13). Secrets never enter it: no Secret volumes or env, no API token;
 * its only credential is a projected token whose audience the Kubernetes API rejects.
 */
export function sandboxPodSpec(
  isolation: VerifiedIsolation,
  s: SandboxSettings,
  addresses: EndpointAddresses,
): Record<string, unknown> {
  const names = namesOf(s);
  return {
    runtimeClassName: isolation.runtimeClassName,
    terminationGracePeriodSeconds: SANDBOX_TERMINATION_GRACE_SECONDS,
    serviceAccountName: names.serviceAccount,
    automountServiceAccountToken: false,
    enableServiceLinks: false,
    hostNetwork: false,
    hostPID: false,
    hostIPC: false,
    // No DNS: Kaiju's services resolve through /etc/hosts; everything else goes via the egress proxy.
    dnsPolicy: "None",
    dnsConfig: {
      nameservers: ["127.0.0.1"],
      searches: [],
      options: [{ name: "ndots", value: "1" }],
    },
    hostAliases: KAIJU_ENDPOINTS.map((e) => ({ ip: addresses[e], hostnames: [SANDBOX_HOSTS[e]] })),
    ...(s.imagePullSecrets.length > 0
      ? { imagePullSecrets: s.imagePullSecrets.map((name) => ({ name })) }
      : {}),
    securityContext: {
      runAsNonRoot: true,
      runAsUser: SANDBOX_UID,
      runAsGroup: SANDBOX_UID,
      fsGroup: SANDBOX_UID,
      // KOBE-71: `kaiju-agent` (may run kaiju-runas) and the Pi identities' groups, so the agent
      // can hand each Pi a runtime directory only that Pi's group reads. KOBE-166: and their
      // partner (tool) groups, one per Pi identity (reconcile-only rollout, no migration).
      supplementalGroups: [
        SANDBOX_AGENT_GID,
        ...Array.from({ length: PI_IDENTITIES }, (_, i) => PI_IDENTITY_BASE + i),
        ...Array.from({ length: PI_IDENTITIES }, (_, i) => PARTNER_IDENTITY_BASE + i),
      ],
      seccompProfile: { type: "RuntimeDefault" },
    },
    containers: [
      {
        name: SANDBOX_CONTAINER,
        image: s.image,
        imagePullPolicy: s.imagePullPolicy,
        env: sandboxEnv(s),
        resources: {
          requests: { ...s.resources.requests, "ephemeral-storage": s.ephemeralStorage.request },
          limits: { ...s.resources.limits, "ephemeral-storage": s.ephemeralStorage.limit },
        },
        // KOBE-71: SETUID/SETGID and privilege escalation only so the agent can start Pi through
        // kaiju-runas (file capabilities, executable by the agent's group only); Pi and everything
        // it starts run with no capabilities and no_new_privs. Under gVisor these capabilities
        // exist in the sandbox kernel only, never on the host.
        securityContext: {
          allowPrivilegeEscalation: true,
          readOnlyRootFilesystem: true,
          capabilities: { drop: ["ALL"], add: [...SANDBOX_CAPABILITIES] },
        },
        volumeMounts: [
          { name: "workspace", mountPath: "/workspace" },
          { name: "tmp", mountPath: "/tmp" },
          { name: "pi-runtime", mountPath: PI_RUNTIME_DIR },
          { name: "pi-skills", mountPath: SKILLS_DIR },
          { name: "home", mountPath: "/home/kaiju" },
          { name: names.bootstrapVolume, mountPath: BOOTSTRAP_TOKEN_DIR, readOnly: true },
        ],
      },
    ],
    volumes: [
      // /tmp is wiped on hibernate (D12); so is $HOME (Pi state is rebuilt from Postgres, D13).
      { name: "tmp", emptyDir: { sizeLimit: s.tmpSize } },
      { name: "home", emptyDir: { sizeLimit: s.homeSize } },
      // KOBE-71: Pi's private runtime directories (sticky root, see PI_RUNTIME_DIR).
      { name: "pi-runtime", emptyDir: { medium: "Memory", sizeLimit: PI_RUNTIME_SIZE } },
      // KOBE-82: the run's skills, written by the agent only (sticky root, see SKILLS_DIR).
      { name: "pi-skills", emptyDir: { medium: "Memory", sizeLimit: SKILLS_SIZE } },
      {
        name: names.bootstrapVolume,
        projected: {
          sources: [
            {
              serviceAccountToken: {
                audience: BOOTSTRAP_TOKEN_AUDIENCE,
                expirationSeconds: BOOTSTRAP_TOKEN_SECONDS,
                path: "bootstrap-token",
              },
            },
          ],
        },
      },
    ],
  };
}

/** Template for every sandbox in the team (claims and the warm pool both use it). */
export function sandboxTemplateManifest(
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
    metadata: { name: names.template, namespace, labels: managedLabels },
    spec: {
      // The controller's "Managed" default adds a policy allowing internet egress, which would
      // widen our default deny (NetworkPolicies are additive). Kaiju owns the namespace's policy.
      networkPolicyManagement: "Unmanaged",
      envVarsInjectionPolicy: "Disallowed",
      volumeClaimTemplatesPolicy: "Disallowed",
      service: false,
      podTemplate: {
        metadata: { labels: { ...managedLabels, "app.kubernetes.io/name": names.sandboxAppName } },
        spec: sandboxPodSpec(isolation, s, addresses),
      },
      volumeClaimTemplates: [
        {
          metadata: { name: "workspace", labels: managedLabels },
          spec: {
            accessModes: ["ReadWriteOnce"],
            resources: { requests: { storage: s.workspace.size } },
            ...(s.workspace.storageClass ? { storageClassName: s.workspace.storageClass } : {}),
          },
        },
      ],
    },
  };
}

/**
 * agent-sandbox warm pools are namespaced (a claim never adopts across namespaces), so each team
 * namespace has its own pool of `replicasPerTeam` pre-started pods (spec D12 says 2 per cluster;
 * see docs/ledger/KOBE-22.md).
 */
export function warmPoolManifest(namespace: string, s: SandboxSettings): KubeObject {
  const names = namesOf(s);
  return {
    apiVersion: "extensions.agents.x-k8s.io/v1beta1",
    kind: "SandboxWarmPool",
    metadata: { name: names.warmPool, namespace, labels: managedLabelsOf(names) },
    spec: {
      replicas: s.warmPool.replicasPerTeam,
      sandboxTemplateRef: { name: names.template },
      // A changed template (new image, RuntimeClass) replaces idle warm sandboxes right away.
      updateStrategy: { type: "Recreate" },
    },
  };
}

/** A user's sandbox in a team. Its UID is the sandbox id (session token `sub`). */
export function sandboxClaimManifest(
  namespace: string,
  team: TeamRef,
  userId: string,
  s: NamingSettings,
): KubeObject {
  const names = namesOf(s);
  return {
    apiVersion: "extensions.agents.x-k8s.io/v1beta1",
    kind: "SandboxClaim",
    metadata: {
      name: claimName(userId),
      namespace,
      labels: { ...managedLabelsOf(names), [LABEL_USER_ID]: userId },
      annotations: { [ANNOTATION_TEAM_ID]: team.id, [ANNOTATION_USER_ID]: userId },
    },
    spec: {
      warmPoolRef: { name: names.warmPool },
      // Identity only (metadata keeps warm-pool adoption possible; env or volumes would not).
      additionalPodMetadata: {
        annotations: { [ANNOTATION_TEAM_ID]: team.id, [ANNOTATION_USER_ID]: userId },
      },
    },
  };
}
