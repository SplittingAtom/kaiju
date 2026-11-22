import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

// KOBE-811: optional per-source-IP rate limit at the ingress (Traefik Middleware), off by default.
// Event streams (SSE) get their own Ingress and limit; the sandbox WebSocket and the MCP proxy never
// pass the ingress.

const CHART_DIR = fileURLToPath(new URL("..", import.meta.url));
const ROUTES_DIR = fileURLToPath(new URL("../../../services/server/src/routes/", import.meta.url));
const HELM = process.env.HELM_BIN ?? "helm";
const BASE: Record<string, string> = {
  "ingress.host": "kobe.example.com",
  "postgres.external.existingSecret": "kobe-db",
  "s3.endpoint": "https://s3.example.com",
  "s3.bucket": "kobe",
  "s3.existingSecret": "kobe-s3",
  "smtp.host": "smtp.example.com",
  "smtp.from": "Kobe <kobe@example.com>",
  "global.allowGeneratedSecretsOffline": "true",
};
const MIDDLEWARES = "traefik.ingress.kubernetes.io/router.middlewares";
const ON = { "ingress.rateLimit.enabled": "true" };

type Manifest = {
  apiVersion: string;
  kind: string;
  metadata: { name: string; annotations?: Record<string, string> | null };
  [k: string]: any;
};

// Pinned so the result does not depend on the helm client's default Kubernetes version.
const KUBE = "1.34.0";

function helm(values: Record<string, string>, kubeVersion = KUBE): string {
  const args = Object.entries({ ...BASE, ...values }).flatMap(([k, v]) => ["--set", `${k}=${v}`]);
  return execFileSync(
    HELM,
    ["template", "kobe", CHART_DIR, "-n", "kobe", "--kube-version", kubeVersion, ...args],
    {
      encoding: "utf8",
      stdio: "pipe",
    },
  );
}

function render(values: Record<string, string> = {}): Manifest[] {
  return parseAllDocuments(helm(values))
    .map((d) => d.toJSON() as Manifest | null)
    .filter((m): m is Manifest => m !== null);
}

const find = (ms: Manifest[], kind: string, name: string) =>
  ms.find((m) => m.kind === kind && m.metadata.name === name);

function must(ms: Manifest[], kind: string, name: string): Manifest {
  const m = find(ms, kind, name);
  if (!m) throw new Error(`no ${kind} ${name}`);
  return m;
}

function streamRegexp(ms: Manifest[]): RegExp {
  const path = find(ms, "Ingress", "kobe-streams")?.spec.rules[0].http.paths[0].path as string;
  return new RegExp(path); // Traefik matches with Go regexp; this pattern is the RE2/JS common subset
}

describe("ingress.rateLimit off (default)", () => {
  const ms = render();

  it("renders no Middleware and no streams Ingress", () => {
    expect(ms.filter((m) => m.kind === "Middleware")).toEqual([]);
    expect(find(ms, "Ingress", "kobe-streams")).toBeUndefined();
  });

  it("leaves the main Ingress without a middleware annotation", () => {
    expect(find(ms, "Ingress", "kobe")?.metadata.annotations?.[MIDDLEWARES]).toBeUndefined();
  });
});

