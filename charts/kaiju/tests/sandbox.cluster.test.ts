import { createPublicKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ISOLATION_HANDLER } from "../../../services/server/src/isolation/runtime-class.js";
import { loadSandboxConfig } from "../../../services/server/src/sandbox/config.js";
import {
  SessionKeyError,
  generateSessionKeyPair,
  loadSigningKey,
  loadVerifyKeys,
  signSessionToken,
  verifySessionToken,
} from "../../../packages/session-token/src/index.js";
import {
  BOOTSTRAP_TOKEN_AUDIENCE,
  LABEL_TEAM_NAMESPACE,
  TEAM_NAMESPACE_PREFIX,
} from "../../../services/server/src/sandbox/constants.js";
import {
  type Manifest,
  render,
  renderError,
  find,
  byKind,
  container,
  envOf,
  sandboxConfig,
} from "./sandbox.test-helpers.js";

describe("session keys Secret", () => {
  const AUDIENCES = ["egress-proxy", "mcp-proxy", "model-gateway", "sandbox-wire"] as const;

  it("generates one Ed25519 pair per audience plus the trace-span and approval keys, kept on uninstall", () => {
    const secret = find(render(), "Secret", "kaiju-sandbox-session-keys");
    expect(secret?.metadata.annotations["helm.sh/resource-policy"]).toBe("keep");
    const data = (secret?.stringData ?? {}) as Record<string, string>;
    expect(Object.keys(data).sort()).toEqual(
      ["approval-hmac", "trace-span", ...AUDIENCES.flatMap((a) => [`${a}.key`, `${a}.pub`])].sort(),
    );
    const kids = AUDIENCES.map((a) => loadSigningKey(data[`${a}.key`] ?? "").kid);
    expect(new Set(kids).size).toBe(4);
    for (const a of AUDIENCES) {
      const signing = loadSigningKey(data[`${a}.key`] ?? "");
      // The stored public half belongs to the private key.
      expect([...loadVerifyKeys(data[`${a}.pub`] ?? "").keys()]).toEqual([signing.kid]);
    }
    for (const k of ["approval-hmac", "trace-span"]) {
      expect(data[k]?.length).toBeGreaterThanOrEqual(32);
    }
    expect(data["approval-hmac"]).not.toBe(data["trace-span"]);
    // KOBE-521: the shared model-gateway master secret is gone.
    expect(data["model-gateway"]).toBeUndefined();
  });

  it("publishes only public keys in the verify-keys ConfigMap", () => {
    const ms = render();
    const cm = find(ms, "ConfigMap", "kaiju-sandbox-session-verify-keys");
    const data = (cm?.data ?? {}) as Record<string, string>;
    expect(Object.keys(data).sort()).toEqual([...AUDIENCES]);
    expect(JSON.stringify(data)).not.toContain("PRIVATE KEY");
    for (const pem of Object.values(data)) {
      expect(createPublicKey(pem).asymmetricKeyType).toBe("ed25519");
      // What a compromised verifier holds is not a signing key.
      expect(() => loadSigningKey(pem)).toThrow(SessionKeyError);
    }
  });

  it("a token the server signs with the Secret's key verifies with each service's ConfigMap key only", () => {
    const ms = render();
    const secret = (find(ms, "Secret", "kaiju-sandbox-session-keys")?.stringData ?? {}) as Record<
      string,
      string
    >;
    const cm = (find(ms, "ConfigMap", "kaiju-sandbox-session-verify-keys")?.data ?? {}) as Record<
      string,
      string
    >;
    const now = Math.floor(Date.now() / 1000);
    for (const a of AUDIENCES) {
      const aud = `kobe.${a}` as const;
      const token = signSessionToken(
        {
          iss: "kobe-server",
          aud,
          sub: "4f9c2d5a-6b7e-4f90-8bc2-4d5e6f708192",
          team_id: "0b5e8f1c-2d3a-4b5c-8d9e-0f1a2b3c4d5e",
          user_id: "2d7a0b3e-4f5c-4d7e-8fa0-2b3c4d5e6f70",
          iat: now,
          exp: now + 900,
          jti: "abcdefghijklmnopqrstuv",
        },
        loadSigningKey(secret[`${a}.key`] ?? ""),
      );
      expect(verifySessionToken(token, aud, loadVerifyKeys(cm[a] ?? "")).aud).toBe(aud);
      for (const other of AUDIENCES.filter((o) => o !== a)) {
        expect(() => verifySessionToken(token, aud, loadVerifyKeys(cm[other] ?? ""))).toThrow();
      }
    }
  });

  it("the server takes its rotation bundles from the Secret: a key only in the ConfigMap is not accepted", () => {
    const ms = render();
    const secret = (find(ms, "Secret", "kaiju-sandbox-session-keys")?.stringData ?? {}) as Record<
      string,
      string
    >;
    const cm = (find(ms, "ConfigMap", "kaiju-sandbox-session-verify-keys")?.data ?? {}) as Record<
      string,
      string
    >;
    // A ConfigMap editor appends a key of their own to every audience's bundle.
    const intruder = generateSessionKeyPair();
    const tampered = Object.fromEntries(
      Object.entries(cm).map(([k, v]) => [k, `${v}${intruder.publicPem}`]),
    );
    const env = envOf(ms, "kaiju-server") as {
      name: string;
      value?: string;
      valueFrom?: {
        secretKeyRef?: { name: string; key: string };
        configMapKeyRef?: { name: string; key: string };
      };
    }[];
    const session = env.filter((e) => e.name.startsWith("KAIJU_SESSION_"));
    expect(session.filter((e) => e.valueFrom?.configMapKeyRef)).toEqual([]);
    const resolved = Object.fromEntries(
      session.map((e) => {
        const s = e.valueFrom?.secretKeyRef;
        const c = e.valueFrom?.configMapKeyRef;
        return [e.name, e.value ?? (s ? secret[s.key] : c ? tampered[c.key] : undefined)];
      }),
    );
    const config = loadSandboxConfig({
      KAIJU_SANDBOX_CONFIG: JSON.stringify(sandboxConfig(ms)),
      ...resolved,
    });
    for (const a of AUDIENCES) {
      const keys = config?.sessionVerifyKeys[`kobe.${a}`];
      expect(keys?.has(intruder.signing.kid), a).toBe(false);
      expect(keys?.size, a).toBe(1);
    }
  });

  it("uses a pre-created Secret and ConfigMap instead (GitOps-safe)", () => {
    const ms = render({
      "sandbox.sessionKeysSecret": "my-keys",
      "sandbox.sessionVerifyKeysConfigMap": "my-verify-keys",
    });
    expect(find(ms, "Secret", "kaiju-sandbox-session-keys")).toBeUndefined();
    expect(find(ms, "ConfigMap", "kaiju-sandbox-session-verify-keys")).toBeUndefined();
    expect(container(ms, "kaiju-server")?.env).toContainEqual({
      name: "KAIJU_SESSION_SIGNING_KEY_SANDBOX_WIRE",
      valueFrom: { secretKeyRef: { name: "my-keys", key: "sandbox-wire.key" } },
    });
    expect(container(ms, "kaiju-server")?.env).toContainEqual({
      name: "KAIJU_SESSION_VERIFY_KEY_SANDBOX_WIRE",
      valueFrom: { secretKeyRef: { name: "my-keys", key: "sandbox-wire.pub", optional: true } },
    });
    expect(container(ms, "kaiju-mcp-proxy")?.env).toContainEqual({
      name: "KAIJU_SESSION_VERIFY_KEY_MCP_PROXY",
      valueFrom: { configMapKeyRef: { name: "my-verify-keys", key: "mcp-proxy" } },
    });
    expect(renderError({ "sandbox.sessionKeysSecret": "my-keys" })).toMatch(
      /sandbox\.sessionVerifyKeysConfigMap/,
    );
  });

  it("refuses to generate them in an offline render", () => {
    expect(
      renderError({ "global.allowGeneratedSecretsOffline": "false", "auth.existingSecret": "a" }),
    ).toMatch(/sandbox\.sessionKeysSecret/);
  });
});

