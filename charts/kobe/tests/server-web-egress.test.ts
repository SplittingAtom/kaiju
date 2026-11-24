import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

// Opt-in egress NetworkPolicies for the server and web pods (KOBE-698, review SEC-9): off by
// default (existing installs unchanged); on, egress only to the listed destinations + extraEgress.

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

type Manifest = { kind: string; metadata: { name: string }; spec?: any };

function render(values: Record<string, string> = {}): Manifest[] {
  const args = Object.entries({ ...BASE, ...values }).flatMap(([k, v]) => ["--set", `${k}=${v}`]);
  const out = execFileSync(HELM, ["template", "kobe", CHART_DIR, "-n", "kobe", ...args], {
    encoding: "utf8",
    stdio: "pipe",
  });
  return parseAllDocuments(out)
    .map((d) => d.toJSON() as Manifest | null)
    .filter((m): m is Manifest => m !== null);
}

function renderError(values: Record<string, string>): string {
  try {
    render(values);
  } catch (err) {
    return String((err as { stderr?: string }).stderr ?? err);
  }
  throw new Error("render succeeded");
}

// restrictEgress needs the API server's peers, and with external Postgres the database's peers.
const API_PEER = { "server.networkPolicy.kubernetesApi.peers[0].ipBlock.cidr": "10.0.0.1/32" };
const DB_PEER = { "server.networkPolicy.databasePeers[0].ipBlock.cidr": "10.1.2.3/32" };
const ON = { "server.networkPolicy.restrictEgress": "true", ...API_PEER, ...DB_PEER };

const policy = (ms: Manifest[], name: string) =>
  ms.find((m) => m.kind === "NetworkPolicy" && m.metadata.name === name)?.spec;

const DNS = {
  to: [
    {
      namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } },
      podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
    },
  ],
  ports: [
    { protocol: "UDP", port: 53 },
    { protocol: "TCP", port: 53 },
  ],
};

const release = { "app.kubernetes.io/name": "kobe", "app.kubernetes.io/instance": "kobe" };
const PRIVATE = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "224.0.0.0/4",
  "240.0.0.0/4",
];
const publicOn = (...ports: number[]) => ({
  to: [{ ipBlock: { cidr: "0.0.0.0/0", except: PRIVATE } }],
  ports: ports.map((port) => ({ protocol: "TCP", port })),
});

