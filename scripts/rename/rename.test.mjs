// Self-test of the rename tooling (KOBE-745) on a fixture repository: node --test scripts/rename/
// Covers case handling, permanent names left alone, step ownership, idempotence, the guard's
// unowned and stale findings, and word-boundary traps (kobe.dev/, KOBE-123, x-kobe-team,
// kobe_reserve_budget, the team setting).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  STEPS,
  audit,
  globToRegExp,
  loadAllowlist,
  parseList,
  swapCase,
  trackedFiles,
} from "./lib.mjs";
import { apply, loadStep, report } from "./rename.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));

const ALLOWLIST = `
== permanent: ticket ids
** /\\bKOBE-\\d+/
path ** /KOBE-\\d+/
== permanent: postgres
** /\\bkobe\\.team_id\\b/
** /\\bkobe_reserve_budget\\b/
== permanent: schema ids
** /\\bkobe\\.dev\\/[\\w./-]*/
== RN-3: Generated: lockfile, rewritten by the package manager, left out of the step file
lock.yaml /@kobe\\/[\\w.-]*/
== RN-5: headers
** /\\bx-kobe-[\\w-]+/i
== RN-4: env
** /\\bKOBE_[A-Z0-9_]+/
== RN-3: packages and identifiers
** /@kobe\\/[\\w./-]*/
** /\\b\\w*Kobe[A-Z]\\w*/
path src/** /kobe/i
== RN-2: prose
** /\\bKobe\\b/
`;

// A deliberately broad RN-3 list: ownership and the permanent entries must still hold it back.
const STEP_FILES = {
  "RN-2": "== RN-2: prose\n** /\\bKobe\\b/\n",
  "RN-3": "== RN-3: packages and identifiers\n** /[\\w.@/-]*kobe[\\w.@/-]*/i\npath ** /kobe/i\n",
  "RN-4": "== RN-4: env\n** /\\bKOBE_[A-Z0-9_]+/\n",
  "RN-5": "== RN-5: headers\n** /\\bx-kobe-[\\w-]+/i\n",
};

const FILES = {
  "src/kobe-runtime.ts": [
    'import { db } from "@kobe/db";',
    "export type KobeEvent = { kind: string }; // Kobe sends these",
    "sql`SELECT set_config('kobe.team_id', $1, true)`; // KOBE-123",
    'const h = { "x-kobe-team": t, "X-Kobe-Run-Id": r };',
    "await sql`SELECT kobe_reserve_budget(${t})`;",
    'const apiVersion = "kobe.dev/skill/v1"; const url = process.env.KOBE_PUBLIC_URL;',
  ].join("\n"),
  "docs/KOBE-745.md": "Kobe is renamed in KOBE-745.\n",
  "README.md": "# Kobe\n\nKobe's guide.\n",
  "lock.yaml": "'@kobe/db': link:packages/db\n",
};

