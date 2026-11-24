import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

// Render tests for server.skillMirror (KOBE-343): the catalog git mirror's token comes from an
// existing Secret (optional, never a value), the identity from values; only the server gets them.

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
type Env = { name: string; value?: string; valueFrom?: unknown };

function render(values: Record<string, string>): Manifest[] {
  const args = Object.entries({ ...BASE, ...values }).flatMap(([k, v]) => ["--set", `${k}=${v}`]);
  const out = execFileSync(HELM, ["template", "kaiju", CHART_DIR, "-n", "kaiju", ...args], {
    encoding: "utf8",
    stdio: "pipe",
  });
  return parseAllDocuments(out)
    .map((d) => d.toJSON() as Manifest | null)
    .filter((m): m is Manifest => m !== null);
}

const envOf = (ms: Manifest[], name: string): Env[] =>
  ms.find((m) => m.kind === "Deployment" && m.metadata.name === name)?.spec.template.spec
    .containers[0].env ?? [];
const mirrorEnv = (env: Env[]) => env.filter((e) => e.name.startsWith("KAIJU_SKILL_MIRROR_"));

describe("server.skillMirror", () => {
  it("defaults: identity only, no token", () => {
    expect(mirrorEnv(envOf(render({}), "kaiju-server"))).toEqual([
      { name: "KAIJU_SKILL_MIRROR_USERNAME", value: "x-access-token" },
      { name: "KAIJU_SKILL_MIRROR_AUTHOR_NAME", value: "Kaiju Registry" },
      { name: "KAIJU_SKILL_MIRROR_AUTHOR_EMAIL", value: "registry@kaiju.invalid" },
    ]);
  });

  it("reads the token from the named Secret (optional), on the server only", () => {
    const ms = render({
      "server.skillMirror.tokenSecret.name": "mirror-token",
      "server.skillMirror.tokenSecret.key": "pat",
      "server.skillMirror.username": "kaiju-bot",
    });
    expect(mirrorEnv(envOf(ms, "kaiju-server"))).toContainEqual({
      name: "KAIJU_SKILL_MIRROR_TOKEN",
      valueFrom: { secretKeyRef: { name: "mirror-token", key: "pat", optional: true } },
    });
    expect(mirrorEnv(envOf(ms, "kaiju-server"))[0]).toEqual({
      name: "KAIJU_SKILL_MIRROR_USERNAME",
      value: "kaiju-bot",
    });
    for (const other of ["kaiju-scheduler", "kaiju-egress-proxy", "kaiju-mcp-proxy", "kaiju-web"])
      expect(mirrorEnv(envOf(ms, other)), other).toEqual([]);
  });

  it("refuses a bad Secret name or user name (schema)", () => {
    expect(() => render({ "server.skillMirror.tokenSecret.name": "Bad_Name" })).toThrow();
    expect(() => render({ "server.skillMirror.username": "a b" })).toThrow();
  });
});
