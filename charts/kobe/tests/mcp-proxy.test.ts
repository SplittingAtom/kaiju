import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";
import { loadConfig } from "../../../services/mcp-proxy/src/config.js";
import { loadConfig as loadServerConfig } from "../../../services/server/src/config.js";
import { generateSessionKeyPair } from "../../../packages/session-token/src/index.js";

// Render tests for the MCP proxy's chart pieces (KOBE-58): Deployment env, internal key, the
// server's internal listener, NetworkPolicies.

const CHART_DIR = fileURLToPath(new URL("..", import.meta.url));
const HELM = process.env.HELM_BIN ?? "helm";
const BASE: Record<string, string> = {
  "ingress.host": "kobe.example.com",
  "postgres.external.existingSecret": "kobe-db",
  "s3.endpoint": "https://s3.example.com",
  "s3.bucket": "kobe",
  "s3.existingSecret": "kobe-s3",
  "smtp.host": "smtp.example.com",
  "smtp.from": "Kaiju <kaiju@example.com>",
  "global.allowGeneratedSecretsOffline": "true",
};

type Manifest = { kind: string; metadata: { name: string }; [k: string]: any };
type EnvVar = { name: string; value?: string; valueFrom?: any };

function render(
  values: Record<string, string> = {},
  json: Record<string, unknown> = {},
): Manifest[] {
  const args = [
    ...Object.entries({ ...BASE, ...values }).flatMap(([k, v]) => ["--set", `${k}=${v}`]),
    ...Object.entries(json).flatMap(([k, v]) => ["--set-json", `${k}=${JSON.stringify(v)}`]),
  ];
  const out = execFileSync(HELM, ["template", "kobe", CHART_DIR, "-n", "kobe", ...args], {
    encoding: "utf8",
    stdio: "pipe",
  });
  return parseAllDocuments(out)
    .map((d) => d.toJSON() as Manifest | null)
    .filter((m): m is Manifest => m !== null);
}

const find = (ms: Manifest[], kind: string, name: string) =>
  ms.find((m) => m.kind === kind && m.metadata.name === name);
const pod = (ms: Manifest[], name: string) => find(ms, "Deployment", name)?.spec.template.spec;
const envOf = (ms: Manifest[], name: string): EnvVar[] => pod(ms, name)?.containers[0].env ?? [];
const policy = (ms: Manifest[]) => find(ms, "NetworkPolicy", "kobe-mcp-proxy")?.spec;
const plain = (env: EnvVar[]) =>
  Object.fromEntries(env.filter((e) => e.value !== undefined).map((e) => [e.name, e.value]));