describe("sandbox RBAC (least privilege; D11)", () => {
  const ms = render({ "global.imagePullSecrets[0].name": "ghcr-pull" });
  const manager = sandboxConfig(ms).managerClusterRole as string;
  const rules = (
    kind: string,
    name: string,
  ): { resources: string[]; verbs: string[]; resourceNames?: string[]; apiGroups: string[] }[] =>
    find(ms, kind, name)?.rules ?? [];
  const orchestrator = byKind(ms, "ClusterRole").find((r) =>
    r.metadata.name.endsWith("-sandbox-orchestrator"),
  )?.metadata.name as string;

  it("never grants wildcards, Secret reads, pod creation, exec or escalate", () => {
    for (const [kind, name] of [
      ["ClusterRole", manager],
      ["ClusterRole", orchestrator],
    ] as const) {
      for (const rule of rules(kind, name)) {
        expect(rule.verbs, name).not.toContain("*");
        expect(rule.resources, name).not.toContain("*");
        expect(rule.verbs, name).not.toContain("escalate");
        expect(rule.verbs, name).not.toContain("impersonate");
        if (rule.resources.includes("secrets")) {
          expect(rule.verbs, name).not.toEqual(expect.arrayContaining(["get"]));
          expect(rule.verbs, name).not.toContain("list");
        }
        if (rule.resources.includes("pods")) {
          expect(rule.verbs, name).not.toContain("create");
          expect(rule.verbs, name).not.toContain("patch");
        }
        expect(rule.resources.some((r) => r.includes("/exec") || r.includes("/attach"))).toBe(
          false,
        );
      }
    }
  });

  it("lets the server run Orbit eval Jobs and read their result, and nothing more (KOBE-93)", () => {
    const all = rules("ClusterRole", manager);
    expect(all).toContainEqual({
      apiGroups: ["batch"],
      resources: ["jobs"],
      verbs: ["get", "list", "create", "delete"],
    });
    expect(all).toContainEqual({
      apiGroups: [""],
      resources: ["configmaps"],
      verbs: ["create", "patch", "delete"],
    });
    expect(all).toContainEqual({ apiGroups: [""], resources: ["pods/log"], verbs: ["get"] });
  });

  // KOBE-28: offboarding keeps a departed member's volume 30 days, then deletes it. Nothing wider.
  it("lets the server detach and delete workspace volumes, and nothing else on them (KOBE-28)", () => {
    const all = rules("ClusterRole", manager);
    expect(all).toContainEqual({
      apiGroups: [""],
      resources: ["persistentvolumeclaims"],
      verbs: ["get", "patch", "delete"],
    });
  });

  // KOBE-192: a sandbox that is not Ready is diagnosed from events; reading only, never writing them.
  it("lets the server list events in team namespaces, read-only (KOBE-192)", () => {
    const all = rules("ClusterRole", manager);
    expect(all).toContainEqual({ apiGroups: [""], resources: ["events"], verbs: ["list"] });
  });

  it("lets the server read team ResourceQuotas to diagnose a full volume quota (KOBE-733)", () => {
    expect(rules("ClusterRole", manager)).toContainEqual({
      apiGroups: [""],
      resources: ["resourcequotas"],
      verbs: ["get"],
    });
  });

  it("lets the server read PersistentVolumes and Nodes to tell a lost volume, read-only (KOBE-739)", () => {
    const all = rules("ClusterRole", orchestrator);
    expect(all).toContainEqual({
      apiGroups: [""],
      resources: ["persistentvolumes"],
      verbs: ["get"],
    });
    expect(all).toContainEqual({ apiGroups: [""], resources: ["nodes"], verbs: ["get", "list"] });
    expect(sandboxConfig(ms).volumeLoss).toEqual({ detection: true, graceMinutes: 30 });
  });

  it("drops the Node and PV reads when volume-loss detection is off (KOBE-739)", () => {
    const off = render({ "sandbox.volumeLoss.detection": "false" });
    const name = byKind(off, "ClusterRole").find((r) =>
      r.metadata.name.endsWith("-sandbox-orchestrator"),
    )?.metadata.name as string;
    const resources = (find(off, "ClusterRole", name)?.rules ?? []).flatMap(
      (r: { resources: string[] }) => r.resources,
    );
    expect(resources).not.toContain("nodes");
    expect(resources).not.toContain("persistentvolumes");
    expect(sandboxConfig(off).volumeLoss).toEqual({ detection: false, graceMinutes: 30 });
  });

  it("renders dormant-volume reclaim off by default, and its settings when on (KOBE-733)", () => {
    const off = sandboxConfig(render());
    expect(off.hibernation.reclaim).toEqual({
      enabled: false,
      dormantDays: 30,
    });
    const on = sandboxConfig(
      render({
        "sandbox.hibernation.reclaim.enabled": "true",
        "sandbox.hibernation.reclaim.dormantDays": "45",
      }),
    );
    expect(on.hibernation.reclaim).toEqual({
      enabled: true,
      dormantDays: 45,
    });
  });

  // KOBE-126: the team-namespace reconcile (server/src/sandbox/team-reconcile.ts) lists namespaces by
  // label (orchestrator role), reads both NetworkPolicies, and server-side applies (PATCH, plus
  // create when missing) every kind below. Exactly these verbs, per kind, in the manager role.
  it("grants the team-namespace reconcile exactly its verbs per managed kind (KOBE-126)", () => {
    const verbsFor = (role: string, group: string, resource: string): string[] =>
      rules("ClusterRole", role)
        .filter((r) => r.apiGroups.includes(group) && r.resources.includes(resource))
        .flatMap((r) => r.verbs)
        .sort();
    const applyOnly = ["create", "patch"];
    const expected: [string, string, string[]][] = [
      ["networking.k8s.io", "networkpolicies", ["create", "get", "patch"]],
      // get: a wake with a missing volume reads the quota (KOBE-733).
      ["", "resourcequotas", ["create", "get", "patch"]],
      ["", "limitranges", applyOnly],
      ["", "serviceaccounts", applyOnly],
      ["", "secrets", applyOnly],
      ["extensions.agents.x-k8s.io", "sandboxtemplates", applyOnly],
      ["extensions.agents.x-k8s.io", "sandboxwarmpools", applyOnly],
    ];
    for (const [group, resource, verbs] of expected) {
      expect(verbsFor(manager, group, resource), `${group}/${resource}`).toEqual(verbs);
    }
    // Cluster-scoped part: namespaces (list by label, get, apply) and the per-team RoleBinding.
    expect(verbsFor(orchestrator, "", "namespaces")).toEqual(["create", "get", "list", "patch"]);
    expect(verbsFor(orchestrator, "rbac.authorization.k8s.io", "rolebindings")).toEqual(applyOnly);
  });

  it("lets the team-namespace reconcile read back its NetworkPolicies (KOBE-115)", () => {
    expect(rules("ClusterRole", manager)).toContainEqual({
      apiGroups: ["networking.k8s.io"],
      resources: ["networkpolicies"],
      verbs: ["get", "create", "patch"],
    });
  });

  it("lets the server bind only the manager role, and never delete namespaces", () => {
    const bind = rules("ClusterRole", orchestrator).find((r) => r.verbs.includes("bind"));
    expect(bind).toEqual({
      apiGroups: ["rbac.authorization.k8s.io"],
      resources: ["clusterroles"],
      verbs: ["bind"],
      resourceNames: [manager],
    });
    const ns = rules("ClusterRole", orchestrator).find((r) => r.resources.includes("namespaces"));
    expect(ns?.verbs).not.toContain("delete");
    expect(rules("ClusterRole", orchestrator)).toContainEqual({
      apiGroups: ["authentication.k8s.io"],
      resources: ["tokenreviews"],
      verbs: ["create"],
    });
  });

  it("binds cluster-wide verbs to the server ServiceAccount only; the manager role is not bound cluster-wide", () => {
    const binding = find(ms, "ClusterRoleBinding", orchestrator);
    expect(binding?.subjects).toEqual([
      { kind: "ServiceAccount", name: "kaiju-server", namespace: "kaiju" },
    ]);
    expect(byKind(ms, "ClusterRoleBinding").some((b) => b.roleRef.name === manager)).toBe(false);
  });

  it("reads only the four Services and the pull Secrets, by name, in the release namespace", () => {
    expect(rules("Role", "kaiju-sandbox-orchestrator")).toEqual([
      {
        apiGroups: [""],
        resources: ["services"],
        verbs: ["get"],
        resourceNames: [
          "kaiju-server",
          "kaiju-model-gateway",
          "kaiju-mcp-proxy",
          "kaiju-egress-proxy",
        ],
      },
      { apiGroups: [""], resources: ["secrets"], verbs: ["get"], resourceNames: ["ghcr-pull"] },
    ]);
  });
});

