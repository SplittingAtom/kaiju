import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

// Postgres connection budget (KOBE-736): pool sizes per component, the server's budget inputs and
// the bundled CloudNativePG Cluster's postgresql.parameters passthrough.

const CHART_DIR = fileURLToPath(new URL("..", import.meta.url));
const HELM = process.env.HELM_BIN ?? "helm";
const BASE: Record<string, string> = {
  "ingress.host": "kobe.example.com",
  "postgres.external.existingSecret": "kobe-db",
  "s3.endpoint": "https://s3.example.com",
  "s3.bucket": "kobe",
  "s3.existingSecret": "kobe-s3",
  "smtp.host": "smtp.example.com",
  "smtp.from": "Kaiju <kobe@example.com>",
  "global.allowGeneratedSecretsOffline": "true",
};

type Env = { name: string; value?: string };
type Manifest = { kind: string; metadata: { name: string }; [k: string]: any };

function helm(values: Record<string, string>, strings: Record<string, string> = {}): string {
  const args = [
    ...Object.entries({ ...BASE, ...values }).flatMap(([k, v]) => ["--set", `${k}=${v}`]),
    ...Object.entries(strings).flatMap(([k, v]) => ["--set-string", `${k}=${v}`]),
  ];
  return execFileSync(HELM, ["template", "kobe", CHART_DIR, "-n", "kobe", ...args], {
    encoding: "utf8",
    stdio: "pipe",
  });
}

function render(
  values: Record<string, string> = {},
  strings: Record<string, string> = {},
): Manifest[] {
  return parseAllDocuments(helm(values, strings))
    .map((d) => d.toJS() as Manifest | null)
    .filter((d): d is Manifest => d !== null);
}

const env = (ms: Manifest[], name: string): Env[] =>
  ms.find((m) => m.kind === "Deployment" && m.metadata.name === name)?.spec.template.spec
    .containers[0].env ?? [];
const value = (e: Env[], name: string) => e.find((x) => x.name === name)?.value;

describe("Postgres connection budget (KOBE-736)", () => {
  it("passes each component's pool size and the server's budget inputs at the defaults", () => {
    const ms = render();
    const server = env(ms, "kobe-server");
    expect(value(server, "KOBE_DB_POOL_MAX")).toBe("10");
    expect(value(server, "KOBE_DB_STREAM_POOL_MAX")).toBe("4");
    expect(value(server, "KOBE_DB_BUDGET_SERVER_REPLICAS")).toBe("2");
    // scheduler 1 x (10 + 1) + model gateway 2 x (10 + 1 + 2 rate limiter) + egress proxy 1 x (10 + 1)
    expect(value(server, "KOBE_DB_BUDGET_PEER_CONNECTIONS")).toBe("48");
    for (const name of ["kobe-scheduler", "kobe-model-gateway", "kobe-egress-proxy"]) {
      expect(value(env(ms, name), "KOBE_DB_POOL_MAX"), name).toBe("10");
    }
    expect(value(env(ms, "kobe-scheduler"), "KOBE_DB_STREAM_POOL_MAX")).toBeUndefined();
  });

  it("follows the configured pool sizes and replica counts", () => {
    const ms = render({
      "server.replicas": "3",
      "server.database.poolMax": "20",
      "server.database.streamPoolMax": "6",
      "scheduler.database.poolMax": "4",
      "modelGateway.replicas": "3",
      "modelGateway.database.poolMax": "5",
      "modelGateway.database.ratePoolMax": "3",
      "egressProxy.replicas": "2",
      "egressProxy.database.poolMax": "8",
    });
    const server = env(ms, "kobe-server");
    expect(value(server, "KOBE_DB_POOL_MAX")).toBe("20");
    expect(value(server, "KOBE_DB_STREAM_POOL_MAX")).toBe("6");
    expect(value(server, "KOBE_DB_BUDGET_SERVER_REPLICAS")).toBe("3");
    // 1 x (4 + 1) + 3 x (5 + 1 + 3 rate limiter) + 2 x (8 + 1)
    expect(value(server, "KOBE_DB_BUDGET_PEER_CONNECTIONS")).toBe("50");
    expect(value(env(ms, "kobe-model-gateway"), "KOBE_MODEL_GATEWAY_RATE_POOL_MAX")).toBe("3");
    expect(value(env(ms, "kobe-model-gateway"), "KOBE_DB_POOL_MAX")).toBe("5");
    expect(value(env(ms, "kobe-egress-proxy"), "KOBE_DB_POOL_MAX")).toBe("8");
  });

  it("rejects a pool size outside 1..200", () => {
    expect(() => helm({ "server.database.poolMax": "0" })).toThrow(/poolMax/);
    expect(() => helm({ "modelGateway.database.poolMax": "500" })).toThrow(/poolMax/);
  });

  it("passes postgres.cnpg.parameters verbatim to the Cluster, as strings", () => {
    const ms = render(
      { "postgres.mode": "cnpg", "postgres.external.existingSecret": "" },
      {
        "postgres.cnpg.parameters.max_connections": "200",
        "postgres.cnpg.parameters.shared_buffers": "512MB",
      },
    );
    const cluster = ms.find((m) => m.kind === "Cluster");
    expect(cluster?.spec.postgresql).toEqual({
      parameters: { max_connections: "200", shared_buffers: "512MB" },
    });
  });

  it("renders no postgresql section without parameters, and refuses non-string values", () => {
    const cluster = render({
      "postgres.mode": "cnpg",
      "postgres.external.existingSecret": "",
    }).find((m) => m.kind === "Cluster");
    expect(cluster?.spec.postgresql).toBeUndefined();
    expect(() =>
      execFileSync(
        HELM,
        [
          "template",
          "kobe",
          CHART_DIR,
          ...Object.entries({
            ...BASE,
            "postgres.mode": "cnpg",
            "postgres.external.existingSecret": "",
          }).flatMap(([k, v]) => ["--set", `${k}=${v}`]),
          "--set-json",
          'postgres.cnpg.parameters={"max_connections":200}',
        ],
        { encoding: "utf8", stdio: "pipe" },
      ),
    ).toThrow(/parameters/);
  });
});
