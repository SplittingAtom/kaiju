import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// KOBE-694: the install-wide `allowedInternalCidrs` (MCP proxy, egress proxy, SSO) never re-open
// an always-refused range; the schema mirrors the services' startup check. A private LAN /30
// still passes.

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

function render(key: string, cidrs: readonly string[]): void {
  const args = Object.entries(BASE).flatMap(([k, v]) => ["--set", `${k}=${v}`]);
  args.push("--set-json", `${key}=${JSON.stringify(cidrs)}`);
  execFileSync(HELM, ["template", "kaiju", CHART_DIR, "-n", "kaiju", ...args], {
    encoding: "utf8",
    stdio: "pipe",
  });
}

const KEYS = [
  "mcpProxy.allowedInternalCidrs",
  "egressProxy.allowedInternalCidrs",
  "auth.sso.allowedInternalCidrs",
] as const;

const GOOD = ["192.168.10.4/30", "10.0.0.0/8", "172.16.0.0/12", "100.64.0.0/10", "fd00::/8"];
const BAD = [
  "0.0.0.0/0",
  "0.0.0.0/8",
  "127.0.0.0/8",
  "127.0.0.1/32",
  "169.254.0.0/16",
  "169.254.169.254/32",
  "169.0.0.0/8",
  "128.0.0.0/1",
  "224.0.0.0/4",
  "100.100.100.200/32",
  "::/0",
  "::1/128",
  "::ffff:10.0.0.1/128",
  "64:ff9b::/96",
  "2002::/16",
  "2000::/3",
  "fe80::/10",
  "ff00::/8",
  "fc00::/3",
];

describe.each(KEYS)("%s", (key) => {
  it("accepts private LAN and cluster ranges", () => {
    expect(() => render(key, GOOD)).not.toThrow();
  });

  it.each(BAD)("refuses %s", (cidr) => {
    expect(() => render(key, ["192.168.10.4/30", cidr])).toThrow(/allowedInternalCidrs/);
  });
});