describe("sandbox admission policies (KOBE-9 binding requirement 3)", () => {
  const ms = render({ "isolation.runtimeClassName": "kata-qemu" });
  const policies = byKind(ms, "ValidatingAdmissionPolicy");
  const bindings = byKind(ms, "ValidatingAdmissionPolicyBinding");
  const policy = (suffix: string) => policies.find((p) => p.metadata.name.endsWith(suffix));
  const expressions = (suffix: string) =>
    JSON.stringify(
      policy(suffix)?.spec.validations.map((v: { expression: string }) => v.expression),
    );

  it("binds every policy with Deny and fails closed", () => {
    expect(policies).toHaveLength(4);
    for (const p of policies) {
      expect(p.spec.failurePolicy).toBe("Fail");
      const binding = bindings.find((b) => b.spec.policyName === p.metadata.name);
      expect(binding?.spec.validationActions).toEqual(["Deny"]);
    }
  });

  it("pins pods and sandbox specs to the configured RuntimeClass and an isolating handler", () => {
    for (const suffix of ["-sandbox-pods", "-sandbox-specs"]) {
      const p = policy(suffix);
      expect(p?.spec.paramKind).toEqual({ apiVersion: "node.k8s.io/v1", kind: "RuntimeClass" });
      const binding = bindings.find((b) => b.spec.policyName === p?.metadata.name);
      expect(binding?.spec.paramRef).toEqual({
        name: "kata-qemu",
        parameterNotFoundAction: "Deny",
      });
      expect(p?.spec.matchConditions).toEqual([
        {
          name: "team-namespace",
          expression: `request.namespace.startsWith('${TEAM_NAMESPACE_PREFIX}')`,
        },
      ]);
      expect(expressions(suffix)).toContain(
        `params.handler.matches('${ISOLATION_HANDLER.source}')`,
      );
    }
    expect(policy("-sandbox-pods")?.spec.matchConstraints.resourceRules).toEqual([
      { apiGroups: [""], apiVersions: ["v1"], operations: ["CREATE"], resources: ["pods"] },
      {
        apiGroups: [""],
        apiVersions: ["v1"],
        operations: ["UPDATE"],
        resources: ["pods/ephemeralcontainers"],
      },
    ]);
    expect(expressions("-sandbox-pods")).toBeDefined();
    expect(JSON.stringify(policy("-sandbox-pods")?.spec.variables)).toContain(
      "ephemeralContainers",
    );
  });

  it("keeps credentials out of sandbox pods", () => {
    const e = expressions("-sandbox-pods");
    for (const fragment of [
      "automountServiceAccountToken",
      "has(v.secret)",
      "has(v.hostPath)",
      "secretKeyRef",
      "secretRef",
      "hostNetwork",
      `'${BOOTSTRAP_TOKEN_AUDIENCE}'`,
    ]) {
      expect(e).toContain(fragment);
    }
  });

  it("enforces 'restricted' on team pods but for SETUID/SETGID and privilege escalation (KOBE-71)", () => {
    const e = expressions("-sandbox-pods");
    for (const fragment of [
      "exists(d, d == 'ALL')",
      "c.name == 'agent' ?",
      "all(a, a in ['SETUID', 'SETGID'])",
      "allowPrivilegeEscalation.orValue(true) == false",
      "ephemeralContainers",
      "privileged",
      "runAsNonRoot",
      "runAsUser",
      "in ['RuntimeDefault', 'Localhost']",
      "has(v.persistentVolumeClaim) || has(v.projected)",
    ]) {
      expect(e).toContain(fragment);
    }
    expect(expressions("-server-scope")).toContain("in ['baseline', 'restricted']");
  });

  it("confines the server's namespace and RoleBinding writes to labelled kobe-team-* namespaces", () => {
    const p = policy("-server-scope");
    expect(p?.spec.matchConditions).toEqual([
      {
        name: "kaiju-server",
        expression: "request.userInfo.username == 'system:serviceaccount:kaiju:kaiju-server'",
      },
    ]);
    const e = expressions("-server-scope");
    expect(e).toContain(`startsWith('${TEAM_NAMESPACE_PREFIX}')`);
    expect(e).toContain(LABEL_TEAM_NAMESPACE);
    expect(e).toContain("restricted");
    expect(e).toContain(sandboxConfig(ms).managerClusterRole);
    expect(e).toContain("oldLabels[?'kobe.splittingatom.io/team-id']");
  });

  it("requires Unmanaged templates and leaves team NetworkPolicies to the server", () => {
    expect(expressions("-sandbox-specs")).toContain("Unmanaged");
    expect(expressions("-sandbox-netpol")).toContain("system:serviceaccount:kaiju:kaiju-server");
  });
});

