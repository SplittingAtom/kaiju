import { describe, expect, it } from "vitest";
import { type Manifest, render, renderError, find, podSpecs } from "./render.test-helpers.js";

describe("migrations (KOBE-68)", () => {
  const hook = (m: Manifest | undefined) => m?.metadata.annotations?.["helm.sh/hook"];
  const weight = (m: Manifest | undefined) =>
    Number(m?.metadata.annotations?.["helm.sh/hook-weight"]);
  const migrateEnv = (ms: Manifest[]) =>
    find(ms, "Job", "kobe-migrate")?.spec.template.spec.containers[0].env as unknown[];

  it("external: migrates as the owner in a pre-install/pre-upgrade hook after the isolation preflight", () => {
    const ms = render();
    const job = find(ms, "Job", "kobe-migrate");
    expect(hook(job)).toBe("pre-install,pre-upgrade");
    expect(weight(job)).toBeGreaterThan(weight(find(ms, "Job", "kobe-isolation-preflight")));
    expect(job?.spec.backoffLimit).toBe(0);
    // KOBE-734: concurrent index builds need room; the runner cancels its work on SIGTERM.
    expect(job?.spec.activeDeadlineSeconds).toBe(1800);
    expect(job?.spec.template.spec.terminationGracePeriodSeconds).toBe(30);
    const c = job?.spec.template.spec.containers[0];
    expect(c.image).toBe("ghcr.io/splittingatom/kobe-server:0.1.0");
    expect(c.command).toEqual(["node", "node_modules/@kaiju/db/dist/cli/migrate.js"]);
    expect(migrateEnv(ms)).toEqual(
      expect.arrayContaining([
        {
          name: "KOBE_DB_MIGRATE_URL",
          valueFrom: { secretKeyRef: { name: "kobe-db", key: "migrate-url" } },
        },
        { name: "KOBE_DB_APP_ROLE", value: "kobe_app" },
      ]),
    );
    expect(job?.spec.template.spec.automountServiceAccountToken).toBe(false);
  });

  it("takes the migration Job deadline from postgres.migrateJob (KOBE-734)", () => {
    const job = find(
      render({ "postgres.migrateJob.activeDeadlineSeconds": "7200" }),
      "Job",
      "kobe-migrate",
    );
    expect(job?.spec.activeDeadlineSeconds).toBe(7200);
    expect(
      find(render({ "postgres.migrateJob": "null" }), "Job", "kobe-migrate")?.spec
        .activeDeadlineSeconds,
    ).toBe(1800);
    expect(renderError({ "postgres.migrateJob.activeDeadlineSeconds": "60" })).toMatch(
      /minimum|300/,
    );
  });

  it("defaults keys added after a release so `helm upgrade --reuse-values` keeps working", () => {
    expect(migrateEnv(render({ "postgres.external.appRole": "null" }))).toContainEqual({
      name: "KOBE_DB_APP_ROLE",
      value: "kobe_app",
    });
  });

  it("cnpg first install: migrates in an ordinary Job (post-install hooks would deadlock --wait)", () => {
    const ms = render({ "postgres.mode": "cnpg" });
    const initial = find(ms, "Job", "kobe-migrate-initial");
    expect(initial).toBeDefined();
    expect(hook(initial)).toBeUndefined();
    expect(find(ms, "Job", "kobe-migrate")).toBeUndefined();
    expect(initial?.spec.template.spec.containers[0].env).toContainEqual({
      name: "KOBE_DB_MIGRATE_URL",
      valueFrom: { secretKeyRef: { name: "kobe-pg-app", key: "uri" } },
    });
  });

  it("cnpg upgrade: migrates in a pre-upgrade hook before new pods roll", () => {
    const ms = render({ "postgres.mode": "cnpg" }, { upgrade: true });
    expect(hook(find(ms, "Job", "kobe-migrate"))).toBe("pre-upgrade");
    expect(find(ms, "Job", "kobe-migrate-initial")).toBeUndefined();
  });

  it("pre-install hook pods only use ServiceAccounts that exist before the release is applied", () => {
    const ms = render();
    const hookSAs = new Set(
      ms
        .filter((m) => m.kind === "ServiceAccount" && hook(m)?.includes("pre-install"))
        .map((m) => m.metadata.name),
    );
    for (const job of ms.filter((m) => m.kind === "Job" && hook(m)?.includes("pre-install"))) {
      const sa = job.spec.template.spec.serviceAccountName;
      expect(
        sa === undefined || sa === "default" || hookSAs.has(sa),
        `${job.metadata.name} uses ${sa}`,
      ).toBe(true);
    }
  });

  it("mounts owner credentials only in the migration Job", () => {
    for (const values of [{}, { "postgres.mode": "cnpg" }]) {
      const ms = render(values);
      const owners = podSpecs(ms)
        .filter(({ spec }) =>
          JSON.stringify(spec).match(/"key":"migrate-url"|"name":"kobe-pg-app"/),
        )
        .map(({ name }) => name);
      expect(owners).toHaveLength(1);
      expect(owners[0]).toMatch(/^Job\/kobe-migrate(-initial)?$/);
    }
  });

  it("holds server and scheduler pods until this build's migrations are applied (app role)", () => {
    const ms = render();
    for (const name of ["kobe-server", "kobe-scheduler"]) {
      const wait = find(ms, "Deployment", name)?.spec.template.spec.initContainers.find(
        (c: { name: string }) => c.name === "wait-for-migrations",
      );
      expect(wait?.name, name).toBe("wait-for-migrations");
      expect(wait?.command).toEqual(["node", "node_modules/@kaiju/db/dist/cli/wait.js"]);
      expect(wait?.env).toContainEqual({
        name: "KOBE_DATABASE_URL",
        valueFrom: { secretKeyRef: { name: "kobe-db", key: "app-url" } },
      });
    }
  });
});