describe("ingress.rateLimit on", () => {
  const ms = render(ON);
  const main = must(ms, "Ingress", "kobe");
  const streams = must(ms, "Ingress", "kobe-streams");

  it("adds a traefik.io/v1alpha1 rateLimit Middleware with the default average, burst and period", () => {
    const mw = must(ms, "Middleware", "kobe-ratelimit");
    expect(mw.apiVersion).toBe("traefik.io/v1alpha1");
    expect(mw.spec).toEqual({ rateLimit: { average: 100, burst: 300, period: "1s" } });
    expect(main.metadata.annotations?.[MIDDLEWARES]).toBe("kobe-kobe-ratelimit@kubernetescrd");
  });

  it("takes average, burst and period from values", () => {
    const custom = render({
      ...ON,
      "ingress.rateLimit.average": "20",
      "ingress.rateLimit.burst": "40",
      "ingress.rateLimit.period": "10s",
    });
    expect(find(custom, "Middleware", "kobe-ratelimit")?.spec.rateLimit).toEqual({
      average: 20,
      burst: 40,
      period: "10s",
    });
  });

  it("gives event streams their own Ingress and limit, with no cert-manager ownership", () => {
    expect(find(ms, "Middleware", "kobe-ratelimit-streams")?.spec).toEqual({
      rateLimit: { average: 60, burst: 120, period: "1m" },
    });
    const a = streams.metadata.annotations ?? {};
    expect(a[MIDDLEWARES]).toBe("kobe-kobe-ratelimit-streams@kubernetescrd");
    expect(a["traefik.ingress.kubernetes.io/router.pathmatcher"]).toBe("PathRegexp");
    const path = streams.spec.rules[0].http.paths[0];
    expect(path.pathType).toBe("ImplementationSpecific");
    expect(path.backend.service).toEqual({ name: "kobe-server", port: { name: "http" } });
    const issued = render({ ...ON, "ingress.tls.clusterIssuer": "le" });
    expect(
      find(issued, "Ingress", "kobe")?.metadata.annotations?.["cert-manager.io/cluster-issuer"],
    ).toBe("le");
    expect(
      find(issued, "Ingress", "kobe-streams")?.metadata.annotations?.[
        "cert-manager.io/cluster-issuer"
      ],
    ).toBeUndefined();
  });

  it("routes every SSE endpoint the server serves to the streams Ingress, and nothing else", () => {
    const re = streamRegexp(ms);
    for (const p of [
      "/v1/runs/0b9c6f0e-1111-4222-8333-444455556666/events",
      "/v1/workspace/events",
      "/v1/workspace/changes",
      "/v1/skill-evals/abc/events",
    ]) {
      expect(re.test(p), p).toBe(true);
    }
    for (const p of [
      "/v1/runs",
      "/v1/runs/x",
      "/v1/runs/x/events/more",
      "/v1/workspace/files",
      "/",
      "/api/auth/session",
    ]) {
      expect(re.test(p), p).toBe(false);
    }
  });

  it("knows every server route module that streams (update the stream path list when this fails)", () => {
    const streaming = readdirSync(ROUTES_DIR)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .filter((f) => readFileSync(ROUTES_DIR + f, "utf8").includes("SSE_HEADERS"))
      .sort();
    expect(streaming).toEqual([
      "run-events.ts",
      "skill-evals.ts",
      "workspace-changes.ts",
      "workspace-events.ts",
    ]);
  });

  it("never exposes the sandbox WebSocket or internal (MCP proxy) ports through an Ingress", () => {
    const ports = ms
      .filter((m) => m.kind === "Ingress")
      .flatMap((m) =>
        m.spec.rules.flatMap((r: any) => r.http.paths.map((p: any) => p.backend.service.port.name)),
      );
    expect(new Set(ports)).toEqual(new Set(["http"]));
  });

  it("can leave streams unlimited", () => {
    const off = render({ ...ON, "ingress.rateLimit.streams.enabled": "false" });
    expect(find(off, "Middleware", "kobe-ratelimit-streams")).toBeUndefined();
    expect(
      find(off, "Ingress", "kobe-streams")?.metadata.annotations?.[MIDDLEWARES],
    ).toBeUndefined();
  });

  it("keeps middlewares the operator set in ingress.annotations, after its own", () => {
    const user = render({
      ...ON,
      [`ingress.annotations.${MIDDLEWARES.replace(/\./g, "\\.")}`]: "mine-auth@kubernetescrd",
    });
    expect(find(user, "Ingress", "kobe")?.metadata.annotations?.[MIDDLEWARES]).toBe(
      "kobe-kobe-ratelimit@kubernetescrd,mine-auth@kubernetescrd",
    );
    expect(find(user, "Ingress", "kobe-streams")?.metadata.annotations?.[MIDDLEWARES]).toBe(
      "kobe-kobe-ratelimit-streams@kubernetescrd,mine-auth@kubernetescrd",
    );
  });
});

describe("ingress.rateLimit.ipStrategy", () => {
  const strategy = (values: Record<string, string>) =>
    find(render({ ...ON, ...values }), "Middleware", "kobe-ratelimit")?.spec.rateLimit
      .sourceCriterion;

  it("uses the remote address by default", () => {
    expect(strategy({})).toBeUndefined();
  });

  it("sets depth", () => {
    expect(strategy({ "ingress.rateLimit.ipStrategy.depth": "1" })).toEqual({
      ipStrategy: { depth: 1 },
    });
  });

  it("excludes the server's trusted proxies plus extra CIDRs, on both middlewares", () => {
    const values = {
      "ingress.rateLimit.ipStrategy.excludeTrustedProxies": "true",
      "ingress.rateLimit.ipStrategy.excludedIPs[0]": "192.0.2.0/24",
    };
    const want = { ipStrategy: { excludedIPs: ["192.0.2.0/24", "10.42.0.0/16"] } };
    expect(strategy(values)).toEqual(want);
    const ms = render({ ...ON, ...values });
    expect(
      find(ms, "Middleware", "kobe-ratelimit-streams")?.spec.rateLimit.sourceCriterion,
    ).toEqual(want);
  });

  it("refuses excludeTrustedProxies with nothing to exclude", () => {
    expect(() =>
      helm({
        ...ON,
        "ingress.rateLimit.ipStrategy.excludeTrustedProxies": "true",
        "auth.trustedProxies": "null",
      }),
    ).toThrow(/nothing to exclude/);
  });

  it("accepts IPv6 and single addresses", () => {
    expect(
      strategy({
        "ingress.rateLimit.ipStrategy.excludedIPs[0]": "2001:db8::/32",
        "ingress.rateLimit.ipStrategy.excludedIPs[1]": "192.0.2.7",
      }),
    ).toEqual({ ipStrategy: { excludedIPs: ["2001:db8::/32", "192.0.2.7"] } });
  });

  it("refuses a malformed auth.trustedProxies entry when it would reach the middleware", () => {
    expect(() =>
      helm({
        ...ON,
        "ingress.rateLimit.ipStrategy.excludeTrustedProxies": "true",
        "auth.trustedProxies[0]": "10.42.0.0/99",
      }),
    ).toThrow(/not an IPv4\/IPv6 address or CIDR/);
  });

  it("refuses depth together with excluded IPs", () => {
    expect(() =>
      helm({
        ...ON,
        "ingress.rateLimit.ipStrategy.depth": "1",
        "ingress.rateLimit.ipStrategy.excludeTrustedProxies": "true",
      }),
    ).toThrow(/not both/);
  });
});

