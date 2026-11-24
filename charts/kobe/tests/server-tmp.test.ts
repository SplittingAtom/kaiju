import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

// The server's /tmp size limit (KOBE-765): Convert to repo builds a project's git objects there.

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

type Manifest = { kind: string; metadata: { name: string }; [k: string]: any };

function render(values: Record<string, string> = {}): Manifest[] {
  const args = Object.entries({ ...BASE, ...values }).flatMap(([k, v]) => ["--set", `${k}=${v}`]);
  const out = execFileSync(HELM, ["template", "kobe", CHART_DIR, "-n", "kobe", ...args], {
    encoding: "utf8",
    stdio: "pipe",
  });
  return parseAllDocuments(out)
    .map((d) => d.toJS() as Manifest | null)
    .filter((d): d is Manifest => d !== null);
}

const tmpOf = (ms: Manifest[], name: string) =>
  ms
    .find((m) => m.kind === "Deployment" && m.metadata.name === name)
    ?.spec.template.spec.volumes.find((v: { name: string }) => v.name === "tmp");

describe("server /tmp size limit (KOBE-765)", () => {
  it("limits the server's /tmp to 8Gi by default and leaves other services as they were", () => {
    const ms = render();
    expect(tmpOf(ms, "kobe-server")).toEqual({ name: "tmp", emptyDir: { sizeLimit: "8Gi" } });
    expect(tmpOf(ms, "kobe-web")).toEqual({ name: "tmp", emptyDir: {} });
  });
  it("takes another value, or none", () => {
    expect(tmpOf(render({ "server.tmpSizeLimit": "10Gi" }), "kobe-server")).toEqual({
      name: "tmp",
      emptyDir: { sizeLimit: "10Gi" },
    });
    expect(tmpOf(render({ "server.tmpSizeLimit": "" }), "kobe-server")).toEqual({
      name: "tmp",
      emptyDir: {},
    });
  });
  it("refuses a value that is not a quantity", () => {
    expect(() => render({ "server.tmpSizeLimit": "lots" })).toThrow();
  });
});
