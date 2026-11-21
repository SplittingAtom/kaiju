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

const SOURCE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|sql|sh|bash|py)$/;
const TEST_CODE = /(?:\.test\.[a-z]+$|(?:^|\/)(?:testing|test-support|__tests__)\/)/;

/**
 * A team setter: `set_config(` whose first argument is the team setting (by name, the constant, or
 * a positional parameter that could carry it), or `SET [LOCAL|SESSION] kobe.team_id`.
 */
const SETS_TEAM = [
  /set_config\s*\(\s*(?:'kobe\.team_id'|"kobe\.team_id"|\$\{\s*TEAM_ID_SETTING\s*\}|TEAM_ID_SETTING\b|\$\d+\s*[,)])/i,
  /\bSET\s+(?:LOCAL\s+|SESSION\s+)?["']?kobe\.team_id\b/i,
];

function setsTeam(source: string): boolean {
  return SETS_TEAM.some((pattern) => pattern.test(source));
}

/**
 * Files that name the team setting without setting it (beyond reads, plain imports and comments),
 * each with the reason. Any other mention fails: an alias, a copy of the constant or a built-up
 * name could set the team past {@link SETS_TEAM}.
 */
const ALLOWED_MENTIONS: Readonly<Record<string, string>> = {
  "packages/db/src/settings.ts": "defines TEAM_ID_SETTING",
  "packages/telemetry/src/spans.ts": "OpenTelemetry span attribute `kobe.team_id`, not the setting",
  "services/server/src/memory/learn/execute.ts": "OpenTelemetry span attribute, not the setting",
  "packages/db/src/models/secret-box.ts": "HKDF label `kobe.${purpose}`, not the setting",
  "packages/db/src/tenancy/identity.ts": "prose in a table's documented reason",
};

/** Reads of the setting, which every RLS policy and team check does. */
const READ =
  /current_setting\(\s*(?:\$\{\s*TEAM_ID_SETTING\s*\}|'kobe\.team_id'|"kobe\.team_id")/gi;
/** `import { … } from` / `export { … } from` without a rename (`as`). */
const PLAIN_IMPORT = /\b(?:import|export)\s+(?:type\s+)?\{[^}]*\}\s*from\s*["'][^"']+["'];?/g;
const MENTION = [
  /TEAM_ID_SETTING/,
  /kobe\.team_id/i,
  /["'`]kobe\.["'`]\s*(?:\+|\|\|)/i,
  /kobe\.\$\{/i,
];

function withoutComments(file: string, source: string): string {
  if (file.endsWith(".sql")) return source.replace(/--[^\n]*/g, "");
  if (/\.(?:sh|bash|py)$/.test(file)) return source.replace(/^\s*#[^\n]*/gm, "");
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
}

/** Whether `source` names the team setting other than to read it. */
function mentionsTeam(file: string, source: string): boolean {
  const rest = withoutComments(file, source)
    .replace(READ, "")
    .replace(PLAIN_IMPORT, (statement) => (/\bas\b/.test(statement) ? statement : ""));
  return MENTION.some((pattern) => pattern.test(rest));
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
    expect(setsTeam(`SET LOCAL "kobe.team_id" = '1'`)).toBe(true);
    expect(setsTeam(`SET LOCAL 'kobe.team_id' TO '1'`)).toBe(true);
  });

  it("flags any other mention of the team setting: aliases, concatenation, scripts (review)", () => {
    const ts = (src: string) => mentionsTeam("x.ts", src);
    // Aliased or renamed constant.
    expect(
      ts(`import { TEAM_ID_SETTING as T } from "@kobe/db";\nset_config(\${T}, id, true)`),
    ).toBe(true);
    expect(ts("const SETTING = TEAM_ID_SETTING;")).toBe(true);
    // The name as a value anywhere but a read.
    expect(ts(`const name = "kobe.team_id";`)).toBe(true);
    // Concatenated names.
    expect(ts(`const name = "kobe." + "team_id";`)).toBe(true);
    expect(ts("const name = `kobe.${'team_id'}`;")).toBe(true);
    expect(mentionsTeam("x.sql", "SELECT set_config('kobe.' || 'team_id', t, true);")).toBe(true);
    // Shell and Python.
    expect(mentionsTeam("x.sh", `psql -c "SET LOCAL kobe.team_id = '$T'"`)).toBe(true);
    expect(
      mentionsTeam("x.py", `cur.execute("SELECT set_config('kobe.team_id', %s, true)", [t])`),
    ).toBe(true);
    // Not mentions: reads, plain imports and re-exports, comments.
    expect(ts("sql`SELECT NULLIF(current_setting(${TEAM_ID_SETTING}, true), '')`")).toBe(false);
    expect(ts(`import { TEAM_ID_SETTING, withTeam } from "./settings.js";`)).toBe(false);
    expect(ts(`export { TEAM_ID_SETTING } from "./settings.js";`)).toBe(false);
    expect(ts("// the transaction's kobe.team_id\n/* kobe.team_id */")).toBe(false);
    expect(
      mentionsTeam(
        "x.sql",
        "-- bound to kobe.team_id\nUSING (current_setting('kobe.team_id', true))",
      ),
    ).toBe(false);
    expect(mentionsTeam("x.sh", "# sets kobe.team_id? no")).toBe(false);
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

  it("no other file names the team setting except to read it", () => {
    const allowed = { ...ALLOWED_CODE, ...ALLOWED_MIGRATIONS, ...ALLOWED_MENTIONS };
    const mentioning = trackedSources().filter((f) =>
      mentionsTeam(f, readFileSync(`${ROOT}${f}`, "utf8")),
    );
    expect(
      mentioning.filter((f) => !Object.hasOwn(allowed, f)),
      "names kobe.team_id / TEAM_ID_SETTING beyond a read: use withTeam(), or list it with a reason",
    ).toEqual([]);
    expect(Object.keys(ALLOWED_MENTIONS).filter((f) => !mentioning.includes(f))).toEqual([]);
  });

  it("CLAUDE.md lists every accepted exception", () => {
    const claude = readFileSync(`${ROOT}CLAUDE.md`, "utf8");
    for (const file of Object.keys(ALLOWED_CODE)) {
      if (file.endsWith("with-team.ts")) continue;
      expect(claude, file).toContain(`\`${file}\``);
    }
  });
});
