import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AUDIT_CATEGORIES } from "./audit";

/**
 * The Category filter offers exactly the categories the server accepts (KOBE-291 review): the
 * first segment of every action in AUDIT_EVENTS. The web app can't import @kaiju/db, so this reads
 * the source of truth and fails on drift.
 */
function serverCategories(): string[] {
  // KOBE-701: AUDIT_EVENTS spreads one object per area file in packages/db/src/audit/events/.
  const dir = new URL("../../../../../../packages/db/src/audit/events/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  const actions = files.flatMap((file) => {
    const source = readFileSync(new URL(file, dir), "utf8");
    const start = source.search(/^export const [A-Z_]+_EVENTS = \{$/m);
    if (start < 0) return [];
    const block = source.slice(start, source.indexOf("} as const", start));
    return [...block.matchAll(/^ {2}"([a-z_]+(?:\.[a-z_]+)+)":/gm)].map((m) => m[1] ?? "");
  });
  // A parse that finds almost nothing would make the comparison meaningless.
  expect(actions.length).toBeGreaterThan(150);
  return [...new Set(actions.map((a) => a.split(".")[0] ?? a))].sort();
}

describe("audit categories", () => {
  it("match the server's AUDIT_EVENTS exactly", () => {
    expect([...AUDIT_CATEGORIES].sort()).toEqual(serverCategories());
  });

  it("have no duplicates", () => {
    expect(new Set(AUDIT_CATEGORIES).size).toBe(AUDIT_CATEGORIES.length);
  });
});
