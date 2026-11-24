import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ISOLATION_HANDLER,
  ISOLATION_REMEDIATION,
} from "../../../services/server/src/isolation/runtime-class.js";
import {
  CHART_DIR,
  type Manifest,
  render,
  renderError,
  must,
  byKind,
  find,
  podSpecs,
} from "./render.test-helpers.js";

describe("workloads", () => {
  const ms = render();

  it("deploys web, server, mcp-proxy, egress-proxy, model-gateway, scheduler, Bifrost and embeddings", () => {
    expect(
      byKind(ms, "Deployment")
        .map((d) => d.metadata.name)
        .sort(),
    ).toEqual(
      [
        "kaiju-bifrost",
        "kaiju-embeddings",
        "kaiju-egress-proxy",
        "kaiju-mcp-proxy",
        "kaiju-model-gateway",
        "kaiju-scheduler",
        "kaiju-server",
        "kaiju-web",
      ].sort(),
    );
  });

  it("runs at least two server replicas", () => {
    expect(find(ms, "Deployment", "kaiju-server")?.spec.replicas).toBeGreaterThanOrEqual(2);
    expect(renderError({ "server.replicas": "1" })).toMatch(/replicas/);
  });

  it("passes the team-namespace reconcile interval to the server only (KOBE-115)", () => {
    const envOf = (ms2: Manifest[], name: string): { name: string; value?: string }[] =>
      find(ms2, "Deployment", name)?.spec.template.spec.containers[0].env ?? [];
    const value = (ms2: Manifest[], name: string) =>
      envOf(ms2, name).find((e) => e.name === "KAIJU_TEAM_RECONCILE_SECONDS")?.value;
    expect(value(ms, "kaiju-server")).toBe("300");
    expect(value(ms, "kaiju-scheduler")).toBeUndefined();
    expect(value(render({ "server.teamReconcileSeconds": "0" }), "kaiju-server")).toBe("0");
    expect(renderError({ "server.teamReconcileSeconds": "-1" })).toMatch(/teamReconcileSeconds/);
  });

  it("passes the incomplete-rescan suspension period to the server only (KOBE-781 review)", () => {
    const value = (ms2: Manifest[], name: string) =>
      (
        (find(ms2, "Deployment", name)?.spec.template.spec.containers[0].env ?? []) as {
          name: string;
          value?: string;
        }[]
      ).find((e) => e.name === "KAIJU_SKILL_RESCAN_INCOMPLETE_SUSPEND_HOURS")?.value;
    expect(value(ms, "kaiju-server")).toBe("24");
    expect(value(ms, "kaiju-scheduler")).toBeUndefined();
    expect(value(render({ "server.skillRescanIncompleteSuspendHours": "0" }), "kaiju-server")).toBe(
      "0",
    );
    expect(renderError({ "server.skillRescanIncompleteSuspendHours": "-1" })).toMatch(
      /skillRescanIncompleteSuspendHours/,
    );
  });

  it("configures audit forwarding on the server only, and only when enabled (KOBE-19)", () => {
    const envOf = (
      ms2: Manifest[],
      name: string,
    ): { name: string; value?: string; valueFrom?: any }[] =>
      find(ms2, "Deployment", name)?.spec.template.spec.containers[0].env ?? [];
    const audit = (ms2: Manifest[], name: string) =>
      envOf(ms2, name).filter((e) => e.name.startsWith("KAIJU_AUDIT_"));
    expect(audit(ms, "kaiju-server")).toEqual([]);
    const on = render({
      "auditForwarding.syslog.enabled": "true",
      "auditForwarding.syslog.host": "siem.example.test",
      "auditForwarding.otlp.enabled": "true",
      "auditForwarding.otlp.endpoint": "https://otel.example.test:4318/v1/logs",
      "auditForwarding.otlp.headersSecret": "otlp-auth",
    });
    expect(audit(on, "kaiju-server")).toEqual([
      { name: "KAIJU_AUDIT_SYSLOG_URL", value: "tls://siem.example.test:6514" },
      { name: "KAIJU_AUDIT_SYSLOG_ENTERPRISE_NUMBER", value: "32473" },
      { name: "KAIJU_AUDIT_OTLP_URL", value: "https://otel.example.test:4318/v1/logs" },
      {
        name: "KAIJU_AUDIT_OTLP_HEADERS",
        valueFrom: { secretKeyRef: { name: "otlp-auth", key: "headers" } },
      },
    ]);
    expect(audit(on, "kaiju-scheduler")).toEqual([]);
    expect(
      audit(
        render({
          "auditForwarding.syslog.enabled": "true",
          "auditForwarding.syslog.host": "h",
          "auditForwarding.syslog.tls": "false",
          "auditForwarding.syslog.port": "514",
        }),
        "kaiju-server",
      ),
    ).toEqual([
      { name: "KAIJU_AUDIT_SYSLOG_URL", value: "tcp://h:514" },
      { name: "KAIJU_AUDIT_SYSLOG_ENTERPRISE_NUMBER", value: "32473" },
    ]);
    expect(renderError({ "auditForwarding.syslog.enabled": "true" })).toMatch(/syslog.host/);
    expect(renderError({ "auditForwarding.otlp.enabled": "true" })).toMatch(/otlp.endpoint/);
  });

  it("passes the connector refresh interval to the server only (KOBE-102)", () => {
    const env = (ms2: Manifest[], name: string): { name: string; value?: string }[] =>
      find(ms2, "Deployment", name)?.spec.template.spec.containers[0].env ?? [];
    const value = (ms2: Manifest[], name: string) =>
      env(ms2, name).find((e) => e.name === "KAIJU_CONNECTOR_REFRESH_SECONDS")?.value;
    expect(value(ms, "kaiju-server")).toBe("3600");
    expect(value(ms, "kaiju-scheduler")).toBeUndefined();
    expect(value(render({ "server.connectorRefreshSeconds": "0" }), "kaiju-server")).toBe("0");
    expect(renderError({ "server.connectorRefreshSeconds": "-1" })).toMatch(
      /connectorRefreshSeconds/,
    );
  });

  it("passes the session token TTL to the server only, 10..900 s (KOBE-241)", () => {
    const value = (ms2: Manifest[], name: string) =>
      (find(ms2, "Deployment", name)?.spec.template.spec.containers[0].env ?? []).find(
        (e: { name: string }) => e.name === "KAIJU_SESSION_TOKEN_TTL_SECONDS",
      )?.value;
    expect(value(ms, "kaiju-server")).toBe("900");
    expect(value(ms, "kaiju-scheduler")).toBeUndefined();
    expect(value(render({ "server.sessionTokenTtlSeconds": "15" }), "kaiju-server")).toBe("15");
    expect(renderError({ "server.sessionTokenTtlSeconds": "5" })).toMatch(/sessionTokenTtlSeconds/);
    expect(renderError({ "server.sessionTokenTtlSeconds": "901" })).toMatch(
      /sessionTokenTtlSeconds/,
    );
  });

  it("runs the scheduler as the server image in scheduler mode", () => {
    const c = find(ms, "Deployment", "kaiju-scheduler")?.spec.template.spec.containers[0];
    expect(c.image).toBe("ghcr.io/splittingatom/kaiju-server:0.1.0");
    expect(c.env).toContainEqual({ name: "KAIJU_PROCESS", value: "scheduler" });
  });

  it("defaults images to the private registry and the chart appVersion", () => {
    expect(find(ms, "Deployment", "kaiju-web")?.spec.template.spec.containers[0].image).toBe(
      "ghcr.io/splittingatom/kaiju-web:0.1.0",
    );
  });

  it("applies global.imagePullSecrets to every pod (ac-3)", () => {
    for (const { name, spec } of podSpecs(ms)) {
      expect(spec.imagePullSecrets, name).toEqual([{ name: "ghcr-pull" }]);
    }
  });

  it("holds liveness checks until each long-running container has started", () => {
    for (const d of byKind(ms, "Deployment")) {
      for (const c of d.spec.template.spec.containers) {
        const name = `${d.metadata.name}/${c.name}`;
        expect(c.startupProbe?.httpGet, name).toEqual(c.livenessProbe?.httpGet);
        // At least a minute before liveness may restart a slow-starting container.
        expect(
          c.startupProbe.periodSeconds * c.startupProbe.failureThreshold,
          name,
        ).toBeGreaterThanOrEqual(60);
      }
    }
  });

  it("runs every pod non-root with a hardened container security context", () => {
    for (const { name, spec } of podSpecs(ms)) {
      expect(spec.securityContext?.runAsNonRoot, name).toBe(true);
      expect(spec.securityContext?.seccompProfile, name).toEqual({ type: "RuntimeDefault" });
      for (const c of [...spec.containers, ...(spec.initContainers ?? [])]) {
        expect(c.securityContext, `${name}/${c.name}`).toMatchObject({
          allowPrivilegeEscalation: false,
          readOnlyRootFilesystem: true,
          capabilities: { drop: ["ALL"] },
        });
      }
    }
  });
});

