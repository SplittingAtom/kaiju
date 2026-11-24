import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";
import { loadConfig } from "../../../services/egress-proxy/src/config.js";
import { generateSessionKeyPair } from "../../../packages/session-token/src/index.js";

const PUBLIC_PEM = generateSessionKeyPair().publicPem;

// Render tests for the egress proxy's chart pieces (KOBE-38): Deployment env, NetworkPolicy.

const CHART_DIR = fileURLToPath(new URL("..", import.meta.url));
const HELM = process.env.HELM_BIN ?? "helm";
const BASE: Record<string, string> = {
  "ingress.host": "kaiju.example.com",
  "postgres.external.existingSecret": "kaiju-db",
  "s3.endpoint": "https://s3.example.com",
  "s3.bucket": "kaiju",
  "s3.existingSecret": "kaiju-s3",
  "smtp.host": "smtp.example.com",
  "smtp.from": "Kaiju <kaiju@example.com>",
  "global.allowGeneratedSecretsOffline": "true",
};

type Manifest = { kind: string; metadata: { name: string; namespace?: string }; [k: string]: any };

function render(
  values: Record<string, string> = {},
  json: Record<string, unknown> = {},
): Manifest[] {
  const args = [
    ...Object.entries({ ...BASE, ...values }).flatMap(([k, v]) => ["--set", `${k}=${v}`]),
    ...Object.entries(json).flatMap(([k, v]) => ["--set-json", `${k}=${JSON.stringify(v)}`]),
  ];
  const out = execFileSync(HELM, ["template", "kaiju", CHART_DIR, "-n", "kaiju", ...args], {
    encoding: "utf8",
    stdio: "pipe",
  });
  return parseAllDocuments(out)
    .map((d) => d.toJSON() as Manifest | null)
    .filter((m): m is Manifest => m !== null);
}

const find = (ms: Manifest[], kind: string, name: string) =>
  ms.find((m) => m.kind === kind && m.metadata.name === name);
const proxyPod = (ms: Manifest[]) =>
  find(ms, "Deployment", "kaiju-egress-proxy")?.spec.template.spec;
const proxyEnv = (ms: Manifest[]): { name: string; value?: string; valueFrom?: any }[] =>
  proxyPod(ms)?.containers[0].env ?? [];
const policy = (ms: Manifest[]) => find(ms, "NetworkPolicy", "kaiju-egress-proxy")?.spec;

describe("egress proxy Deployment", () => {
  const ms = render();

  it("renders as its own documents next to the MCP proxy (Deployment and Service each)", () => {
    for (const name of ["kaiju-mcp-proxy", "kaiju-egress-proxy"]) {
      expect(find(ms, "Deployment", name), name).toBeDefined();
      expect(find(ms, "Service", name), name).toBeDefined();
    }
  });

  it("gets only its own session public key, the app-role database URL, and waits for migrations", () => {
    const env = proxyEnv(ms);
    const keys = env.filter((e) => e.name.startsWith("KAIJU_SESSION_"));
    expect(keys).toEqual([
      {
        name: "KAIJU_SESSION_VERIFY_KEY_EGRESS_PROXY",
        valueFrom: {
          configMapKeyRef: { name: "kaiju-sandbox-session-verify-keys", key: "egress-proxy" },
        },
      },
    ]);
    expect(env.find((e) => e.name === "KAIJU_DATABASE_URL")?.valueFrom.secretKeyRef.key).toBe(
      "app-url",
    );
    expect(proxyPod(ms)?.initContainers.map((c: { name: string }) => c.name)).toEqual([
      "wait-for-migrations",
    ]);
    expect(proxyPod(ms)?.automountServiceAccountToken).toBe(false);
  });

  it("renders env the proxy's config schema accepts (HTTPS only by default)", () => {
    const vars = Object.fromEntries(
      proxyEnv(ms)
        .filter((e) => e.value !== undefined)
        .map((e) => [e.name, e.value]),
    );
    const config = loadConfig({
      ...vars,
      KAIJU_DATABASE_URL: "postgres://x",
      KAIJU_SESSION_VERIFY_KEY_EGRESS_PROXY: PUBLIC_PEM,
      KAIJU_EGRESS_INTERNAL_KEY: "k".repeat(48),
    });
    expect(config.allowedPorts).toEqual([443]);
    expect(config.allowedInternalCidrs).toEqual([]);
    expect(config.maxConnectionsPerSandbox).toBe(64);
    expect(config.idleTimeoutMs).toBe(300_000);
    expect(config.maxTunnelMs).toBe(3_600_000);
    expect(config.preAuthPerSource).toBe(16);
    expect(config.preAuthTotal).toBe(1_024);
  });
});