describe("server and web egress (KOBE-698)", () => {
  it("is off by default: no egress policy selects the server or web pods", () => {
    const ms = render();
    expect(policy(ms, "kobe-server-egress")).toBeUndefined();
    expect(policy(ms, "kobe-web-egress")).toBeUndefined();
  });

  it("restricts the server to DNS, Postgres, Kaiju's own services, the API server, public 443 and SMTP", () => {
    const spec = policy(render(ON), "kobe-server-egress");
    expect(spec.podSelector).toEqual({
      matchLabels: { ...release, "app.kubernetes.io/component": "server" },
    });
    expect(spec.policyTypes).toEqual(["Egress"]);
    expect(spec.egress).toEqual([
      DNS,
      { to: [{ ipBlock: { cidr: "10.1.2.3/32" } }], ports: [{ protocol: "TCP", port: 5432 }] },
      {
        to: [
          {
            podSelector: {
              matchLabels: release,
              matchExpressions: [
                {
                  key: "app.kubernetes.io/component",
                  operator: "In",
                  values: [
                    "bifrost",
                    "model-gateway",
                    "mcp-proxy",
                    "egress-proxy",
                    "clamav",
                    "embeddings",
                  ],
                },
              ],
            },
          },
        ],
      },
      // The Kubernetes API at its peers.
      {
        to: [{ ipBlock: { cidr: "10.0.0.1/32" } }],
        ports: [
          { protocol: "TCP", port: 443 },
          { protocol: "TCP", port: 6443 },
        ],
      },
      // S3, the identity provider, OAuth and model discovery on public addresses.
      publicOn(443),
      // SMTP relay on its port.
      publicOn(587),
    ]);
  });

  it("refuses to render without the API server's or the external database's peers", () => {
    const noApi = renderError({ "server.networkPolicy.restrictEgress": "true", ...DB_PEER });
    expect(noApi).toMatch(/server[./]networkPolicy[./]kubernetesApi[./]peers/);
    const noDb = renderError({ "server.networkPolicy.restrictEgress": "true", ...API_PEER });
    expect(noDb).toMatch(/server\.networkPolicy\.databasePeers/);
    // CloudNativePG needs no database peers (selected by label); off needs neither.
    expect(
      policy(
        render({
          "server.networkPolicy.restrictEgress": "true",
          ...API_PEER,
          "postgres.mode": "cnpg",
        }),
        "kobe-server-egress",
      ),
    ).toBeDefined();
    expect(policy(render(), "kobe-server-egress")).toBeUndefined();
  });

  it("narrows Postgres and the API server to the given peers, and appends extraEgress", () => {
    const spec = policy(
      render({
        "server.networkPolicy.restrictEgress": "true",
        "server.networkPolicy.databasePeers[0].ipBlock.cidr": "10.1.2.3/32",
        "server.networkPolicy.databasePort": "6432",
        "server.networkPolicy.kubernetesApi.peers[0].ipBlock.cidr": "10.0.0.1/32",
        "server.networkPolicy.kubernetesApi.ports[0]": "6443",
        "server.networkPolicy.allowedPorts[0]": "443",
        "server.networkPolicy.allowedPorts[1]": "8443",
        "smtp.port": "465",
        "server.networkPolicy.extraEgress[0].to[0].ipBlock.cidr": "192.168.5.5/32",
        "server.networkPolicy.extraEgress[0].ports[0].protocol": "TCP",
        "server.networkPolicy.extraEgress[0].ports[0].port": "9000",
      }),
      "kobe-server-egress",
    );
    expect(spec.egress[1]).toEqual({
      to: [{ ipBlock: { cidr: "10.1.2.3/32" } }],
      ports: [{ protocol: "TCP", port: 6432 }],
    });
    expect(spec.egress[3]).toEqual({
      to: [{ ipBlock: { cidr: "10.0.0.1/32" } }],
      ports: [{ protocol: "TCP", port: 6443 }],
    });
    expect(spec.egress[4]).toEqual(publicOn(443, 8443));
    expect(spec.egress[5]).toEqual(publicOn(465));
    expect(spec.egress.at(-1)).toEqual({
      to: [{ ipBlock: { cidr: "192.168.5.5/32" } }],
      ports: [{ protocol: "TCP", port: 9000 }],
    });
    expect(spec.egress).toHaveLength(7);
  });

  it("reaches the bundled Postgres instances by selector with CloudNativePG", () => {
    const spec = policy(
      render({
        "server.networkPolicy.restrictEgress": "true",
        ...API_PEER,
        "postgres.mode": "cnpg",
      }),
      "kobe-server-egress",
    );
    expect(spec.egress[1]).toEqual({
      to: [{ podSelector: { matchLabels: { "cnpg.io/cluster": "kobe-pg" } } }],
      ports: [{ protocol: "TCP", port: 5432 }],
    });
  });

  it("restricts web to DNS and the server's HTTP port, plus extraEgress", () => {
    const off = render({ "web.networkPolicy.restrictEgress": "false" });
    expect(policy(off, "kobe-web-egress")).toBeUndefined();
    const spec = policy(
      render({
        "web.networkPolicy.restrictEgress": "true",
        "web.networkPolicy.extraEgress[0].to[0].ipBlock.cidr": "10.7.7.7/32",
      }),
      "kobe-web-egress",
    );
    expect(spec.podSelector).toEqual({
      matchLabels: { ...release, "app.kubernetes.io/component": "web" },
    });
    expect(spec.policyTypes).toEqual(["Egress"]);
    expect(spec.egress).toEqual([
      DNS,
      {
        to: [
          { podSelector: { matchLabels: { ...release, "app.kubernetes.io/component": "server" } } },
        ],
        ports: [{ protocol: "TCP", port: 8080 }],
      },
      { to: [{ ipBlock: { cidr: "10.7.7.7/32" } }] },
    ]);
  });
});
