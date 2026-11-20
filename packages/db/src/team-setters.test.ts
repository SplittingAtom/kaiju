import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Who may set `kobe.team_id` (CLAUDE.md non-negotiables, KOBE-697). `withTeam()` is the rule; every
 * other setter is an accepted exception listed in CLAUDE.md with the invariants it keeps. This scans
 * every tracked source and migration and fails when a file outside the allowlist sets the team.
 * Test code (`*.test.*`, `testing/`, `test-support/`) is not scanned: probes set the team on purpose.
 */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Application code allowed to set the team, each with the reason it is allowed. */
const ALLOWED_CODE: Readonly<Record<string, string>> = {
  "packages/db/src/with-team.ts": "the rule itself",
  "packages/db/src/team-scan.ts": "scanTeams: accepted exception (KOBE-697)",
  "packages/db/src/break-glass/portable-read.ts":
    "Site break-glass Workspace lookup: accepted exception (KOBE-697)",
  "services/server/src/event-stream/read.ts":
    "event-stream reader, one round trip: accepted exception (KOBE-697)",
};

/** Migrations allowed to set the team. */
const ALLOWED_MIGRATIONS: Readonly<Record<string, string>> = {
  "packages/db/drizzle/0047_budgets_rls.sql":
    "one-off backfill of spend recorded before KOBE-42, team by team, at migration time",
  "packages/db/drizzle/0085_budget_reservation_fns.sql": "budget functions (KOBE-120)",
  "packages/db/drizzle/0091_site_rename.sql": "budget functions re-created (KOBE-120)",
  "packages/db/drizzle/0097_budget_reserve_reads_spend.sql": "budget functions (KOBE-120)",
  "packages/db/drizzle/0148_eval_cap_reserve.sql": "budget functions (KOBE-120)",
  "packages/db/drizzle/0152_reserve_full_holds.sql": "budget functions (KOBE-120)",
};

const SOURCE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|sql)$/;
const TEST_CODE = /(?:\.test\.[a-z]+$|(?:^|\/)(?:testing|test-support|__tests__)\/)/;

/**
 * A team setter: `set_config(` whose first argument is the team setting (by name, the constant, or
 * a positional parameter that could carry it), or `SET [LOCAL|SESSION] kobe.team_id`.
 */
const SETS_TEAM = [
  /set_config\s*\(\s*(?:'kobe\.team_id'|"kobe\.team_id"|\$\{\s*TEAM_ID_SETTING\s*\}|TEAM_ID_SETTING\b|\$\d+\s*[,)])/i,
  /\bSET\s+(?:LOCAL\s+|SESSION\s+)?kobe\.team_id\b/i,
];

function setsTeam(source: string): boolean {
  return SETS_TEAM.some((pattern) => pattern.test(source));
}

function trackedSources(): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
  return out
    .split("\0")
    .filter((f) => SOURCE.test(f) && !TEST_CODE.test(f) && !f.includes("node_modules/"));
}

describe("team setters (KOBE-697)", () => {
  it("recognises every form of setting the team, and not other settings", () => {
    expect(setsTeam("sql`SELECT set_config(${TEAM_ID_SETTING}, ${id}, true)`")).toBe(true);
    expect(setsTeam("SELECT set_config('kobe.team_id', '00000000', true)")).toBe(true);
    expect(setsTeam("PERFORM set_config('kobe.team_id', p_team::text, true);")).toBe(true);
    expect(setsTeam("SET LOCAL kobe.team_id = '1'")).toBe(true);
    expect(setsTeam("set kobe.team_id to '1'")).toBe(true);
    expect(setsTeam("client.query('SELECT set_config($1, $2, true)', [TEAM, id])")).toBe(true);
    expect(setsTeam("SELECT set_config('lock_timeout', '5s', true)")).toBe(false);
    expect(setsTeam("set_config(${BREAK_GLASS_GRANT_SETTING}, ${id}, true)")).toBe(false);
    expect(setsTeam("NULLIF(current_setting('kobe.team_id', true), '')::uuid")).toBe(false);
  });

  it("only allowlisted files set kobe.team_id", () => {
    const files = trackedSources();
    expect(files.length).toBeGreaterThan(500);
    const setters = files.filter((f) => setsTeam(readFileSync(`${ROOT}${f}`, "utf8")));
    const allowed = { ...ALLOWED_CODE, ...ALLOWED_MIGRATIONS };
    expect(
      setters.filter((f) => !Object.hasOwn(allowed, f)),
      "a new team setter: use withTeam(), or get it accepted and listed in CLAUDE.md",
    ).toEqual([]);
    // A stale allowlist entry hides nothing today but would let a later change through unseen.
    expect(Object.keys(allowed).filter((f) => !setters.includes(f))).toEqual([]);
  });

  it("CLAUDE.md lists every accepted exception", () => {
    const claude = readFileSync(`${ROOT}CLAUDE.md`, "utf8");
    for (const file of Object.keys(ALLOWED_CODE)) {
      if (file.endsWith("with-team.ts")) continue;
      expect(claude, file).toContain(`\`${file}\``);
    }
  });
});