describe("egress proxy NetworkPolicy", () => {
  it("admits only team namespaces (sandboxes) and the server's site jobs, only on the proxy port", () => {
    const spec = policy(render());
    expect(spec?.ingress).toEqual([
      {
        from: [
          {
            namespaceSelector: { matchLabels: { "kobe.splittingatom.io/team-namespace": "true" } },
          },
          {
            podSelector: {
              matchLabels: {
                "app.kubernetes.io/name": "kobe",
                "app.kubernetes.io/instance": "kaiju",
                "app.kubernetes.io/component": "server",
              },
            },
          },
        ],
        ports: [{ protocol: "TCP", port: 8080 }],
      },
    ]);
  });

  it("limits the proxy's own egress to DNS, Postgres and public addresses on allowed ports", () => {
    const spec = policy(render());
    expect(spec?.policyTypes).toEqual(["Ingress", "Egress"]);
    const internet = spec?.egress.find((r: any) => r.to?.[0]?.ipBlock?.cidr === "0.0.0.0/0");
    expect(internet.ports).toEqual([{ protocol: "TCP", port: 443 }]);
    expect(internet.to[0].ipBlock.except).toEqual(
      expect.arrayContaining([
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "169.254.0.0/16",
        "127.0.0.0/8",
        "100.64.0.0/10",
      ]),
    );
    const dns = spec?.egress.find((r: any) => r.ports?.some((p: any) => p.port === 53));
    expect(dns.to[0].podSelector.matchLabels).toEqual({ "k8s-app": "kube-dns" });
    // Every rule names its ports: nothing else is reachable on any port.
    expect(spec?.egress.every((r: any) => Array.isArray(r.ports) && r.ports.length > 0)).toBe(true);
  });

  it("narrows Postgres to the configured peers, or to the CNPG cluster", () => {
    const peers = [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "db" } } }];
    const external = policy(render({}, { "egressProxy.networkPolicy.databasePeers": peers }));
    expect(external?.egress).toContainEqual({
      to: peers,
      ports: [{ protocol: "TCP", port: 5432 }],
    });
    const cnpg = policy(render({ "postgres.mode": "cnpg" }));
    expect(cnpg?.egress).toContainEqual({
      to: [{ podSelector: { matchLabels: { "cnpg.io/cluster": "kaiju-pg" } } }],
      ports: [{ protocol: "TCP", port: 5432 }],
    });
  });

  it("adds explicitly allowed internal targets to both the proxy config and its policy", () => {
    const ms = render({}, { "egressProxy.allowedInternalCidrs": ["10.43.200.200/32"] });
    expect(proxyEnv(ms).find((e) => e.name === "KAIJU_EGRESS_ALLOWED_INTERNAL_CIDRS")?.value).toBe(
      "10.43.200.200/32",
    );
    expect(policy(ms)?.egress).toContainEqual({
      to: [{ ipBlock: { cidr: "10.43.200.200/32" } }],
      ports: [{ protocol: "TCP", port: 443 }],
    });
  });

  it("mirrors IPv4 deniedCidrs into the internet rule's exceptions", () => {
    const spec = policy(render({}, { "egressProxy.deniedCidrs": ["11.0.0.0/8", "fd00::/8"] }));
    const internet = spec?.egress.find((r: any) => r.to?.[0]?.ipBlock?.cidr === "0.0.0.0/0");
    expect(internet.to[0].ipBlock.except).toContain("11.0.0.0/8");
    expect(internet.to[0].ipBlock.except).not.toContain("fd00::/8");
  });

  it("can leave the proxy's egress unrestricted (ingress stays restricted)", () => {
    const spec = policy(render({ "egressProxy.networkPolicy.restrictEgress": "false" }));
    expect(spec?.policyTypes).toEqual(["Ingress"]);
    expect(spec?.egress).toBeUndefined();
  });
});

