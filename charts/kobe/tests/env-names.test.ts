import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHART_DIR, render, type Manifest } from "./render.test-helpers.js";

// KOBE-748 (rename step RN-4): the chart sets only KAIJU_* names. The services still read an old
// KOBE_* name for one release (an operator's extraEnv or Secret), but the chart never writes one.
const OLD = /\bKOBE_[A-Z0-9_]+/g;

function chartFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return ["node_modules", "tests"].includes(e.name) ? [] : chartFiles(path);
    return [path];
  });
}

type Container = { name: string; env?: { name: string }[] };

function envNames(ms: Manifest[]): string[] {
  const names = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(visit);
    else if (node !== null && typeof node === "object") {
      const c = node as Partial<Container>;
      if (typeof c.name === "string" && Array.isArray(c.env)) {
        for (const e of c.env) names.add(e.name);
      }
      Object.values(node).forEach(visit);
    }
  };
  visit(ms);
  return [...names].sort();
}

describe("environment variable names (KOBE-748)", () => {
  it("no template, values file or schema names an old KOBE_* variable", () => {
    const hits = chartFiles(CHART_DIR).flatMap((path) =>
      [...readFileSync(path, "latin1").matchAll(OLD)].map((m) => `${path}: ${m[0]}`),
    );
    expect(hits).toEqual([]);
  });

  it.each([
    ["defaults", {}],
    [
      "optional parts on",
      {
        "postgres.mode": "cnpg",
        "telemetry.endpoint": "http://otel:4318",
        "clamav.enabled": "true",
      },
    ],
  ])("renders only KAIJU_* product variables (%s)", (_label, values: Record<string, string>) => {
    const ms = render(values);
    expect(JSON.stringify(ms).match(OLD)).toBeNull();
    const names = envNames(ms);
    expect(names.filter((n) => n.startsWith("KAIJU_")).length).toBeGreaterThan(50);
    expect(names.filter((n) => /^KOBE/i.test(n))).toEqual([]);
  });
});