describe("values.schema.json: sandbox", () => {
  it("rejects unknown keys and out-of-range warm pools", () => {
    expect(renderError({ "sandbox.privileged": "true" })).toMatch(/privileged|additional/i);
    expect(renderError({ "sandbox.warmPool.replicasPerTeam": "50" })).toMatch(
      /replicasPerTeam|maximum/,
    );
    expect(renderError({ "sandbox.tmpSize": "lots" })).toMatch(/tmpSize|pattern|oneOf/i);
  });
});

describe("workspace storage: Longhorn strict-local (sandbox.workspace.longhornStrictLocal)", () => {
  it("is off by default: no StorageClass, workspaces on storageClass (cluster default)", () => {
    const ms = render();
    expect(byKind(ms, "StorageClass")).toHaveLength(0);
    expect(sandboxConfig(ms).workspace.storageClass).toBe("");
    expect(
      sandboxConfig(render({ "sandbox.workspace.storageClass": "fast" })).workspace.storageClass,
    ).toBe("fast");
  });

  it("creates a one-replica strict-local Longhorn class and points workspaces at it", () => {
    const ms = render({ "sandbox.workspace.longhornStrictLocal.enabled": "true" });
    const [sc] = byKind(ms, "StorageClass");
    expect(sc).toMatchObject({
      provisioner: "driver.longhorn.io",
      volumeBindingMode: "WaitForFirstConsumer",
      reclaimPolicy: "Delete",
      parameters: { numberOfReplicas: "1", dataLocality: "strict-local" },
    });
    expect(sc?.metadata.name).toMatch(/^kaiju-[0-9a-f]{10}-workspace-strict-local$/);
    expect(sandboxConfig(ms).workspace.storageClass).toBe(sc?.metadata.name);
  });

  it("refuses a storageClass together with the strict-local class", () => {
    expect(
      renderError({
        "sandbox.workspace.longhornStrictLocal.enabled": "true",
        "sandbox.workspace.storageClass": "fast",
      }),
    ).toMatch(/either storageClass or longhornStrictLocal/);
  });
});