describe("same-cluster hosts: clusterIngress (EA4, KOBE-603)", () => {
  const INGRESS = {
    enabled: true,
    addresses: ["192.0.2.10/32"],
    podSelector: { matchLabels: { "app.kubernetes.io/name": "traefik" } },
    namespace: "kube-system",
    ports: [8443],
  };
  const internalTargets = (ms: Manifest[]) =>
    proxyEnv(ms).find((e) => e.name === "KAIJU_EGRESS_INTERNAL_TARGETS")?.value;
  const configOf = (ms: Manifest[]) =>
    loadConfig({
      ...Object.fromEntries(
        proxyEnv(ms)
          .filter((e) => e.value !== undefined)
          .map((e) => [e.name, e.value]),
      ),
      KAIJU_DATABASE_URL: "postgres://x",
      KAIJU_SESSION_VERIFY_KEY_EGRESS_PROXY: PUBLIC_PEM,
      KAIJU_EGRESS_INTERNAL_KEY: "k".repeat(48),
    });

  it("is off by default: no internal targets and no rule to any ingress pod", () => {
    const ms = render();
    expect(internalTargets(ms)).toBe("");
    expect(configOf(ms).internalTargets).toEqual([]);
    const rules = policy(ms)?.egress as any[];
    expect(rules.some((r) => r.to?.some((p: any) => p.ipBlock?.cidr === "192.0.2.10/32"))).toBe(
      false,
    );
    expect(
      rules.filter((r) =>
        r.to?.some(
          (p: any) =>
            p.namespaceSelector && p.podSelector && !p.podSelector.matchLabels?.["k8s-app"],
        ),
      ),
    ).toEqual([]);
  });

  it("sets the proxy's internal targets (accepted by its config) and leaves allowedInternalCidrs alone", () => {
    const ms = render({}, { "egressProxy.clusterIngress": INGRESS });
    expect(internalTargets(ms)).toBe("192.0.2.10/32");
    const config = configOf(ms);
    expect(config.internalTargets).toEqual(["192.0.2.10/32"]);
    expect(config.allowedInternalCidrs).toEqual([]);
  });

  it("adds egress to the addresses on the allowed ports and to the ingress pods on their ports", () => {
    const ms = render(
      {},
      {
        "egressProxy.clusterIngress": { ...INGRESS, addresses: ["192.0.2.10/32", "192.0.2.11/32"] },
      },
    );
    const spec = policy(ms);
    expect(spec?.egress).toContainEqual({
      to: [{ ipBlock: { cidr: "192.0.2.10/32" } }, { ipBlock: { cidr: "192.0.2.11/32" } }],
      ports: [{ protocol: "TCP", port: 443 }],
    });
    expect(spec?.egress).toContainEqual({
      to: [
        {
          namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } },
          podSelector: { matchLabels: { "app.kubernetes.io/name": "traefik" } },
        },
      ],
      ports: [{ protocol: "TCP", port: 8443 }],
    });
    // The internet rule keeps refusing private ranges; the addresses get a rule of their own.
    const internet = spec?.egress.find((r: any) => r.to?.[0]?.ipBlock?.cidr === "0.0.0.0/0");
    expect(internet.to[0].ipBlock.except).toContain("192.0.0.0/24");
    expect(spec?.egress.every((r: any) => Array.isArray(r.ports) && r.ports.length > 0)).toBe(true);
  });

  it("refuses to render when enabled without addresses, namespace, pods or ports", () => {
    for (const missing of ["addresses", "namespace", "podSelector", "ports"] as const) {
      const empty = { addresses: [], namespace: "", podSelector: {}, ports: [] }[missing];
      expect(
        () => render({}, { "egressProxy.clusterIngress": { ...INGRESS, [missing]: empty } }),
        missing,
      ).toThrow();
    }
    expect(() =>
      render({}, { "egressProxy.clusterIngress": { ...INGRESS, addresses: ["not-a-cidr"] } }),
    ).toThrow();
  });
});

