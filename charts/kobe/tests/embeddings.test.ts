import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";
import { loadModelsConfig } from "../../../services/server/src/models/config.js";

// Render tests for the optional in-cluster CPU embedding service (KOBE-659): llama.cpp's
// llama-server with nomic-embed-text, reachable only from Bifrost, and handed to the server so the
// gateway sync registers it as the Bifrost provider `kobe-local`.

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

type Manifest = { kind: string; metadata: { name: string; labels?: any }; [k: string]: any };
type EnvVar = { name: string; value?: string; valueFrom?: any };

function helm(values: Record<string, string>, json: Record<string, unknown> = {}): string {
  const args = [
    ...Object.entries({ ...BASE, ...values }).flatMap(([k, v]) => ["--set", `${k}=${v}`]),
    ...Object.entries(json).flatMap(([k, v]) => ["--set-json", `${k}=${JSON.stringify(v)}`]),
  ];
  return execFileSync(HELM, ["template", "kobe", CHART_DIR, "-n", "kobe", ...args], {
    encoding: "utf8",
    stdio: "pipe",
  });
}

function render(values: Record<string, string> = {}, json: Record<string, unknown> = {}) {
  return parseAllDocuments(helm(values, json))
    .map((d) => d.toJSON() as Manifest | null)
    .filter((m): m is Manifest => m !== null);
}

const find = (ms: Manifest[], kind: string, name: string) =>
  ms.find((m) => m.kind === kind && m.metadata.name === name);
const pod = (ms: Manifest[], name: string) => find(ms, "Deployment", name)?.spec.template.spec;
const env = (ms: Manifest[], name: string): EnvVar[] => pod(ms, name)?.containers[0].env ?? [];
const selector = (component: string) => ({
  "app.kubernetes.io/name": "kobe",
  "app.kubernetes.io/instance": "kobe",
  "app.kubernetes.io/component": component,
});