describe("Rancher (rancher.enabled)", () => {
  const rancherRoles = (ms: Manifest[]) =>
    ms.filter(
      (m) =>
        (m.kind === "ClusterRole" || m.kind === "ClusterRoleBinding") &&
        m.metadata.name.endsWith("-rancher-updatepsa"),
    );

  it("grants nothing by default", () => {
    expect(rancherRoles(render())).toHaveLength(0);
  });

  it("grants the server's ServiceAccount updatepsa on Rancher projects, and nothing else", () => {
    const ms = render({ "rancher.enabled": "true" });
    const [role, binding] = rancherRoles(ms);
    expect(role?.kind).toBe("ClusterRole");
    expect(role?.rules).toEqual([
      { apiGroups: ["management.cattle.io"], resources: ["projects"], verbs: ["updatepsa"] },
    ]);
    expect(binding?.kind).toBe("ClusterRoleBinding");
    expect(binding?.roleRef).toMatchObject({ kind: "ClusterRole", name: role?.metadata.name });
    expect(binding?.subjects).toEqual([
      { kind: "ServiceAccount", name: "kaiju-server", namespace: "kaiju" },
    ]);
  });

  it("rejects unknown keys", () => {
    expect(renderError({ "rancher.project": "x" })).toMatch(/project|additional/i);
  });
});