describe("sandbox side", () => {
  it("team namespaces send sandboxes to the proxy pods on 8080 (server config)", () => {
    const server = find(render(), "Deployment", "kaiju-server")?.spec.template.spec.containers[0];
    const cfg = JSON.parse(
      server.env.find((e: { name: string }) => e.name === "KAIJU_SANDBOX_CONFIG").value,
    );
    expect(cfg.endpoints.egressProxy).toMatchObject({
      service: "kaiju-egress-proxy",
      port: 80,
      targetPort: 8080,
      podLabels: { "app.kubernetes.io/component": "egress-proxy" },
    });
  });
});

describe("header injection secret (KOBE-39)", () => {
  const ms = render();
  const envOf = (kind: string, name: string): { name: string; valueFrom?: any }[] =>
    (find(ms, kind, name)?.spec.template.spec.containers[0].env ?? []) as {
      name: string;
      valueFrom?: any;
    }[];
  const headerVars = (env: { name: string; valueFrom?: any }[]) =>
    env.filter((e) => e.name.startsWith("KAIJU_EGRESS_HEADER_SECRET"));

  it("is generated, kept, and given to the server and the egress proxy only", () => {
    const secret = find(ms, "Secret", "kaiju-egress-headers");
    expect(secret?.metadata).toMatchObject({ annotations: { "helm.sh/resource-policy": "keep" } });
    expect((secret?.stringData as Record<string, string>).secret).toMatch(/^[A-Za-z0-9]{48}$/);
    const expected = [
      {
        name: "KAIJU_EGRESS_HEADER_SECRET",
        valueFrom: { secretKeyRef: { name: "kaiju-egress-headers", key: "secret" } },
      },
      {
        name: "KAIJU_EGRESS_HEADER_SECRET_PREVIOUS",
        valueFrom: {
          secretKeyRef: { name: "kaiju-egress-headers", key: "secret-previous", optional: true },
        },
      },
    ];
    expect(headerVars(envOf("Deployment", "kaiju-egress-proxy"))).toEqual(expected);
    expect(headerVars(envOf("Deployment", "kaiju-server"))).toEqual(expected);
    for (const other of ["kaiju-scheduler", "kaiju-mcp-proxy", "kaiju-model-gateway", "kaiju-web"]) {
      expect(headerVars(envOf("Deployment", other)), other).toEqual([]);
    }
    // Sandboxes never get it: the sandbox settings the server renders pods from hold no secret refs.
    expect(JSON.stringify(ms.filter((m) => m.kind === "ConfigMap"))).not.toContain(
      "kaiju-egress-headers",
    );
  });

  it("uses an existing Secret instead when named", () => {
    const named = render({ "egressProxy.headerSecret": "my-egress-headers" });
    expect(find(named, "Secret", "kaiju-egress-headers")).toBeUndefined();
    expect(headerVars(proxyEnv(named))[0]?.valueFrom.secretKeyRef.name).toBe("my-egress-headers");
  });

  it("renders upgrade limits the proxy's config accepts", () => {
    const vars = Object.fromEntries(
      proxyEnv(ms)
        .filter((e) => e.value !== undefined)
        .map((e) => [e.name, e.value]),
    );
    const config = loadConfig({
      ...vars,
      KAIJU_DATABASE_URL: "postgres://x",
      KAIJU_SESSION_VERIFY_KEY_EGRESS_PROXY: PUBLIC_PEM,
      KAIJU_EGRESS_HEADER_SECRET: "h".repeat(48),
      KAIJU_EGRESS_INTERNAL_KEY: "k".repeat(48),
    });
    expect(config.headerSecrets).toEqual(["h".repeat(48)]);
    expect(config.upgrade).toEqual({
      maxRequestBytes: 104_857_600,
      maxResponseBytes: 2_147_483_648,
      timeoutMs: 600_000,
    });
  });
});