describe("MCP proxy Deployment", () => {
  const ms = render();

  it("gets only its own session public key and the internal key; no database, no API token", () => {
    const env = envOf(ms, "kobe-mcp-proxy");
    const refs = env
      .filter((e) => e.valueFrom)
      .map((e) => [e.name, e.valueFrom.secretKeyRef ?? e.valueFrom.configMapKeyRef]);
    expect(refs).toEqual([
      [
        "KAIJU_SESSION_VERIFY_KEY_MCP_PROXY",
        { name: "kobe-sandbox-session-verify-keys", key: "mcp-proxy" },
      ],
      ["KAIJU_MCP_INTERNAL_KEY", { name: "kobe-mcp-proxy-internal", key: "key" }],
      // KOBE-693: the server's key for the proxy's routes, the other direction.
      [
        "KAIJU_MCP_ROUTES_KEY",
        { name: "kobe-mcp-proxy-internal", key: "routes-key", optional: true },
      ],
    ]);
    // No private session key reaches the proxy (KOBE-513).
    expect(
      env.filter((e) => e.valueFrom?.secretKeyRef?.name === "kobe-sandbox-session-keys"),
    ).toEqual([]);
    expect(env.some((e) => e.name.includes("DATABASE"))).toBe(false);
    expect(pod(ms, "kobe-mcp-proxy")?.automountServiceAccountToken).toBe(false);
    expect(pod(ms, "kobe-mcp-proxy")?.initContainers).toBeUndefined();
  });

  it("holds no key that can produce an approval signature (KOBE-520)", () => {
    // Approvals are HMAC-signed by the server and verified by the server on the proxy's policy
    // re-check; the proxy only forwards the decision. A proxy compromise cannot mint one.
    const env = envOf(ms, "kobe-mcp-proxy");
    expect(env.map((e) => e.name)).not.toContain("KAIJU_APPROVAL_KEY");
    expect(JSON.stringify(env)).not.toContain("approval-hmac");
    const serverEnv = envOf(ms, "kobe-server");
    expect(serverEnv.find((e) => e.name === "KAIJU_APPROVAL_KEY")?.valueFrom?.secretKeyRef).toEqual({
      name: "kobe-sandbox-session-keys",
      key: "approval-hmac",
      optional: true,
    });
  });

  it("renders env the proxy's config schema accepts (HTTPS on 443, server's internal port)", () => {
    const config = loadConfig({
      ...plain(envOf(ms, "kobe-mcp-proxy")),
      KAIJU_SESSION_VERIFY_KEY_MCP_PROXY: generateSessionKeyPair().publicPem,
      KAIJU_MCP_INTERNAL_KEY: "i".repeat(48),
    });
    expect(config.serverUrl).toBe("http://kobe-server:8082");
    expect(config.internalPort).toBe(8081);
    expect(config.upstream).toEqual({
      allowInsecureHttp: false,
      allowedPorts: [443],
      allowedInternalCidrs: [],
      deniedCidrs: [],
    });
    expect(config.limits.upstreamTimeoutMs).toBe(55_000);
  });

  it("generates and keeps the internal key unless an existing Secret is named", () => {
    const secret = find(ms, "Secret", "kobe-mcp-proxy-internal");
    expect(secret?.metadata).toMatchObject({ annotations: { "helm.sh/resource-policy": "keep" } });
    expect(secret?.stringData.key).toHaveLength(48);
    // KOBE-693: one key per direction, generated the same way (an existing release keeps `key`
    // through lookup and gains `routes-key` on upgrade).
    expect(secret?.stringData["routes-key"]).toHaveLength(48);
    expect(secret?.stringData["routes-key"]).not.toBe(secret?.stringData.key);
    const own = render({ "mcpProxy.internalKeySecret": "my-key" });
    expect(find(own, "Secret", "kobe-mcp-proxy-internal")).toBeUndefined();
    expect(
      envOf(own, "kobe-mcp-proxy").find((e) => e.name === "KAIJU_MCP_INTERNAL_KEY")?.valueFrom,
    ).toEqual({ secretKeyRef: { name: "my-key", key: "key" } });
    // An operator's Secret may lack routes-key: optional, and the services fall back to `key`.
    expect(
      envOf(own, "kobe-mcp-proxy").find((e) => e.name === "KAIJU_MCP_ROUTES_KEY")?.valueFrom,
    ).toEqual({ secretKeyRef: { name: "my-key", key: "routes-key", optional: true } });
  });
});

describe("server internal listener", () => {
  const ms = render();

  it("serves the internal port with the key; the scheduler gets neither", () => {
    const server = envOf(ms, "kobe-server");
    expect(plain(server).KAIJU_INTERNAL_PORT).toBe("8082");
    // The proxy's internal routes on their own port (KOBE-693).
    expect(plain(server).KAIJU_MCP_PROXY_URL).toBe("http://kobe-mcp-proxy:8081");
    expect(server.find((e) => e.name === "KAIJU_MCP_PROXY_INTERNAL_KEY")?.valueFrom).toEqual({
      secretKeyRef: { name: "kobe-mcp-proxy-internal", key: "key" },
    });
    expect(server.find((e) => e.name === "KAIJU_MCP_PROXY_ROUTES_KEY")?.valueFrom).toEqual({
      secretKeyRef: { name: "kobe-mcp-proxy-internal", key: "routes-key", optional: true },
    });
    expect(pod(ms, "kobe-mcp-proxy")?.containers[0].ports).toContainEqual({
      name: "internal",
      containerPort: 8081,
    });
    expect(find(ms, "Service", "kobe-mcp-proxy")?.spec.ports).toContainEqual({
      name: "internal",
      port: 8081,
      targetPort: "internal",
    });
    expect(pod(ms, "kobe-server")?.containers[0].ports).toContainEqual({
      name: "internal",
      containerPort: 8082,
    });
    expect(find(ms, "Service", "kobe-server")?.spec.ports).toContainEqual({
      name: "internal",
      port: 8082,
      targetPort: "internal",
    });
    expect(envOf(ms, "kobe-scheduler").some((e) => e.name === "KAIJU_MCP_PROXY_INTERNAL_KEY")).toBe(
      false,
    );
  });
});

