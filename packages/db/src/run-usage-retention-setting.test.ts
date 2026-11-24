import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Who may name `kobe.run_usage_retention` (KOBE-741). The `run_usage` ledger is append-only by
 * trigger; the trigger lets a DELETE of a row older than 90 days through only when this setting is
 * `on` (migration 0239). Only the nightly retention sweep may set it, transaction-locally, inside
 * its own batch transaction. This scans every tracked source, script and migration (tests
 * excluded, like `team-setters.test.ts`) and fails when any other file names the setting, or when
 * the sweep sets it any other way than `set_config('kobe.run_usage_retention', 'on', true)`.
 */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const ALLOWED: Readonly<Record<string, string>> = {
  "services/server/src/retention/table-sweeps.ts": "the sweep: sets it for one batch transaction",
  "packages/db/drizzle/0239_run_usage_retention.sql": "the trigger that reads it",
  "packages/db/src/models/secret-box.ts": "HKDF label `kobe.${purpose}`, not the setting",
};

const SOURCE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|sql|sh|bash|py)$/;
const TEST_CODE = /(?:\.test\.[a-z]+$|(?:^|\/)(?:testing|test-support|__tests__)\/)/;
/** The name, or a built-up form of it. */
const MENTION = [/run_usage_retention/i, /["'`]kaiju\.["'`]\s*(?:\+|\|\|)/i, /kaiju\.\$\{/i];
/** The one accepted way to set it. */
const LOCAL_SET = /set_config\('kaiju\.run_usage_retention', 'on', true\)/g;

function withoutComments(file: string, source: string): string {
  if (file.endsWith(".sql")) return source.replace(/--[^\n]*/g, "");
  if (/\.(?:sh|bash|py)$/.test(file)) return source.replace(/^\s*#[^\n]*/gm, "");
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
}

const mentions = (file: string, source: string): boolean =>
  MENTION.some((p) => p.test(withoutComments(file, source)));

function trackedSources(): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
  return out
    .split("\0")
    .filter((f) => SOURCE.test(f) && !TEST_CODE.test(f) && !f.includes("node_modules/"));
}

describe("kobe.run_usage_retention setters (KOBE-741)", () => {
  it("recognises the name and built-up forms, not comments", () => {
    expect(mentions("x.ts", "sql`SELECT set_config('kobe.run_usage_retention', 'on', true)`")).toBe(
      true,
    );
    expect(mentions("x.ts", `const n = "kaiju." + "run_usage_retention";`)).toBe(true);
    expect(mentions("x.sql", "SET LOCAL kobe.run_usage_retention = on;")).toBe(true);
    expect(mentions("x.ts", "// kobe.run_usage_retention")).toBe(false);
    expect(mentions("x.sql", "-- kobe.run_usage_retention")).toBe(false);
  });

  it("only the sweep and its migration name it", () => {
    const files = trackedSources();
    expect(files.length).toBeGreaterThan(500);
    const named = files.filter((f) => mentions(f, readFileSync(`${ROOT}${f}`, "utf8")));
    expect(named.filter((f) => !Object.hasOwn(ALLOWED, f))).toEqual([]);
  });

  it("the sweep sets it only transaction-locally, and never otherwise", () => {
    const file = "services/server/src/retention/table-sweeps.ts";
    const code = withoutComments(file, readFileSync(`${ROOT}${file}`, "utf8"));
    expect(code.match(LOCAL_SET)?.length).toBe(1);
    expect(MENTION.some((p) => p.test(code.replace(LOCAL_SET, "")))).toBe(false);
  });
});