describe("git smart-HTTP for connected organizations (KOBE-763)", () => {
  const ms = render();
  const envOf = (name: string): { name: string; value?: string; valueFrom?: any }[] =>
    find(ms, "Deployment", name)?.spec.template.spec.containers[0].env ?? [];
  const serverSelector = {
    "app.kubernetes.io/name": "kobe",
    "app.kubernetes.io/instance": "kaiju",
    "app.kubernetes.io/component": "server",
  };

  it("generates the egress proxy's internal key for the server and the egress proxy only", () => {
    const secret = find(ms, "Secret", "kaiju-egress-proxy-internal");
    expect(secret?.metadata).toMatchObject({ annotations: { "helm.sh/resource-policy": "keep" } });
    expect((secret?.stringData as Record<string, string>).key).toMatch(/^[A-Za-z0-9]{48}$/);
    const ref = { secretKeyRef: { name: "kaiju-egress-proxy-internal", key: "key" } };
    expect(
      envOf("kaiju-egress-proxy").find((e) => e.name === "KAIJU_EGRESS_INTERNAL_KEY")?.valueFrom,
    ).toEqual(ref);
    expect(
      envOf("kaiju-server").find((e) => e.name === "KAIJU_EGRESS_PROXY_INTERNAL_KEY")?.valueFrom,
    ).toEqual(ref);
    for (const other of ["kaiju-scheduler", "kaiju-mcp-proxy", "kaiju-model-gateway", "kaiju-web"]) {
      expect(JSON.stringify(envOf(other)), other).not.toContain("kaiju-egress-proxy-internal");
    }
    expect(JSON.stringify(ms.filter((m) => m.kind === "ConfigMap"))).not.toContain(
      "kaiju-egress-proxy-internal",
    );
    const named = render({ "egressProxy.git.internalKeySecret": "my-git-key" });
    expect(find(named, "Secret", "kaiju-egress-proxy-internal")).toBeUndefined();
  });

  it("renders git limits and the server's internal address the proxy's config accepts", () => {
    const vars = Object.fromEntries(
      envOf("kaiju-egress-proxy")
        .filter((e) => e.value !== undefined)
        .map((e) => [e.name, e.value]),
    );
    const config = loadConfig({
      ...vars,
      KAIJU_DATABASE_URL: "postgres://x",
      KAIJU_SESSION_VERIFY_KEY_EGRESS_PROXY: PUBLIC_PEM,
      KAIJU_EGRESS_INTERNAL_KEY: "k".repeat(48),
    });
    expect(config.git).toMatchObject({
      serverUrl: "http://kaiju-server:8082",
      maxFetchRequestBytes: 67_108_864,
      maxResponseBytes: 4_294_967_296,
      timeoutMs: 1_800_000,
      concurrentPerSandbox: 8,
      requestBurst: 60,
      requestsPerSecond: 2,
      lookupsPerMinute: 30,
    });
    const tuned = render({ "egressProxy.git.maxResponseBytes": "8589934592" });
    const tunedVars = Object.fromEntries(
      (find(tuned, "Deployment", "kaiju-egress-proxy")?.spec.template.spec.containers[0].env ?? [])
        .filter((e: { value?: string }) => e.value !== undefined)
        .map((e: { name: string; value: string }) => [e.name, e.value]),
    );
    expect(tunedVars.KAIJU_EGRESS_GIT_MAX_RESPONSE_BYTES).toBe("8589934592");
  });

  it("lets the egress proxy reach the server's internal port, and the server admit it there", () => {
    const egress = policy(ms)?.egress ?? [];
    expect(egress).toContainEqual({
      to: [{ podSelector: { matchLabels: serverSelector } }],
      ports: [{ protocol: "TCP", port: 8082 }],
    });
    const notFromSandboxes = find(ms, "NetworkPolicy", "kaiju-not-from-sandboxes")?.spec;
    const internal = notFromSandboxes?.ingress.find((r: any) =>
      r.ports.some((p: any) => p.port === 8082),
    );
    expect(
      internal.from.map((f: any) => f.podSelector.matchLabels["app.kubernetes.io/component"]),
    ).toEqual(["mcp-proxy", "egress-proxy"]);
  });

  it("refuses unknown git values (schema)", () => {
    expect(() => render({ "egressProxy.git.timeoutSeconds": "0" })).toThrow();
    expect(() => render({ "egressProxy.git.bogus": "1" })).toThrow();
  });
});