describe("embeddings.local (enabled by default)", () => {
  const ms = render();
  const deployment = find(ms, "Deployment", "kobe-embeddings");
  const spec = pod(ms, "kobe-embeddings");
  const main = spec?.containers[0];

  it("runs llama.cpp's server pinned by version and digest, never latest", () => {
    expect(main.image).toMatch(/^ghcr\.io\/ggml-org\/llama\.cpp:server-b\d+@sha256:[0-9a-f]{64}$/);
    expect(main.image).not.toMatch(/latest/);
    expect(() => helm({ "embeddings.local.image.tag": "latest" })).toThrow(/tag|pattern/);
    expect(deployment?.spec.replicas).toBe(1);
    expect(() => helm({ "embeddings.local.image.digest": "" })).toThrow(/digest|pattern/);
  });

  it("serves the model under its gateway name, embeddings only, without the web UI", () => {
    const args: string[] = main.args;
    const arg = (flag: string) => args[args.indexOf(flag) + 1];
    expect(arg("--model")).toBe("/models/nomic-embed-text-v1.5.f16.gguf");
    expect(arg("--alias")).toBe("nomic-embed-text");
    expect(args).toContain("--embeddings");
    expect(args).toContain("--no-webui");
    expect(arg("--port")).toBe("8080");
    expect(arg("--threads")).toBe("2");
    expect(arg("--ctx-size")).toBe("2048");
    expect(main.ports).toEqual([{ name: "http", containerPort: 8080 }]);
    expect(main.readinessProbe.httpGet).toEqual({ path: "/health", port: "http" });
  });

  it("runs non-root with a read-only root filesystem and no service account token", () => {
    expect(spec.securityContext).toMatchObject({ runAsNonRoot: true, runAsUser: 1000 });
    for (const c of [...spec.initContainers, ...spec.containers]) {
      expect(c.securityContext).toEqual({
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        capabilities: { drop: ["ALL"] },
      });
    }
    expect(spec.automountServiceAccountToken).toBe(false);
  });

  it("asks for about one CPU and 1 GiB, from values", () => {
    expect(main.resources).toEqual({
      requests: { cpu: "1", memory: "1Gi" },
      limits: { cpu: "2", memory: "1Gi" },
    });
    const custom = pod(
      render({
        "embeddings.local.resources.requests.cpu": "500m",
        "embeddings.local.threads": "4",
      }),
      "kobe-embeddings",
    );
    expect(custom?.containers[0].resources.requests.cpu).toBe("500m");
    expect(custom?.containers[0].args).toContain("4");
  });

  it("fetches the pinned model into a PVC once and verifies its sha256", () => {
    const init = spec.initContainers[0];
    expect(init.name).toBe("model");
    expect(init.image).toBe(main.image);
    const vars = Object.fromEntries((init.env as EnvVar[]).map((v) => [v.name, v.value]));
    expect(vars.MODEL_DOWNLOAD).toBe("true");
    expect(vars.MODEL_URL).toMatch(
      /^https:\/\/huggingface\.co\/nomic-ai\/nomic-embed-text-v1\.5-GGUF\/resolve\/[0-9a-f]{40}\//,
    );
    expect(vars.MODEL_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(init.command.join(" ")).toContain("sha256sum -c");
    const pvc = find(ms, "PersistentVolumeClaim", "kobe-embeddings");
    expect(pvc?.spec.resources.requests.storage).toBe("1Gi");
    const models = spec.volumes.find((v: any) => v.name === "models");
    expect(models.persistentVolumeClaim.claimName).toBe("kobe-embeddings");
    // The model volume is read-only for the server itself.
    expect(main.volumeMounts).toContainEqual({
      name: "models",
      mountPath: "/models",
      readOnly: true,
    });
  });

  it("uses a preloaded claim (air-gapped) and never downloads when told not to", () => {
    const air = render({
      "embeddings.local.persistence.existingClaim": "kobe-models",
      "embeddings.local.model.download": "false",
    });
    expect(find(air, "PersistentVolumeClaim", "kobe-embeddings")).toBeUndefined();
    const s = pod(air, "kobe-embeddings");
    expect(s.volumes.find((v: any) => v.name === "models").persistentVolumeClaim.claimName).toBe(
      "kobe-models",
    );
    const vars = Object.fromEntries(
      (s.initContainers[0].env as EnvVar[]).map((v) => [v.name, v.value]),
    );
    expect(vars.MODEL_DOWNLOAD).toBe("false");
    // No egress at all: not even DNS.
    const np = find(air, "NetworkPolicy", "kobe-embeddings");
    expect(np?.spec.policyTypes).toEqual(["Ingress", "Egress"]);
    expect(np?.spec.egress ?? []).toEqual([]);
  });

  it("has no egress once download is off on its own PVC (after the first start)", () => {
    const off = render({ "embeddings.local.model.download": "false" });
    expect(find(off, "PersistentVolumeClaim", "kobe-embeddings")).toBeDefined();
    const np = find(off, "NetworkPolicy", "kobe-embeddings");
    expect(np?.spec.policyTypes).toEqual(["Ingress", "Egress"]);
    expect(np?.spec.egress ?? []).toEqual([]);
    expect(find(ms, "NetworkPolicy", "kobe-embeddings")?.spec.egress.length).toBeGreaterThan(0);
  });

  it("admits only Bifrost, on the server port", () => {
    const np = find(ms, "NetworkPolicy", "kobe-embeddings");
    expect(np?.spec.podSelector.matchLabels).toEqual(selector("embeddings"));
    expect(np?.spec.ingress).toEqual([
      {
        from: [{ podSelector: { matchLabels: selector("bifrost") } }],
        ports: [{ protocol: "TCP", port: 8080 }],
      },
    ]);
  });

  it("allows egress only for the model download: DNS and public HTTPS", () => {
    const np = find(ms, "NetworkPolicy", "kobe-embeddings");
    expect(np?.spec.policyTypes).toEqual(["Ingress", "Egress"]);
    const ports = np?.spec.egress.flatMap((r: any) => r.ports.map((p: any) => p.port));
    expect(ports.sort((a: number, b: number) => a - b)).toEqual([53, 53, 443]);
    const https = np?.spec.egress.find((r: any) => r.ports[0].port === 443);
    expect(https.to[0].ipBlock.cidr).toBe("0.0.0.0/0");
    expect(https.to[0].ipBlock.except).toContain("10.0.0.0/8");
    const extra = {
      to: [{ ipBlock: { cidr: "10.9.8.7/32" } }],
      ports: [{ protocol: "TCP", port: 80 }],
    };
    const mirrored = find(
      render({}, { "embeddings.local.networkPolicy.extraEgress": [extra] }),
      "NetworkPolicy",
      "kobe-embeddings",
    );
    expect(mirrored?.spec.egress).toContainEqual(extra);
  });

  it("lets Bifrost reach it (Bifrost's own egress policy)", () => {
    const np = find(ms, "NetworkPolicy", "kobe-bifrost");
    expect(np?.spec.egress).toContainEqual({
      to: [{ podSelector: { matchLabels: selector("embeddings") } }],
      ports: [{ protocol: "TCP", port: 8080 }],
    });
  });

  it("hands the server its URL and model, which the server config accepts", () => {
    const vars = env(ms, "kobe-server");
    const get = (n: string) => vars.find((v) => v.name === n)?.value;
    expect(get("KOBE_EMBEDDINGS_LOCAL_URL")).toBe("http://kobe-embeddings:8080");
    expect(get("KOBE_EMBEDDINGS_LOCAL_MODEL")).toBe("nomic-embed-text");
    const resolved = Object.fromEntries(
      vars.map((v, i) => [v.name, v.value ?? `${String(i).padStart(2, "0")}${"s".repeat(46)}`]),
    );
    expect(loadModelsConfig(resolved)?.localEmbedding).toEqual({
      url: "http://kobe-embeddings:8080",
      model: "nomic-embed-text",
    });
  });
});

describe("embeddings.local.enabled=false", () => {
  const ms = render({ "embeddings.local.enabled": "false" });

  it("leaves nothing behind", () => {
    const left = ms.filter(
      (m) =>
        m.metadata.name.includes("embeddings") ||
        m.metadata.labels?.["app.kubernetes.io/component"] === "embeddings",
    );
    expect(left).toEqual([]);
    expect(JSON.stringify(find(ms, "NetworkPolicy", "kobe-bifrost"))).not.toContain("embeddings");
    expect(env(ms, "kobe-server").map((v) => v.name)).not.toContain("KOBE_EMBEDDINGS_LOCAL_URL");
  });

  it("keeps external models configured through the gateway as before", () => {
    // A LAN Ollama or hosted provider is a Site console provider; its route is Bifrost's egress.
    const extra = {
      to: [{ ipBlock: { cidr: "10.20.30.40/32" } }],
      ports: [{ protocol: "TCP", port: 11434 }],
    };
    const off = render(
      { "embeddings.local.enabled": "false" },
      { "bifrost.networkPolicy.extraEgress": [extra] },
    );
    expect(find(off, "NetworkPolicy", "kobe-bifrost")?.spec.egress).toContainEqual(extra);
  });
});