describe("isolation preflight (ac-2)", () => {
  const ms = render();
  const hook = (m: Manifest) => m.metadata.annotations?.["helm.sh/hook"];
  const weight = (m: Manifest) => Number(m.metadata.annotations?.["helm.sh/hook-weight"] ?? 0);

  const HOOKS = "pre-install,pre-upgrade,pre-rollback";
  const hooked = (kind: string) => ms.filter((m) => m.kind === kind && hook(m) === HOOKS);

  it("runs as a pre-install/pre-upgrade/pre-rollback hook Job checking the configured class", () => {
    const job = find(ms, "Job", "kaiju-isolation-preflight");
    expect(job && hook(job)).toBe(HOOKS);
    expect(job?.spec.backoffLimit).toBe(0);
    const c = job?.spec.template.spec.containers[0];
    expect(c.command).toEqual(["node", "dist/cli/preflight.js"]);
    expect(c.env).toContainEqual({ name: "KAIJU_RUNTIME_CLASS", value: "gvisor" });
  });

  it("creates its least-privilege RBAC before the Job", () => {
    const job = must(find(ms, "Job", "kaiju-isolation-preflight"), "Job/kaiju-isolation-preflight");
    const role = must(hooked("ClusterRole")[0], "hooked ClusterRole");
    expect(role.rules).toEqual([
      { apiGroups: ["node.k8s.io"], resources: ["runtimeclasses"], verbs: ["get", "list"] },
    ]);
    const binding = must(hooked("ClusterRoleBinding")[0], "hooked ClusterRoleBinding");
    const account = must(hooked("ServiceAccount")[0], "hooked ServiceAccount");
    for (const m of [role, binding, account]) {
      expect(weight(m), m.kind).toBeLessThan(weight(job));
    }
  });

  it("gates the scheduler with a preflight initContainer (Helm flags can't skip it)", () => {
    const spec = find(ms, "Deployment", "kaiju-scheduler")?.spec.template.spec;
    expect(spec.serviceAccountName).toBe("kaiju-server");
    expect(spec.initContainers[0]).toEqual(
      expect.objectContaining({
        name: "isolation-preflight",
        command: ["node", "dist/cli/preflight.js"],
        env: [{ name: "KAIJU_RUNTIME_CLASS", value: "gvisor" }],
      }),
    );
  });

  it("lets the server start and check isolation in process (KOBE-9: admin console shows the fix)", () => {
    const spec = find(ms, "Deployment", "kaiju-server")?.spec.template.spec;
    expect(spec.initContainers.map((c: { name: string }) => c.name)).toEqual([
      "wait-for-migrations",
    ]);
    // The in-process gate lists RuntimeClasses with the server ServiceAccount.
    expect(spec.serviceAccountName).toBe("kaiju-server");
    expect(spec.automountServiceAccountToken).toBe(true);
    const roles = ms.filter((m) => m.kind === "ClusterRole" && hook(m) === undefined);
    expect(roles.map((r) => (r as { rules?: unknown }).rules)).toContainEqual([
      { apiGroups: ["node.k8s.io"], resources: ["runtimeclasses"], verbs: ["get", "list"] },
    ]);
    expect(spec.containers[0].readinessProbe.httpGet.path).toBe("/readyz");
  });

  it("gives the server and scheduler processes the RuntimeClass to verify", () => {
    for (const name of ["kaiju-server", "kaiju-scheduler"]) {
      const env = find(ms, "Deployment", name)?.spec.template.spec.containers[0].env;
      expect(env, name).toContainEqual({ name: "KAIJU_RUNTIME_CLASS", value: "gvisor" });
    }
    const kata = render({ "isolation.runtimeClassName": "kata" });
    const env = find(kata, "Deployment", "kaiju-server")?.spec.template.spec.containers[0].env;
    expect(env).toContainEqual({ name: "KAIJU_RUNTIME_CLASS", value: "kata" });
  });

  it("uses collision-proof cluster-scoped names per release and namespace", () => {
    const clusterNames = (release: string, namespace: string) =>
      render({}, { release, namespace })
        .filter((m) => m.kind.startsWith("ClusterRole"))
        .map((m) => m.metadata.name);
    const a = clusterNames("a-b", "c");
    const b = clusterNames("a", "b-c");
    expect(a.length).toBeGreaterThan(0);
    expect(a.filter((n) => b.includes(n))).toEqual([]);
  });

  it("cannot be disabled (no isolation bypass)", () => {
    expect(renderError({ "isolation.preflight.enabled": "false" })).toMatch(
      /additional properties|preflight/i,
    );
  });

  it("uses the same remediation text as the server's startup check", () => {
    const template = readFileSync(`${CHART_DIR}/templates/_isolation.tpl`, "utf8");
    expect(template).toContain(ISOLATION_REMEDIATION);
  });

  it("uses the same handler pattern as the server's startup check", () => {
    const template = readFileSync(`${CHART_DIR}/templates/_isolation.tpl`, "utf8");
    expect(template).toContain(`regexMatch "${ISOLATION_HANDLER.source}"`);
  });
});

