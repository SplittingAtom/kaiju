import { describe, expect, it } from "vitest";
import { loadSandboxConfig } from "../../../services/server/src/sandbox/config.js";
import {
  loadSigningKey,
  loadVerifyKeys,
  signRunToken,
  verifyRunToken,
} from "../../../packages/session-token/src/index.js";
import { EVAL_PRIORITY_CLASS } from "../../../services/server/src/sandbox/constants.js";
import {
  render,
  renderError,
  find,
  byKind,
  container,
  envOf,
  sandboxConfig,
} from "./sandbox.test-helpers.js";

describe("server sandbox configuration", () => {
  const ms = render();

  it("is valid for the server's config schema (with keys as the Secret provides them)", () => {
    const data = find(ms, "Secret", "kobe-sandbox-session-keys")?.stringData ?? {};
    const keys = {
      KAIJU_SESSION_SIGNING_KEY_SANDBOX_WIRE: data["sandbox-wire.key"],
      KAIJU_SESSION_SIGNING_KEY_MODEL_GATEWAY: data["model-gateway.key"],
      KAIJU_SESSION_SIGNING_KEY_MCP_PROXY: data["mcp-proxy.key"],
      KAIJU_SESSION_SIGNING_KEY_EGRESS_PROXY: data["egress-proxy.key"],
    };
    const config = loadSandboxConfig({
      KAIJU_SANDBOX_CONFIG: JSON.stringify(sandboxConfig(ms)),
      ...keys,
    });
    expect(config?.settings).toMatchObject({
      image: "ghcr.io/splittingatom/kobe-sandbox:0.1.0",
      releaseNamespace: "kobe",
      serverServiceAccount: "kobe-server",
      resources: { requests: { cpu: "500m", memory: "1Gi" }, limits: { cpu: "2", memory: "4Gi" } },
      workspace: { size: "10Gi", storageClass: "" },
      teamQuota: { "requests.cpu": "20", "requests.memory": "40Gi" },
      warmPool: { replicasPerTeam: 1 },
    });
  });

  it("configures the Orbit eval Job: the chart's orbit-eval image, a deadline and limits (KOBE-93)", () => {
    expect(sandboxConfig(ms).orbitEval).toEqual({
      image: "ghcr.io/splittingatom/kobe-orbit-eval:0.1.0",
      deadlineSeconds: 900,
      resources: {
        requests: { cpu: "250m", memory: "512Mi" },
        limits: { cpu: "1", memory: "2Gi" },
      },
    });
    const tuned = sandboxConfig(
      render({
        "sandbox.orbitEval.deadlineSeconds": "300",
        "sandbox.orbitEval.resources.limits.memory": "3Gi",
      }),
    );
    expect(tuned.orbitEval).toMatchObject({
      deadlineSeconds: 300,
      resources: { limits: { memory: "3Gi" } },
    });
  });

  it("configures the external skill scanner Job: the chart's skill-scan image, a deadline and limits (KOBE-341)", () => {
    // Off by default: no image for the server (review-341 L10).
    expect(sandboxConfig(ms)).not.toHaveProperty("skillScan");
    const on = sandboxConfig(render({ "sandbox.skillScan.enabled": "true" }));
    expect(on.skillScan).toEqual({
      image: "ghcr.io/splittingatom/kobe-skill-scan:0.1.0",
      deadlineSeconds: 300,
      resources: {
        requests: { cpu: "250m", memory: "512Mi" },
        limits: { cpu: "1", memory: "2Gi" },
      },
    });
    const tuned = sandboxConfig(
      render({ "sandbox.skillScan.enabled": "true", "sandbox.skillScan.deadlineSeconds": "600" }),
    );
    expect(tuned.skillScan).toMatchObject({ deadlineSeconds: 600 });
  });

  it("points sandboxes at the release's server, model-gateway shim, MCP proxy and egress proxy", () => {
    const { endpoints } = sandboxConfig(ms);
    for (const [key, component] of [
      ["server", "server"],
      ["modelGateway", "model-gateway"],
      ["mcpProxy", "mcp-proxy"],
      ["egressProxy", "egress-proxy"],
    ] as const) {
      expect(find(ms, "Service", endpoints[key].service), key).toBeDefined();
      expect(endpoints[key].podLabels).toEqual({
        "app.kubernetes.io/name": "kobe",
        "app.kubernetes.io/instance": "kobe",
        "app.kubernetes.io/component": component,
      });
      const deployment = find(ms, "Deployment", `kobe-${component}`);
      expect(deployment?.spec.selector.matchLabels).toEqual(endpoints[key].podLabels);
      const ports = container(ms, `kobe-${component}`)?.ports as { containerPort: number }[];
      expect(ports.map((p) => p.containerPort)).toContain(endpoints[key].targetPort);
      const svcPorts = find(ms, "Service", endpoints[key].service)?.spec.ports as {
        port: number;
      }[];
      expect(svcPorts.map((p) => p.port)).toContain(endpoints[key].port);
    }
  });

  it("serves sandboxes on a separate server port that the ingress never routes to", () => {
    const { server } = sandboxConfig(ms).endpoints;
    expect(server).toMatchObject({ port: 8081, targetPort: 8081 });
    const ingress = find(ms, "Ingress", "kobe");
    for (const path of ingress?.spec.rules[0].http.paths ?? []) {
      expect(path.backend.service.port).toEqual({ name: "http" });
    }
  });

  it("lets sandboxes reach models through the token-verifying shim by default (KOBE-40)", () => {
    expect(sandboxConfig(ms).modelGatewayAccess).toBe(true);
    expect(
      sandboxConfig(render({ "sandbox.modelGatewayAccess": "false" })).modelGatewayAccess,
    ).toBe(false);
  });

  it("caps limits, pods, volumes and ephemeral storage per team, not only requests", () => {
    expect(sandboxConfig(ms).teamQuota).toEqual({
      "requests.cpu": "20",
      "requests.memory": "40Gi",
      "limits.cpu": "40",
      "limits.memory": "80Gi",
      "requests.ephemeral-storage": "40Gi",
      "limits.ephemeral-storage": "160Gi",
      "requests.storage": "500Gi",
      persistentvolumeclaims: "50",
      pods: "50",
    });
    expect(sandboxConfig(ms).ephemeralStorage).toEqual({ request: "1Gi", limit: "4Gi" });
  });

  it("names the manager ClusterRole the server binds in team namespaces", () => {
    expect(find(ms, "ClusterRole", sandboxConfig(ms).managerClusterRole)).toBeDefined();
  });

  it("propagates overrides and pull secrets", () => {
    const custom = sandboxConfig(
      render({
        "sandbox.warmPool.replicasPerTeam": "0",
        "sandbox.workspace.storageClass": "longhorn",
        "sandbox.teamQuota.requests\\.cpu": "8",
        "sandbox.resources.limits.cpu": "4",
        "global.imagePullSecrets[0].name": "ghcr-pull",
      }),
    );
    expect(custom).toMatchObject({
      warmPool: { replicasPerTeam: 0 },
      workspace: { storageClass: "longhorn" },
      teamQuota: { "requests.cpu": "8" },
      resources: { limits: { cpu: "4" } },
      imagePullSecrets: ["ghcr-pull"],
    });
  });

  it("hibernates idle sandboxes after 15 minutes by default (D14), configurable within 5-60", () => {
    expect(sandboxConfig(ms).hibernation).toEqual({
      enabled: true,
      idleMinutes: 15,
      sweepSeconds: 60,
      reclaim: { enabled: false, dormantDays: 30 },
    });
    expect(
      sandboxConfig(render({ "sandbox.hibernation.idleMinutes": "30" })).hibernation,
    ).toMatchObject({ idleMinutes: 30 });
    expect(renderError({ "sandbox.hibernation.idleMinutes": "2" })).toMatch(/idleMinutes|minimum/);
    expect(renderError({ "sandbox.hibernation.idleMinutes": "90" })).toMatch(/idleMinutes|maximum/);
  });

  it("syncs workspaces to object storage by default (KOBE-27), with limits", () => {
    expect(sandboxConfig(ms).workspaceSync).toEqual({
      enabled: true,
      pushIntervalSeconds: 60,
      maxFileSize: "1Gi",
      maxFiles: 100000,
      collectSeconds: 3600,
    });
    expect(
      sandboxConfig(
        render({
          "sandbox.workspaceSync.maxWorkspaceSize": "20Gi",
          "sandbox.workspaceSync.pushIntervalSeconds": "15",
        }),
      ).workspaceSync,
    ).toMatchObject({ maxWorkspaceSize: "20Gi", pushIntervalSeconds: 15 });
    expect(renderError({ "sandbox.workspaceSync.pushIntervalSeconds": "1" })).toMatch(
      /pushIntervalSeconds|minimum/,
    );
    expect(renderError({ "sandbox.workspaceSync.maxFileSize": "lots" })).toMatch(
      /maxFileSize|pattern/,
    );
    expect(
      sandboxConfig(render({ "sandbox.workspaceSync.maxFileSize": "5Gi" })).workspaceSync,
    ).toMatchObject({ maxFileSize: "5Gi" });
    for (const big of ["5.5Gi", "6G", "1Ti"]) {
      expect(renderError({ "sandbox.workspaceSync.maxFileSize": big })).toMatch(
        /maxFileSize .* exceeds 5Gi/,
      );
    }
  });

  it("keeps Pi's tools in Pi until the install turns the executor on (KOBE-167)", () => {
    expect(sandboxConfig(ms).toolExecutor).toEqual({ enabled: false });
    expect(sandboxConfig(render({ "sandbox.toolExecutor.enabled": "true" })).toolExecutor).toEqual({
      enabled: true,
    });
    expect(sandboxConfig(render({ sandbox: "null" })).toolExecutor).toEqual({ enabled: false });
    expect(renderError({ "sandbox.toolExecutor.enabled": "maybe" })).toMatch(/enabled|boolean/);
  });

  it("caps skill eval sandboxes per team and ships their low, non-preempting priority (KOBE-325)", () => {
    expect(sandboxConfig(ms).skillEval).toEqual({ maxConcurrentPerTeam: 4, workspaceSize: "2Gi" });
    expect(
      sandboxConfig(render({ "sandbox.skillEval.maxConcurrentPerTeam": "2" })).skillEval,
    ).toEqual({ maxConcurrentPerTeam: 2, workspaceSize: "2Gi" });
    expect(sandboxConfig(render({ sandbox: "null" })).skillEval).toEqual({
      maxConcurrentPerTeam: 4,
      workspaceSize: "2Gi",
    });
    expect(renderError({ "sandbox.skillEval.maxConcurrentPerTeam": "40" })).toMatch(/maximum/);
    const pc = find(ms, "PriorityClass", EVAL_PRIORITY_CLASS);
    expect(pc).toMatchObject({ value: -100, preemptionPolicy: "Never", globalDefault: false });
  });

  it("defaults the sandbox key so `helm upgrade --reuse-values` keeps working", () => {
    expect(sandboxConfig(render({ sandbox: "null" })).warmPool).toEqual({ replicasPerTeam: 1 });
    expect(sandboxConfig(render({ sandbox: "null" })).hibernation).toMatchObject({
      enabled: true,
      idleMinutes: 15,
    });
    expect(sandboxConfig(render({ sandbox: "null" })).workspaceSync).toMatchObject({
      enabled: true,
      pushIntervalSeconds: 60,
    });
  });

  it("gives the private keys to the server only, and each verifier only its public key (KOBE-513)", () => {
    const names = (d: string, prefix: string) =>
      envOf(ms, d)
        .map((e) => e.name)
        .filter((n) => n.startsWith(prefix));
    const audiences = ["EGRESS_PROXY", "MCP_PROXY", "MODEL_GATEWAY", "SANDBOX_WIRE"];
    expect(names("kobe-server", "KAIJU_SESSION_SIGNING_KEY_").sort()).toEqual(
      audiences.map((a) => `KAIJU_SESSION_SIGNING_KEY_${a}`),
    );
    expect(names("kobe-server", "KAIJU_SESSION_VERIFY_KEY_").sort()).toEqual(
      audiences.map((a) => `KAIJU_SESSION_VERIFY_KEY_${a}`),
    );
    // The scheduler wakes sandboxes but never signs tokens (KOBE-174): it holds no session key.
    for (const d of ["kobe-scheduler", "kobe-web"]) {
      expect(names(d, "KAIJU_SESSION_"), d).toEqual([]);
    }
    for (const [d, aud] of [
      ["kobe-egress-proxy", "EGRESS_PROXY"],
      ["kobe-mcp-proxy", "MCP_PROXY"],
      ["kobe-model-gateway", "MODEL_GATEWAY"],
    ] as const) {
      expect(names(d, "KAIJU_SESSION_SIGNING_KEY_"), d).toEqual([]);
      expect(names(d, "KAIJU_SESSION_VERIFY_KEY_"), d).toEqual([`KAIJU_SESSION_VERIFY_KEY_${aud}`]);
      // No private key reaches a verifier, by any route.
      expect(JSON.stringify(envOf(ms, d)), d).not.toMatch(/\.key"/);
      expect(JSON.stringify(envOf(ms, d)), d).toContain("kobe-sandbox-session-verify-keys");
    }
  });

  it("KOBE-521: the gateway gets no secret that mints a credential, only the trace-span secret", () => {
    const gateway = envOf(ms, "kobe-model-gateway");
    const fromSecret = gateway
      .map((v) => (v as { valueFrom?: { secretKeyRef?: { name: string; key: string } } }).valueFrom)
      .map((f) => f?.secretKeyRef)
      .filter((r) => r?.name === "kobe-sandbox-session-keys")
      .map((r) => r?.key);
    expect(fromSecret).toEqual(["trace-span"]);
    expect(gateway.map((v) => v.name)).not.toContain("KAIJU_SESSION_KEY_MODEL_GATEWAY");
    // No Deployment reads the retired master secret entry (the ConfigMap's public key is fine).
    for (const d of byKind(ms, "Deployment")) {
      const refs = JSON.stringify(d.spec.template.spec.containers);
      expect(refs, d.metadata.name).not.toMatch(
        /"secretKeyRef":\{"name":"kobe-sandbox-session-keys","key":"model-gateway"/,
      );
    }
    // The server signs run and server-call tokens with the model-gateway private key and shares
    // only the trace-span secret (optional: a pre-created Secret without it turns the relay off).
    expect(envOf(ms, "kobe-server")).toContainEqual({
      name: "KAIJU_TRACE_SPAN_KEY",
      valueFrom: {
        secretKeyRef: { name: "kobe-sandbox-session-keys", key: "trace-span", optional: true },
      },
    });
  });

  it("run and server-call tokens signed with the Secret's key verify with the gateway's ConfigMap key only (KOBE-521)", () => {
    const secret = (find(ms, "Secret", "kobe-sandbox-session-keys")?.stringData ?? {}) as Record<
      string,
      string
    >;
    const cm = (find(ms, "ConfigMap", "kobe-sandbox-session-verify-keys")?.data ?? {}) as Record<
      string,
      string
    >;
    const now = Math.floor(Date.now() / 1000);
    const ids = ["0b5e8f1c-2d3a-4b5c-8d9e-0f1a2b3c4d5e", "4f9c2d5a-6b7e-4f90-8bc2-4d5e6f708192"];
    const run = signRunToken(loadSigningKey(secret["model-gateway.key"] ?? ""), {
      iss: "kobe-server",
      aud: "kobe.model-gateway",
      run_id: ids[1] ?? "",
      team_id: ids[0] ?? "",
      sandbox_id: ids[1] ?? "",
      iat: now,
      exp: now + 900,
      jti: "abcdefghijklmnopqrstuv",
    }).token;
    expect(verifyRunToken(loadVerifyKeys(cm["model-gateway"] ?? ""), run, now).ok).toBe(true);
    for (const other of ["sandbox-wire", "mcp-proxy", "egress-proxy"]) {
      expect(verifyRunToken(loadVerifyKeys(cm[other] ?? ""), run, now).ok, other).toBe(false);
    }
  });

  it("gives the approval key to the server only, optional for pre-created Secrets (KOBE-37)", () => {
    expect(envOf(ms, "kobe-server")).toContainEqual({
      name: "KAIJU_APPROVAL_KEY",
      valueFrom: {
        secretKeyRef: { name: "kobe-sandbox-session-keys", key: "approval-hmac", optional: true },
      },
    });
    for (const d of ["kobe-scheduler", "kobe-web", "kobe-mcp-proxy", "kobe-egress-proxy"]) {
      expect(JSON.stringify(envOf(ms, d)), d).not.toContain("approval-hmac");
    }
  });
});

describe("release-side NetworkPolicy", () => {
  it("admits team namespaces to web, server and scheduler only on the sandbox port", () => {
    const np = find(render(), "NetworkPolicy", "kobe-not-from-sandboxes");
    expect(np?.spec.podSelector.matchExpressions).toEqual([
      {
        key: "app.kubernetes.io/component",
        operator: "In",
        values: ["web", "server", "scheduler"],
      },
    ]);
    expect(np?.spec.ingress).toEqual([
      {
        from: [
          {
            namespaceSelector: {
              matchExpressions: [
                { key: "kobe.splittingatom.io/team-namespace", operator: "DoesNotExist" },
              ],
            },
          },
        ],
        ports: [
          { protocol: "TCP", port: 8080 },
          { protocol: "TCP", port: 8081 },
        ],
      },
      {
        from: [
          {
            namespaceSelector: { matchLabels: { "kobe.splittingatom.io/team-namespace": "true" } },
          },
        ],
        ports: [{ protocol: "TCP", port: 8081 }],
      },
      // The internal listener: MCP proxy pods (KOBE-58) and egress proxy pods (KOBE-763) only.
      {
        from: [
          {
            podSelector: {
              matchLabels: {
                "app.kubernetes.io/name": "kobe",
                "app.kubernetes.io/instance": "kobe",
                "app.kubernetes.io/component": "mcp-proxy",
              },
            },
          },
          {
            podSelector: {
              matchLabels: {
                "app.kubernetes.io/name": "kobe",
                "app.kubernetes.io/instance": "kobe",
                "app.kubernetes.io/component": "egress-proxy",
              },
            },
          },
        ],
        ports: [{ protocol: "TCP", port: 8082 }],
      },
    ]);
  });
});