describe("server -> proxy routes (KOBE-693)", () => {
  it("the server's config resolves the proxy's internal port and the routes key, not the proxy's key", () => {
    const ms = render();
    // Secret refs resolved to stand-in values, one per Secret key.
    const env: Record<string, string> = {};
    for (const e of envOf(ms, "kobe-server")) {
      const ref = e.valueFrom?.secretKeyRef;
      env[e.name] = e.value ?? (ref ? `${ref.name}/${ref.key}`.padEnd(48, "x") : "x".repeat(48));
    }
    const config = loadServerConfig({
      ...env,
      KAIJU_DATABASE_URL: "postgres://app@db:5432/kobe",
      KAIJU_DATABASE_MIGRATE_URL: "postgres://owner@db:5432/kobe",
    });
    expect(config.mcpProxyUrl).toBe("http://kobe-mcp-proxy:8081");
    expect(config.mcpProxyRoutesKey).toBe("kobe-mcp-proxy-internal/routes-key".padEnd(48, "x"));
    expect(config.mcpProxyInternalKey).toBe("kobe-mcp-proxy-internal/key".padEnd(48, "x"));
    // The proxy authenticates the server's routes with the same Secret key.
    expect(
      envOf(ms, "kobe-mcp-proxy").find((e) => e.name === "KAIJU_MCP_ROUTES_KEY")?.valueFrom
        ?.secretKeyRef.key,
    ).toBe("routes-key");
  });
});

describe("MCP proxy NetworkPolicy", () => {
  it("admits team namespaces on the proxy port and server pods on the internal port only (KOBE-693)", () => {
    expect(policy(render())?.ingress).toEqual([
      {
        from: [
          {
            namespaceSelector: { matchLabels: { "kobe.splittingatom.io/team-namespace": "true" } },
          },
        ],
        ports: [{ protocol: "TCP", port: 8080 }],
      },
      {
        from: [
          {
            podSelector: {
              matchLabels: expect.objectContaining({ "app.kubernetes.io/component": "server" }),
            },
          },
        ],
        ports: [{ protocol: "TCP", port: 8081 }],
      },
    ]);
  });

  it("limits egress to DNS, the server's internal port and public addresses on allowed ports", () => {
    const spec = policy(render());
    expect(spec?.policyTypes).toEqual(["Ingress", "Egress"]);
    expect(spec?.egress).toContainEqual({
      to: [
        {
          podSelector: {
            matchLabels: {
              "app.kubernetes.io/name": "kobe",
              "app.kubernetes.io/instance": "kobe",
              "app.kubernetes.io/component": "server",
            },
          },
        },
      ],
      ports: [{ protocol: "TCP", port: 8082 }],
    });
    const internet = spec?.egress.find((r: any) => r.to?.[0]?.ipBlock?.cidr === "0.0.0.0/0");
    expect(internet.ports).toEqual([{ protocol: "TCP", port: 443 }]);
    expect(internet.to[0].ipBlock.except).toEqual(
      expect.arrayContaining(["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"]),
    );
    // No database: the proxy never talks to Postgres.
    expect(spec?.egress.some((r: any) => r.ports?.some((p: any) => p.port === 5432))).toBe(false);
    expect(spec?.egress.every((r: any) => Array.isArray(r.ports) && r.ports.length > 0)).toBe(true);
  });

  it("adds allowed internal targets and ports to both the config and the policy", () => {
    const ms = render(
      {},
      { "mcpProxy.allowedInternalCidrs": ["10.0.5.0/24"], "mcpProxy.allowedPorts": [443, 8443] },
    );
    expect(plain(envOf(ms, "kobe-mcp-proxy"))).toMatchObject({
      KAIJU_MCP_ALLOWED_INTERNAL_CIDRS: "10.0.5.0/24",
      KAIJU_MCP_ALLOWED_PORTS: "443,8443",
    });
    // The server validates registered connector URLs against the same policy (KOBE-100).
    expect(plain(envOf(ms, "kobe-server"))).toMatchObject({
      KAIJU_MCP_ALLOWED_INTERNAL_CIDRS: "10.0.5.0/24",
      KAIJU_MCP_ALLOWED_PORTS: "443,8443",
      KAIJU_MCP_ALLOW_INSECURE_HTTP: "false",
    });
    expect(policy(ms)?.egress).toContainEqual({
      to: [{ ipBlock: { cidr: "10.0.5.0/24" } }],
      ports: [
        { protocol: "TCP", port: 443 },
        { protocol: "TCP", port: 8443 },
      ],
    });
  });

  it("rejects unknown values (schema)", () => {
    expect(() => render({ "mcpProxy.allowStdio": "true" })).toThrow();
  });
});