describe("values.schema.json (ac-3)", () => {
  it("rejects unknown keys at every level", () => {
    expect(renderError({ bogus: "1" })).toMatch(/additional properties/i);
    expect(renderError({ "server.bogus": "1" })).toMatch(/additional properties/i);
  });

  it("requires an ingress host when ingress is enabled", () => {
    expect(renderError({}, ["ingress.host"])).toMatch(/host/);
  });

  it("requires external Postgres credentials unless CloudNativePG is bundled", () => {
    expect(renderError({}, ["postgres.external.existingSecret"])).toMatch(/existingSecret/);
    expect(renderError({ "postgres.mode": "sqlite" })).toMatch(/mode/);
  });

  it("requires an external S3 endpoint, bucket and credentials (no bundled S3)", () => {
    expect(renderError({}, ["s3.endpoint"])).toMatch(/endpoint/);
    expect(renderError({}, ["s3.existingSecret"])).toMatch(/existingSecret/);
    expect(renderError({ "minio.enabled": "true" })).toMatch(/additional properties/i);
  });
});

describe("Postgres modes (ac-1)", () => {
  it("external: reads the app connection URL from the provided Secret", () => {
    const ms = render();
    const env = find(ms, "Deployment", "kaiju-server")?.spec.template.spec.containers[0].env;
    expect(env).toContainEqual({
      name: "KAIJU_DATABASE_URL",
      valueFrom: { secretKeyRef: { name: "kaiju-db", key: "app-url" } },
    });
    expect(byKind(ms, "Cluster")).toEqual([]);
  });

  it("cnpg: bundles a CloudNativePG Cluster with a separate non-owner app role", () => {
    const ms = render({ "postgres.mode": "cnpg" });
    const cluster = find(ms, "Cluster", "kaiju-pg");
    expect(cluster?.spec.bootstrap.initdb).toMatchObject({ database: "kaiju", owner: "kobe_owner" });
    expect(cluster?.spec.managed.roles).toEqual([
      expect.objectContaining({
        name: "kobe_app",
        login: true,
        superuser: false,
        bypassrls: false,
        createdb: false,
        createrole: false,
        inRoles: [],
        passwordSecret: { name: "kaiju-db-app" },
      }),
    ]);
    expect(cluster?.spec.imagePullSecrets).toEqual([{ name: "ghcr-pull" }]);
    const env = find(ms, "Deployment", "kaiju-server")?.spec.template.spec.containers[0].env;
    expect(env).toContainEqual({
      name: "KAIJU_DATABASE_URL",
      value: "postgres://kobe_app:$(KAIJU_DB_PASSWORD)@kaiju-pg-rw:5432/kobe",
    });
    expect(find(ms, "Secret", "kaiju-db-app")?.type).toBe("kubernetes.io/basic-auth");
  });
});

describe("ingress", () => {
  it("routes the host through Traefik with cert-manager TLS", () => {
    const ms = render({ "ingress.tls.clusterIssuer": "letsencrypt" });
    const ing = find(ms, "Ingress", "kaiju");
    expect(ing?.spec.ingressClassName).toBe("traefik");
    expect(ing?.metadata.annotations?.["cert-manager.io/cluster-issuer"]).toBe("letsencrypt");
    expect(ing?.spec.tls).toEqual([{ hosts: ["kaiju.example.com"], secretName: "kaiju-tls" }]);
    const paths = ing?.spec.rules[0].http.paths.map((p: any) => [p.path, p.backend.service.name]);
    expect(paths).toEqual([
      ["/v1", "kaiju-server"],
      ["/api/auth", "kaiju-server"],
      ["/", "kaiju-web"],
    ]);
  });
});
