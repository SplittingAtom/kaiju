// Shared setup for the sandbox.*.test.ts files (split from sandbox.test.ts, KOBE-725).
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseAllDocuments } from "yaml";

// Render tests for the sandbox provider's chart pieces (KOBE-22): server config, RBAC, admission
// policies, session keys.

export const CHART_DIR = fileURLToPath(new URL("..", import.meta.url));
export const HELM = process.env.HELM_BIN ?? "helm";
export const BASE: Record<string, string> = {
  "ingress.host": "kobe.example.com",
  "postgres.external.existingSecret": "kobe-db",
  "s3.endpoint": "https://s3.example.com",
  "s3.bucket": "kobe",
  "s3.existingSecret": "kobe-s3",
  "smtp.host": "smtp.example.com",
  "smtp.from": "Kobe <kobe@example.com>",
  "global.allowGeneratedSecretsOffline": "true",
};

export type Manifest = {
  kind: string;
  metadata: { name: string; namespace?: string };
  [k: string]: any;
};

export function helm(values: Record<string, string>, extra: string[] = []): string {
  const args = Object.entries({ ...BASE, ...values }).flatMap(([k, v]) => ["--set", `${k}=${v}`]);
  return execFileSync(HELM, ["template", "kobe", CHART_DIR, "-n", "kobe", ...args, ...extra], {
    encoding: "utf8",
    stdio: "pipe",
  });
}

export function render(values: Record<string, string> = {}, extra: string[] = []): Manifest[] {
  return parseAllDocuments(helm(values, extra))
    .map((d) => d.toJSON() as Manifest | null)
    .filter((m): m is Manifest => m !== null);
}

export function renderError(values: Record<string, string>): string {
  try {
    helm(values);
  } catch (err) {
    return String((err as { stderr?: string }).stderr ?? err);
  }
  throw new Error("expected helm template to fail");
}

export const find = (ms: Manifest[], kind: string, name: string) =>
  ms.find((m) => m.kind === kind && m.metadata.name === name);
export const byKind = (ms: Manifest[], kind: string) => ms.filter((m) => m.kind === kind);
export const container = (ms: Manifest[], deployment: string) =>
  find(ms, "Deployment", deployment)?.spec.template.spec.containers[0];
export const envOf = (ms: Manifest[], deployment: string): { name: string; value?: string }[] =>
  container(ms, deployment)?.env ?? [];
export const sandboxConfig = (ms: Manifest[]) =>
  JSON.parse(envOf(ms, "kobe-server").find((e) => e.name === "KOBE_SANDBOX_CONFIG")?.value ?? "{}");
