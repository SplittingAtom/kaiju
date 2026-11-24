// Shared setup for the render.*.test.ts files (split from render.test.ts, KOBE-725).
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseAllDocuments } from "yaml";

export const CHART_DIR = fileURLToPath(new URL("..", import.meta.url));
export const HELM = process.env.HELM_BIN ?? "helm";

/** Minimal values a real install must provide (external Postgres + S3, ingress host, pull secret). */
export const BASE: Record<string, string> = {
  "ingress.host": "kaiju.example.com",
  "postgres.external.existingSecret": "kaiju-db",
  "s3.endpoint": "https://s3.example.com",
  "s3.bucket": "kaiju",
  "s3.existingSecret": "kaiju-s3",
  "smtp.host": "smtp.example.com",
  "smtp.from": "Kaiju <kaiju@example.com>",
  "global.imagePullSecrets[0].name": "ghcr-pull",
  // helm template renders offline; production renders either reach the cluster or use existingSecrets.
  "global.allowGeneratedSecretsOffline": "true",
};

export type Manifest = {
  kind: string;
  metadata: { name: string; annotations?: Record<string, string> };
  spec?: any;
  data?: Record<string, string>;
};

export function helmArgs(values: Record<string, string>): string[] {
  return Object.entries({ ...BASE, ...values }).flatMap(([k, v]) => ["--set", `${k}=${v}`]);
}

export function render(
  values: Record<string, string> = {},
  {
    release = "kaiju",
    namespace = "kaiju",
    upgrade = false,
  }: { release?: string; namespace?: string; upgrade?: boolean } = {},
): Manifest[] {
  const out = execFileSync(
    HELM,
    [
      "template",
      release,
      CHART_DIR,
      "-n",
      namespace,
      ...(upgrade ? ["--is-upgrade"] : []),
      ...helmArgs(values),
    ],
    { encoding: "utf8" },
  );
  return parseAllDocuments(out)
    .map((d) => d.toJSON() as Manifest | null)
    .filter((m): m is Manifest => m !== null);
}

export function renderError(values: Record<string, string>, unset: string[] = []): string {
  const base = Object.fromEntries(Object.entries(BASE).filter(([k]) => !unset.includes(k)));
  const args = Object.entries({ ...base, ...values }).flatMap(([k, v]) => ["--set", `${k}=${v}`]);
  try {
    execFileSync(HELM, ["template", "kaiju", CHART_DIR, "-n", "kaiju", ...args], {
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (err) {
    return String((err as { stderr?: string }).stderr ?? err);
  }
  throw new Error(`expected helm template to fail for ${JSON.stringify(values)}`);
}

export function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what} in the rendered chart`);
  return value;
}

export const byKind = (ms: Manifest[], kind: string) => ms.filter((m) => m.kind === kind);
export const find = (ms: Manifest[], kind: string, name: string) =>
  ms.find((m) => m.kind === kind && m.metadata.name === name);
export const podSpecs = (ms: Manifest[]) =>
  ms
    .filter((m) => ["Deployment", "StatefulSet", "Job", "DaemonSet"].includes(m.kind))
    .map((m) => ({ name: `${m.kind}/${m.metadata.name}`, spec: m.spec.template.spec }));