describe("least privilege between components", () => {
  it("gives mcp-proxy no database credentials (it sits at the sandbox boundary)", () => {
    const env =
      find(render(), "Deployment", "kobe-mcp-proxy")?.spec.template.spec.containers[0].env ?? [];
    expect(env.map((e: { name: string }) => e.name)).not.toContain("KOBE_DATABASE_URL");
  });

  it("refuses an app connection URL key equal to the owner/migration key", () => {
    expect(renderError({ "postgres.external.appUrlKey": "migrate-url" })).toMatch(/owner/);
  });

  it("keeps a server replica available during voluntary disruptions", () => {
    expect(find(render(), "PodDisruptionBudget", "kobe-server")?.spec).toMatchObject({
      minAvailable: 1,
    });
  });
});

describe("network policies", () => {
  const ms = render({ "postgres.mode": "cnpg", "clamav.enabled": "true" });
  const policy = (name: string) => find(ms, "NetworkPolicy", name);

  it("lets only the server reach ClamAV, on the clamd port (Bifrost: tests/models.test.ts)", () => {
    expect(policy("kobe-clamav")?.spec.policyTypes).toEqual(["Ingress"]);
    expect(policy("kobe-clamav")?.spec.ingress).toEqual([
      {
        from: [
          {
            podSelector: {
              matchLabels: {
                "app.kubernetes.io/name": "kobe",
                "app.kubernetes.io/instance": "kobe",
                "app.kubernetes.io/component": "server",
              },
            },
          },
        ],
        ports: [{ protocol: "TCP", port: 3310 }],
      },
    ]);
  });

  it("lets only the database users, the instances and the CloudNativePG operator reach Postgres (KOBE-699)", () => {
    expect(policy("kobe-pg")?.spec.podSelector).toEqual({
      matchLabels: { "cnpg.io/cluster": "kobe-pg" },
    });
    expect(policy("kobe-pg")?.spec.ingress).toEqual([
      {
        from: [
          {
            podSelector: {
              matchLabels: {
                "app.kubernetes.io/name": "kobe",
                "app.kubernetes.io/instance": "kobe",
              },
              matchExpressions: [
                {
                  key: "app.kubernetes.io/component",
                  operator: "In",
                  values: ["server", "scheduler", "egress-proxy", "model-gateway", "migrate"],
                },
              ],
            },
          },
        ],
        ports: [{ protocol: "TCP", port: 5432 }],
      },
      { from: [{ podSelector: { matchLabels: { "cnpg.io/cluster": "kobe-pg" } } }] },
      {
        from: [
          { namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "cnpg-system" } } },
        ],
      },
    ]);
  });

  it("admits exactly the pods that hold database credentials, and the migrate Job (KOBE-699)", () => {
    const usesDb = (spec: any) =>
      [...(spec.initContainers ?? []), ...spec.containers].some((c: any) =>
        (c.env ?? []).some((e: { name: string }) =>
          /^KOBE_(DATABASE_URL|DB_MIGRATE_URL)$/.test(e.name),
        ),
      );
    const pods = ms
      .filter((m) => m.kind === "Deployment" || m.kind === "Job")
      .map((m) => ({ labels: m.spec.template.metadata.labels, spec: m.spec.template.spec }));
    const admitted = policy("kobe-pg")?.spec.ingress[0].from[0].podSelector;
    const matches = (labels: Record<string, string>) =>
      Object.entries(admitted.matchLabels).every(([k, v]) => labels[k] === v) &&
      admitted.matchExpressions.every((e: any) => e.values.includes(labels[e.key]));
    const dbPods = pods
      .filter((p) => usesDb(p.spec))
      .map((p) => p.labels["app.kubernetes.io/component"]);
    expect(dbPods).toEqual(expect.arrayContaining(["server", "scheduler", "migrate"]));
    for (const p of pods) {
      expect([p.labels["app.kubernetes.io/component"], matches(p.labels)]).toEqual([
        p.labels["app.kubernetes.io/component"],
        usesDb(p.spec),
      ]);
    }
  });

  it("gives ClamAV egress to DNS and public addresses only (signature updates, KOBE-699)", () => {
    const clamav = policy("kobe-clamav-egress")?.spec;
    expect(clamav.podSelector.matchLabels["app.kubernetes.io/component"]).toBe("clamav");
    expect(clamav.policyTypes).toEqual(["Egress"]);
    expect(clamav.egress[0].to[0].podSelector).toEqual({ matchLabels: { "k8s-app": "kube-dns" } });
    expect(clamav.egress[1].to[0].ipBlock.cidr).toBe("0.0.0.0/0");
    expect(clamav.egress[1].to[0].ipBlock.except).toContain("10.0.0.0/8");
    expect(clamav.egress[1].ports).toEqual([
      { protocol: "TCP", port: 443 },
      { protocol: "TCP", port: 80 },
    ]);
    expect(clamav.egress).toHaveLength(2);
    const mirror = {
      to: [{ ipBlock: { cidr: "10.9.8.7/32" } }],
      ports: [{ protocol: "TCP", port: 8080 }],
    };
    const withMirror = render({
      "clamav.enabled": "true",
      "clamav.networkPolicy.extraEgress[0].to[0].ipBlock.cidr": "10.9.8.7/32",
      "clamav.networkPolicy.extraEgress[0].ports[0].protocol": "TCP",
      "clamav.networkPolicy.extraEgress[0].ports[0].port": "8080",
    });
    expect(find(withMirror, "NetworkPolicy", "kobe-clamav-egress")?.spec.egress[2]).toEqual(mirror);
    expect(find(render(), "NetworkPolicy", "kobe-clamav-egress")).toBeUndefined();
  });
});

describe("CloudNativePG app credentials", () => {
  it("rolls pods when the generated app password changes", () => {
    const ms = render({ "postgres.mode": "cnpg" });
    const annotations =
      find(ms, "Deployment", "kobe-server")?.spec.template.metadata.annotations ?? {};
    expect(annotations["checksum/db-app"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("uses a pre-created app Secret instead of generating one (GitOps-safe)", () => {
    const ms = render({
      "postgres.mode": "cnpg",
      "postgres.cnpg.existingAppSecret": "my-app-login",
    });
    expect(find(ms, "Secret", "kobe-db-app")).toBeUndefined();
    expect(find(ms, "Cluster", "kobe-pg")?.spec.managed.roles[0].passwordSecret).toEqual({
      name: "my-app-login",
    });
    const env = find(ms, "Deployment", "kobe-server")?.spec.template.spec.containers[0].env;
    expect(env).toContainEqual({
      name: "KOBE_DB_PASSWORD",
      valueFrom: { secretKeyRef: { name: "my-app-login", key: "password" } },
    });
  });
});
