import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

// KOBE-695: `ingress.hsts.includeSubDomains` (default off) reaches the server and the web as
// KAIJU_HSTS_INCLUDE_SUBDOMAINS; both send HSTS themselves when the public URL is https.

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

type Manifest = { kind: string; metadata: { name: string }; [k: string]: any };
type EnvVar = { name: string; value?: string };

function helm(values: Record<string, string>): string {
  const args = Object.entries({ ...BASE, ...values }).flatMap(([k, v]) => ["--set", `${k}=${v}`]);
  return execFileSync(HELM, ["template", "kaiju", CHART_DIR, "-n", "kaiju", ...args], {
    encoding: "utf8",
    stdio: "pipe",
  });
}

function hstsEnv(deployment: string, values: Record<string, string> = {}): string | undefined {
  const ms = parseAllDocuments(helm(values))
    .map((d) => d.toJSON() as Manifest | null)
    .filter((m): m is Manifest => m !== null);
  const dep = ms.find((m) => m.kind === "Deployment" && m.metadata.name === deployment);
  const env = (dep?.spec.template.spec.containers[0].env ?? []) as EnvVar[];
  return env.find((e) => e.name === "KAIJU_HSTS_INCLUDE_SUBDOMAINS")?.value;
}

describe("ingress.hsts.includeSubDomains -> KAIJU_HSTS_INCLUDE_SUBDOMAINS", () => {
  it("is off by default for the server and the web", () => {
    expect(hstsEnv("kaiju-server")).toBe("false");
    expect(hstsEnv("kaiju-web")).toBe("false");
  });

  it("is on for both when set", () => {
    const on = { "ingress.hsts.includeSubDomains": "true" };
    expect(hstsEnv("kaiju-server", on)).toBe("true");
    expect(hstsEnv("kaiju-web", on)).toBe("true");
  });

  it("refuses a non-boolean value", () => {
    expect(() => helm({ "ingress.hsts.includeSubDomains": "maybe" })).toThrow();
  });
});