let root;

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function write(files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

function commit(message) {
  git(["add", "-A"]);
  git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", message]);
}

const quiet = () => {};
const read = (path) => readFileSync(join(root, path), "utf8");

before(() => {
  root = mkdtempSync(join(tmpdir(), "rename-fixture-"));
  git(["init", "-q"]);
  const steps = Object.fromEntries(
    Object.entries(STEP_FILES).map(([s, t]) => [`scripts/rename/steps/${s}.txt`, t]),
  );
  // The fixture's own tooling files name the old name: a permanent entry covers them.
  write({
    ...FILES,
    ...steps,
    "scripts/rename/allowlist.txt": `== permanent: tooling\nscripts/rename/** /kobe/i\n${ALLOWLIST}`,
  });
  commit("fixture");
});

after(() => rmSync(root, { recursive: true, force: true }));

test("case handling: Kobe -> Kaiju, kobe -> kaiju, KOBE -> KAIJU", () => {
  assert.equal(swapCase("Kobe"), "Kaiju");
  assert.equal(swapCase("kobe"), "kaiju");
  assert.equal(swapCase("KOBE"), "KAIJU");
});

test("globs: **, *, braces, directory prefixes", () => {
  assert.ok(globToRegExp("**").test("a/b/c.ts"));
  assert.ok(globToRegExp("docs/**").test("docs/x.md"));
  assert.ok(globToRegExp("docs/**").test("docs/a/b.md"));
  assert.ok(!globToRegExp("docs/**").test("docsx/a.md"));
  assert.ok(globToRegExp("**/*.test.*").test("a/b.test.ts"));
  assert.ok(globToRegExp("**/*.test.*").test("b.test.ts"));
  assert.ok(globToRegExp("src/*.{ts,tsx}").test("src/a.tsx"));
  assert.ok(!globToRegExp("src/*.ts").test("src/a/b.ts"));
});

test("parse errors name the line", () => {
  assert.throws(() => parseList("** /x/\n"), /entry before the first group header/);
  assert.throws(() => parseList("== RN-3: x\n** nope\n"), /without a \/regex\//);
  assert.throws(() => parseList("== RN-1: x\n"), /bad group header/);
});

test("guard: the fixture allowlist owns every occurrence and has no stale entry", () => {
  const { found, stale } = audit(root, loadAllowlist(root));
  assert.deepEqual(
    found.filter((o) => !o.owner).map((o) => `${o.path}:${o.line}`),
    [],
  );
  assert.deepEqual(
    stale.map((e) => e.text),
    [],
  );
  const owner = (path, token) =>
    found.find((o) => o.path === path && o.unit.text.slice(o.start).startsWith(token))?.owner.step;
  assert.equal(owner("src/kobe-runtime.ts", "kobe.team_id"), "permanent");
  assert.equal(owner("src/kobe-runtime.ts", "kobe-team"), "RN-5");
  assert.equal(owner("src/kobe-runtime.ts", "KOBE_PUBLIC_URL"), "RN-4");
});

test("guard: an unowned occurrence and a stale entry both fail", () => {
  const list = parseList(`${ALLOWLIST}== RN-9: nothing\n** /\\bkobe-gate1\\b/\n`);
  const files = [
    ...trackedFiles(root).filter((f) => !f.path.startsWith("scripts/")),
    { path: "x.sh", read: () => ({ binary: false, text: "helm upgrade kobe charts/kobe" }) },
  ];
  const { found, stale } = audit(root, list, files);
  assert.equal(found.filter((o) => !o.owner).length, 2);
  assert.deepEqual(
    stale.map((e) => e.step),
    ["RN-9"],
  );
});

test("dry run prints files and counts per step and writes nothing", () => {
  const lines = [];
  const { plan } = report(root, "RN-3", { log: (l) => lines.push(l) });
  assert.match(
    lines[0],
    /^RN-3: 2 occurrence\(s\) in 1 file\(s\), 1 path\(s\) renamed; 1 occurrence\(s\) .* left/,
  );
  assert.ok(lines.some((l) => l.includes("src/kobe-runtime.ts -> src/kaiju-runtime.ts")));
  assert.equal(plan.length, 1);
  assert.equal(git(["status", "--porcelain"]), "");
});

test("apply one step: only its own occurrences change, permanent names stay, paths move", () => {
  apply(root, "RN-3", { log: quiet });
  const text = read("src/kaiju-runtime.ts");
  assert.match(text, /from "@kaiju\/db"/);
  assert.match(text, /export type KaijuEvent/);
  // Other steps' names: prose (RN-2), headers (RN-5), environment (RN-4).
  assert.match(text, /\/\/ Kobe sends these/);
  assert.match(text, /"x-kobe-team": t, "X-Kobe-Run-Id": r/);
  assert.match(text, /process\.env\.KOBE_PUBLIC_URL/);
  // Permanent: the team setting, ticket ids, budget function, schema id.
  assert.match(text, /set_config\('kobe\.team_id', \$1, true\)`; \/\/ KOBE-123/);
  assert.match(text, /kobe_reserve_budget\(/);
  assert.match(text, /"kobe\.dev\/skill\/v1"/);
  assert.equal(read("docs/KOBE-745.md"), "Kobe is renamed in KOBE-745.\n");
  // A group of this step that the step file leaves out (generated) is left for hand work.
  assert.equal(read("lock.yaml"), "'@kobe/db': link:packages/db\n");
  assert.match(
    git(["status", "--porcelain"]),
    /R {2}src\/kobe-runtime\.ts -> src\/kaiju-runtime\.ts/,
  );
});

test("a second run of the same step changes nothing (idempotent)", () => {
  commit("RN-3");
  const { plan } = report(root, "RN-3", { summary: true, log: quiet });
  assert.deepEqual(plan, []);
});

test("headers, environment and prose follow in their own steps, keeping case", () => {
  for (const step of ["RN-5", "RN-4", "RN-2"]) {
    apply(root, step, { log: quiet });
    commit(step);
  }
  const text = read("src/kaiju-runtime.ts");
  assert.match(text, /"x-kaiju-team": t, "X-Kaiju-Run-Id": r/);
  assert.match(text, /process\.env\.KAIJU_PUBLIC_URL/);
  assert.match(text, /\/\/ Kaiju sends these/);
  assert.match(text, /kobe\.team_id.*KOBE-123/);
  assert.equal(read("README.md"), "# Kaiju\n\nKaiju's guide.\n");
  assert.equal(read("docs/KOBE-745.md"), "Kaiju is renamed in KOBE-745.\n");
});

test("apply refuses a dirty working tree", () => {
  writeFileSync(join(root, "README.md"), "dirty Kobe\n");
  assert.throws(() => apply(root, "RN-2", { log: quiet }), /not clean/);
  git(["checkout", "--", "README.md"]);
});

test("the repository's lists parse, each step file holds only its own step", () => {
  const allowlist = loadAllowlist(REPO);
  assert.ok(allowlist.groups.every((g) => g.reason.length > 10));
  for (const step of STEPS) {
    const list = loadStep(REPO, step);
    assert.ok(list.groups.every((g) => g.step === step));
    for (const g of list.groups) {
      assert.ok(
        allowlist.groups.some((a) => a.step === step && a.reason === g.reason),
        `${step}: step file group "${g.reason}" repeats an allowlist group header`,
      );
    }
    assert.ok(
      allowlist.groups.some((g) => g.step === step),
      `${step} has allowlist groups`,
    );
  }
});
