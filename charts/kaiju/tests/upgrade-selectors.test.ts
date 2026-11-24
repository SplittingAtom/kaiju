// KOBE-750 (rename to Kaiju, ac-1): `helm upgrade` of an existing release with unchanged values
// must work after the chart moved from charts/kobe to charts/kaiju. Deployment, StatefulSet and
// DaemonSet selectors are immutable (a changed one fails the upgrade), and objects that hold state
// or are looked up by name (generated Secrets, PVCs, the CloudNativePG cluster, Services, the
// server's ServiceAccount) must keep their names, or the upgrade would recreate them empty.
// The fixture was rendered once from the chart before the rename; never regenerate it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { render, type Manifest } from "./render.test-helpers.js";

type Kept = { selector?: unknown; serviceName?: string; volumeClaimTemplates?: string[] };
const FIXTURE = JSON.parse(
  readFileSync(new URL("./fixtures/pre-rename-upgrade.json", import.meta.url), "utf8"),
) as Record<string, Record<string, Kept> | string>;

/** The same value combinations the fixture was rendered with (release and namespace `kobe`). */
const COMBOS: Record<string, Record<string, string>> = {
  defaults: {},
  cnpg: { "postgres.mode": "cnpg" },
  everything: {
    "clamav.enabled": "true",
    "sandbox.skillScan.enabled": "true",
    "rancher.enabled": "true",
    "ingress.rateLimit.enabled": "true",
    "sandbox.hibernation.reclaim.enabled": "true",
    "server.replicas": "3",
    "web.replicas": "3",
    "mcpProxy.replicas": "3",
    "egressProxy.replicas": "3",
    "modelGateway.replicas": "3",
  },
};

const WORKLOADS = new Set(["Deployment", "StatefulSet", "DaemonSet"]);

function keptOf(m: Manifest): Kept {
  const spec = m.spec ?? {};
  const kept: Kept = {};
  if ((WORKLOADS.has(m.kind) || m.kind === "Service") && spec.selector)
    kept.selector = spec.selector;
  if (m.kind === "StatefulSet") {
    if (spec.serviceName) kept.serviceName = spec.serviceName;
    const vct = (spec.volumeClaimTemplates ?? []).map(
      (v: { metadata: { name: string } }) => v.metadata.name,
    );
    if (vct.length > 0) kept.volumeClaimTemplates = vct;
  }
  return kept;
}

/** Every label selector in a manifest (workload, Service, PDB, NetworkPolicy and its peers). */
function selectorsOf(value: unknown, out: Record<string, string>[] = []): Record<string, string>[] {
  if (Array.isArray(value)) value.forEach((v) => selectorsOf(v, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === "matchLabels" && v && typeof v === "object") out.push(v as Record<string, string>);
      else if (k === "selector" && v && typeof v === "object" && !("matchLabels" in v))
        out.push(v as Record<string, string>);
      else selectorsOf(v, out);
    }
  }
  return out;
}

describe("in-place upgrade of a release installed from the chart before the rename (KOBE-750)", () => {
  for (const [combo, values] of Object.entries(COMBOS)) {
    describe(combo, () => {
      const ms = render(values, { release: "kobe", namespace: "kobe", upgrade: true });
      const byKey = new Map(ms.map((m) => [`${m.kind}/${m.metadata.name}`, m]));
      const before = FIXTURE[combo] as Record<string, Kept>;

      it("keeps every stateful or looked-up object under its name", () => {
        const missing = Object.keys(before).filter((k) => !byKey.has(k));
        expect(missing).toEqual([]);
      });

      it("keeps the immutable selectors, StatefulSet service names and volume claim templates", () => {
        for (const [key, kept] of Object.entries(before)) {
          const m = byKey.get(key);
          if (m) expect(keptOf(m), key).toEqual(kept);
        }
      });

      it("selects the chart's pods by app.kubernetes.io/name=kobe everywhere (team policies too)", () => {
        const names = ms
          .flatMap((m) => selectorsOf(m.spec))
          .map((s) => s["app.kubernetes.io/name"])
          .filter((v): v is string => v !== undefined);
        expect(names.length).toBeGreaterThan(0);
        expect([...new Set(names)]).toEqual(["kobe"]);
      });
    });
  }

  it("labels every workload's pods so its selector still matches", () => {
    for (const m of render(COMBOS.everything ?? {}, { release: "kobe", namespace: "kobe" })) {
      if (!WORKLOADS.has(m.kind)) continue;
      const labels = m.spec?.template?.metadata?.labels ?? {};
      expect(labels, m.metadata.name).toMatchObject(m.spec?.selector?.matchLabels ?? {});
    }
  });
});