describe("ingress.rateLimit needs Traefik v3 (PathRegexp)", () => {
  it("refuses to render below Kubernetes 1.32 (k3s ships Traefik v2 there)", () => {
    expect(() => helm(ON, "1.31.4")).toThrow(/needs Traefik v3/);
    expect(() => helm(ON, "1.30.0")).toThrow(/assumeTraefikV3/);
  });

  it("renders on 1.32 and later", () => {
    expect(helm(ON, "1.32.0")).toContain("kind: Middleware");
  });

  it("renders below 1.32 when the operator asserts Traefik v3", () => {
    expect(helm({ ...ON, "ingress.rateLimit.assumeTraefikV3": "true" }, "1.30.0")).toContain(
      "kind: Middleware",
    );
  });

  it("does not check the version while the limit is off", () => {
    expect(helm({}, "1.30.0")).not.toContain("kind: Middleware");
  });
});

describe("ingress.rateLimit schema", () => {
  it.each([
    ["ingress.rateLimit.enabled", "maybe"],
    ["ingress.rateLimit.average", "0"],
    ["ingress.rateLimit.burst", "-1"],
    ["ingress.rateLimit.period", "soon"],
    ["ingress.rateLimit.streams.period", "1d"],
    ["ingress.rateLimit.ipStrategy.depth", "-1"],
    ["ingress.rateLimit.ipStrategy.excludedIPs[0]", "not-a-cidr"],
    ["ingress.rateLimit.ipStrategy.excludedIPs[0]", "..."],
    ["ingress.rateLimit.ipStrategy.excludedIPs[0]", "10.0.0.0/99"],
    ["ingress.rateLimit.ipStrategy.excludedIPs[0]", "256.1.1.1"],
    ["ingress.rateLimit.ipStrategy.excludedIPs[0]", "2001:db8::/129"],
    ["ingress.rateLimit.assumeTraefikV3", "maybe"],
    ["ingress.rateLimit.nope", "1"],
  ])("refuses %s=%s", (key, value) => {
    expect(() => helm({ ...ON, [key]: value })).toThrow();
  });
});

describe("KOBE_INGRESS_RATE_LIMIT for the Site console's health view", () => {
  const source = (values: Record<string, string>) => {
    const dep = must(render(values), "Deployment", "kobe-server");
    const env = dep.spec.template.spec.containers[0].env as { name: string; value?: string }[];
    return env.find((e) => e.name === "KOBE_INGRESS_RATE_LIMIT")?.value;
  };

  it("is none while the chart's Ingress has no limit (default)", () => {
    expect(source({})).toBe("none");
  });

  it("is chart when the chart's limit is on", () => {
    expect(source(ON)).toBe("chart");
  });

  it("is external when the operator declares their own edge limit", () => {
    expect(source({ "ingress.rateLimit.external": "true" })).toBe("external");
    expect(source({ "ingress.enabled": "false", "ingress.rateLimit.external": "true" })).toBe(
      "external",
    );
  });

  it("is unknown when the chart does not manage the Ingress and nothing is declared", () => {
    expect(source({ "ingress.enabled": "false", publicUrl: "https://kobe.example.com" })).toBe(
      "unknown",
    );
  });

  it("is set on the API server only", () => {
    const web = must(render({}), "Deployment", "kobe-web");
    const env = web.spec.template.spec.containers[0].env as { name: string }[];
    expect(env.some((e) => e.name === "KOBE_INGRESS_RATE_LIMIT")).toBe(false);
  });
});
