import { describe, expect, it } from "vitest";
import { podSpecs, render } from "./render.test-helpers.js";

// KOBE-836: no chart pod gets Kubernetes service-link variables. Nothing reads them (services
// reach each other by DNS name from explicit KAIJU_* settings, and the in-cluster API client uses
// KUBERNETES_SERVICE_*, which Kubernetes injects regardless), and Services named <release>-*
// would otherwise inject names like KAIJU_CLAMAV_PORT=tcp://... that look like product settings.
// The server sets the same on the sandbox, eval and scan pods it creates.
describe("service links (KOBE-836)", () => {
  it.each([
    ["defaults", {}],
    [
      "optional parts on",
      {
        "clamav.enabled": "true",
        "sandbox.skillScan.enabled": "true",
        "postgres.mode": "cnpg",
      },
    ],
  ])("every pod sets enableServiceLinks: false (%s)", (_label, values: Record<string, string>) => {
    const pods = podSpecs(render(values));
    expect(pods.length).toBeGreaterThan(5);
    expect(pods.filter((p) => p.spec.enableServiceLinks !== false).map((p) => p.name)).toEqual([]);
  });

  it("covers the workloads outside the shared Deployment template", () => {
    const names = podSpecs(render({ "clamav.enabled": "true" })).map((p) => p.name);
    for (const part of ["clamav", "bifrost", "embeddings", "isolation-preflight", "migrate"]) {
      expect(names.some((n) => n.includes(part))).toBe(true);
    }
  });
});
