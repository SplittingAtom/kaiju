// Self-test of the rename tooling (KOBE-745): node --test scripts/rename/rename.test.mjs
// On fixture repositories: case handling, permanent names left alone in contents and paths, step
// ownership and order, idempotence, the guard's unowned and stale findings, word-boundary traps
// (kobe.dev/, KOBE-123, x-kobe-team, kobe_reserve_budget, the team setting), binary files never
// rewritten, all-or-nothing apply, path renames whose references belong to another step.
// On the repository's real allowlist and step files: owners of sample lines from review round 1.
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
  selects,
  splitValues,
  stepProgress,
  swapUnit,
  globToRegExp,
  loadAllowlist,
  parseList,
  swapCase,
  trackedFiles,
} from "./lib.mjs";
import { apply, earlierSteps, loadStep, report } from "./rename.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));

const ALLOWLIST = `
== permanent: ticket ids
** /\\bKOBE-\\d+/
== permanent: applied migrations
migrations/** /kobe/i
== permanent: postgres
** /\\bkobe\\.team_id\\b/
** /\\bkobe_reserve_budget\\b/
== permanent: schema ids
** /\\bkobe\\.dev\\/[\\w./-]*/
== provisional: (Q1) manifest file name
** /\\bkobe\\.skill\\.yaml\\b/i
== RN-5: headers
** /\\bx-kobe-[\\w-]+/i
== RN-4: env
** /\\bKOBE_[A-Z0-9_]+/
== RN-3: Generated: lockfile, rewritten by the package manager, left out of the step file
lock.yaml /@kobe\\/[\\w.-]*/
== RN-3: packages and identifiers
** /@kobe\\/[\\w./-]*/
** /\\b\\w*Kobe[A-Z]\\w*/
path ** /kobe/i
== RN-2: prose
** /\\bKobe\\b/
`;

// A deliberately broad RN-3 list: ownership and the kept entries must still hold it back.
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
  "migrations/0137_kobe_published_skills.sql": "-- kobe published skills\n",
  "skills/guide/kobe.skill.yaml": "name: guide\n",
};

const roots = [];

function git(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

function write(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

function commit(dir, message) {
  git(dir, ["add", "-A"]);
  git(dir, ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", message]);
}

/** A fixture repository; the tooling files name the old name, so a permanent entry covers them. */
function makeRepo(files, allowlist, steps) {
  const dir = mkdtempSync(join(tmpdir(), "rename-fixture-"));
  roots.push(dir);
  git(dir, ["init", "-q"]);
  write(dir, {
    ...files,
    ...Object.fromEntries(
      Object.entries(steps).map(([s, t]) => [`scripts/rename/steps/${s}.txt`, t]),
    ),
    "scripts/rename/allowlist.txt": `== permanent: tooling\nscripts/rename/** /kobe/i\n${allowlist}`,
  });
  commit(dir, "fixture");
  return dir;
}

/** What a step's ticket does after applying: drops the step's groups from the allowlist. */
function finish(dir, step) {
  const path = join(dir, "scripts/rename/allowlist.txt");
  let skipping = false;
  const kept = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => {
      if (line.startsWith("==")) skipping = line.startsWith(`== ${step}:`);
      return !skipping;
    });
  writeFileSync(path, kept.join("\n"));
  commit(dir, `${step} done`);
}

const quiet = () => {};
let root;
const read = (path) => readFileSync(join(root, path), "utf8");
const status = (dir) => git(dir, ["status", "--porcelain"]);

before(() => {
  root = makeRepo(FILES, ALLOWLIST, STEP_FILES);
});

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

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

test("parse errors name the line; kept groups come first", () => {
  assert.throws(() => parseList("** /x/\n"), /entry before the first group header/);
  assert.throws(() => parseList("== RN-3: x\n** nope\n"), /without a \/regex\//);
  assert.throws(() => parseList("== RN-1: x\n"), /bad group header/);
  const dir = makeRepo({}, "== RN-3: a\n** /x/\n== provisional: (Q1) b\n** /y/\n", {});
  assert.throws(() => loadAllowlist(dir), /permanent groups come first/);
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
  // Kept content entries own the same name in paths (review C1, C2).
  const path = (p) => found.find((o) => o.path === p && o.kind === "path")?.owner.step;
  assert.equal(path("migrations/0137_kobe_published_skills.sql"), "permanent");
  assert.equal(path("skills/guide/kobe.skill.yaml"), "provisional");
  assert.equal(path("docs/KOBE-745.md"), "permanent");
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
  assert.equal(status(root), "");
});

test("steps run in order: RN-3 is refused while RN-2's groups remain (review M2)", () => {
  assert.deepEqual(earlierSteps(loadAllowlist(root), "RN-3"), ["RN-2"]);
  assert.throws(() => apply(root, "RN-3", { log: quiet }), /earlier step\(s\) RN-2/);
  assert.equal(status(root), "");
  assert.equal(read("README.md"), "# Kobe\n\nKobe's guide.\n");
});

test("RN-2 renames prose only", () => {
  apply(root, "RN-2", { log: quiet });
  commit(root, "RN-2");
  assert.equal(read("README.md"), "# Kaiju\n\nKaiju's guide.\n");
  assert.equal(read("docs/KOBE-745.md"), "Kaiju is renamed in KOBE-745.\n");
  assert.match(read("src/kobe-runtime.ts"), /\/\/ Kaiju sends these/);
  finish(root, "RN-2");
});

test("RN-3: only its own occurrences change; kept names stay in contents and paths", () => {
  apply(root, "RN-3", { log: quiet });
  const text = read("src/kaiju-runtime.ts");
  assert.match(text, /from "@kaiju\/db"/);
  assert.match(text, /export type KaijuEvent/);
  // Later steps' names: headers (RN-5), environment (RN-4).
  assert.match(text, /"x-kobe-team": t, "X-Kobe-Run-Id": r/);
  assert.match(text, /process\.env\.KOBE_PUBLIC_URL/);
  // Permanent: the team setting, ticket ids, budget function, schema id.
  assert.match(text, /set_config\('kobe\.team_id', \$1, true\)`; \/\/ KOBE-123/);
  assert.match(text, /kobe_reserve_budget\(/);
  assert.match(text, /"kobe\.dev\/skill\/v1"/);
  // Kept paths are not moved even though the step's path pattern matches them (review C1, C2).
  assert.equal(read("migrations/0137_kobe_published_skills.sql"), "-- kobe published skills\n");
  assert.equal(read("skills/guide/kobe.skill.yaml"), "name: guide\n");
  // A group of this step that the step file leaves out (generated) is left for hand work.
  assert.equal(read("lock.yaml"), "'@kobe/db': link:packages/db\n");
  assert.match(status(root), /R {2}src\/kobe-runtime\.ts -> src\/kaiju-runtime\.ts/);
  commit(root, "RN-3");
});

test("a second run of the same step changes nothing (idempotent)", () => {
  const { plan } = report(root, "RN-3", { summary: true, log: quiet });
  assert.deepEqual(plan, []);
  finish(root, "RN-3");
});

test("environment and headers follow in their own steps, keeping case", () => {
  for (const step of ["RN-4", "RN-5"]) {
    apply(root, step, { log: quiet });
    commit(root, step);
    finish(root, step);
  }
  const text = read("src/kaiju-runtime.ts");
  assert.match(text, /"x-kaiju-team": t, "X-Kaiju-Run-Id": r/);
  assert.match(text, /process\.env\.KAIJU_PUBLIC_URL/);
  assert.match(text, /kobe\.team_id.*KOBE-123/);
});

test("apply refuses a dirty working tree", () => {
  const dir = makeRepo({ "a.md": "Kobe\n" }, "== RN-2: prose\n** /\\bKobe\\b/\n", {
    "RN-2": "== RN-2: prose\n** /\\bKobe\\b/\n",
  });
  writeFileSync(join(dir, "a.md"), "dirty Kobe\n");
  assert.throws(() => apply(dir, "RN-2", { log: quiet }), /not clean/);
  assert.equal(readFileSync(join(dir, "a.md"), "utf8"), "dirty Kobe\n");
});

test("binary files are never rewritten (review M3)", () => {
  const bytes = Buffer.from([0, 0x6b, 0x6f, 0x62, 0x65, 0xe9, 0xff]);
  const dir = makeRepo({ "img.bin": bytes, "a.ts": "KobeX\n" }, "== RN-3: all\n** /kobe/i\n", {
    "RN-3": "== RN-3: all\n** /kobe/i\n",
  });
  const lines = [];
  report(dir, "RN-3", { summary: true, log: (l) => lines.push(l) });
  assert.ok(lines.some((l) => /REFUSED img\.bin/.test(l)));
  assert.throws(() => apply(dir, "RN-3", { log: quiet }), /img\.bin: binary/);
  assert.ok(readFileSync(join(dir, "img.bin")).equals(bytes));
  assert.equal(readFileSync(join(dir, "a.ts"), "utf8"), "KobeX\n");
});

test("apply is all or nothing: a failure while moving rolls everything back (review M1)", () => {
  // `src/kaiju` is a tracked file, so moving src/kobe/a.ts to src/kaiju/a.ts fails half-way.
  const files = { "src/kobe/a.ts": "x\n", "src/kaiju": "a file\n", "b.ts": "KobeX\n" };
  const dir = makeRepo(files, "== RN-3: all\n** /kobe/i\npath ** /kobe/i\n", {
    "RN-3": "== RN-3: all\n** /kobe/i\npath ** /kobe/i\n",
  });
  assert.throws(() => apply(dir, "RN-3", { log: quiet }), /rolled back to HEAD/);
  assert.equal(status(dir), "");
  assert.equal(readFileSync(join(dir, "b.ts"), "utf8"), "KobeX\n");
  assert.equal(readFileSync(join(dir, "src/kobe/a.ts"), "utf8"), "x\n");
});

test("apply refuses a target that already exists, before writing anything", () => {
  const files = { "kobe-a.ts": "x\n", "kaiju-a.ts": "y\n", "b.ts": "KobeX\n" };
  const dir = makeRepo(files, "== RN-3: all\n** /kobe/i\npath ** /kobe/i\n", {
    "RN-3": "== RN-3: all\n** /kobe/i\npath ** /kobe/i\n",
  });
  assert.throws(() => apply(dir, "RN-3", { log: quiet }), /target exists or collides/);
  assert.equal(readFileSync(join(dir, "b.ts"), "utf8"), "KobeX\n");
});

test("a path rename whose references belong to a later step is refused (review H4)", () => {
  const files = {
    "images/kobe-runas.c": "int main;\n",
    "images/Dockerfile": "COPY images/kobe-runas.c /opt/kobe/bin/\n",
  };
  const allow =
    "== RN-6: image paths\nimages/Dockerfile /[\\w/.-]*kobe[\\w.-]*/\n== RN-3: paths\npath ** /kobe/i\n";
  const dir = makeRepo(files, allow, { "RN-3": "== RN-3: paths\npath ** /kobe/i\n" });
  const { conflicts } = report(dir, "RN-3", { summary: true, log: quiet });
  assert.equal(conflicts.filter((c) => c.blocking).length, 1);
  assert.equal(conflicts[0].at, "images/Dockerfile:1");
  assert.throws(() => apply(dir, "RN-3", { log: quiet }), /reference\(s\) to renamed paths/);
  assert.equal(status(dir), "");
});

test("step progress: a step with no allowlist groups is done, and done steps come first", () => {
  const groups = (...steps) => steps.map((step) => ({ step, reason: "r" }));
  const open = STEPS.slice(1);
  assert.deepEqual(stepProgress(groups("permanent", ...STEPS)), { done: [], outOfOrder: [] });
  assert.deepEqual(stepProgress(groups("permanent", ...open)), { done: ["RN-2"], outOfOrder: [] });
  assert.deepEqual(stepProgress(groups("permanent")).outOfOrder, []);
  // RN-3 done while RN-2 still has groups: out of order.
  const skipped = stepProgress(groups("RN-2", ...STEPS.slice(2)));
  assert.deepEqual(skipped, { done: ["RN-3"], outOfOrder: ["RN-3"] });
});

test("steps RN-12..RN-20 (KOBE-824) run after RN-8 and before RN-9; headers may name the ticket", () => {
  assert.deepEqual(STEPS.slice(STEPS.indexOf("RN-8") + 1), [
    ...["RN-12", "RN-13", "RN-14", "RN-15", "RN-16", "RN-17", "RN-18", "RN-19", "RN-20"],
    "RN-9",
  ]);
  const list = parseList("== RN-13 (KOBE-826): connector\n** /x/\n== RN-20: skills\n** /y/\n");
  assert.deepEqual(
    list.groups.map((g) => [g.step, g.reason]),
    [
      ["RN-13", "connector"],
      ["RN-20", "skills"],
    ],
  );
  // RN-10 and RN-11 own no groups: not steps of the allowlist.
  assert.throws(() => parseList("== RN-10: x\n"), /bad group header/);
  assert.throws(() => parseList("== RN-11 (KOBE-824): x\n"), /bad group header/);
  assert.throws(() => parseList("== RN-13 (later): x\n"), /bad group header/);
  const groups = (...steps) => steps.map((step) => ({ step, reason: "r" }));
  // RN-12..RN-20 may finish while RN-9 is open; RN-9 may not finish before them.
  const migrations = STEPS.slice(STEPS.indexOf("RN-12"), STEPS.indexOf("RN-9"));
  assert.deepEqual(stepProgress(groups("permanent", "RN-9")).outOfOrder, []);
  assert.deepEqual(stepProgress(groups(...migrations)).outOfOrder, ["RN-9"]);
  const skipped = groups(...migrations.filter((s) => s !== "RN-13"), "RN-9");
  assert.deepEqual(stepProgress(skipped).outOfOrder, ["RN-13"]);
});

test("the repository's lists parse, each step file holds only its own step", () => {
  const allowlist = loadAllowlist(REPO);
  assert.ok(allowlist.groups.every((g) => g.reason.length > 10));
  const { done, outOfOrder } = stepProgress(allowlist.groups);
  assert.deepEqual(outOfOrder, [], "done steps form a prefix of the step order");
  for (const step of STEPS.filter((s) => !done.includes(s))) {
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

/** Owner step of the first occurrence of `token` in `line` of `path`, per the real allowlist. */
function realOwner(path, line, token) {
  const allowlist = loadAllowlist(REPO);
  const file = { path, read: () => ({ binary: false, text: line }) };
  const { found } = audit(REPO, allowlist, [file]);
  const unit = line === "" ? path : line;
  const at = unit.indexOf(token);
  assert.ok(at >= 0, `${token} in ${unit}`);
  const hit = found.find(
    (o) => o.unit.text === unit && o.start >= at && o.start < at + token.length,
  );
  return hit?.owner?.step ?? "unowned";
}

/** Like realOwner, as `step: group reason`. */
function realGroup(path, line, token) {
  const { found } = audit(REPO, loadAllowlist(REPO), [
    { path, read: () => ({ binary: false, text: line }) },
  ]);
  const at = line.indexOf(token);
  assert.ok(at >= 0, `${token} in ${line}`);
  const hit = found.find((o) => o.start >= at && o.start < at + token.length);
  return hit?.owner ? `${hit.owner.step}: ${hit.owner.group.reason}` : "unowned";
}

test("real allowlist after RN-3 (KOBE-747): package imports, renamed files and test values are no longer allowed", () => {
  const gone = [
    ["services/server/src/x.ts", 'import { a } from "../kobe-mcp/access.js";', "kobe-mcp"],
    ["apps/web/x.test.tsx", 'import { FakeKobe } from "../../lib/chat/testing/fake-kobe";', "kobe"],
    ["services/server/src/x.ts", 'import { db } from "@kobe/db";', "kobe"],
    ["docs/x.md", "see `apps/web/components/chat/kobe-runtime.tsx`", "kobe-runtime"],
    ["apps/web/x.test.ts", 'fetch("http://kobe.test/v1/me")', "kobe"],
    ["packages/cli/src/x.test.ts", '"postgres://u:p@db:5432/kobe?sslmode=disable"', "kobe"],
    ["apps/web/x.test.tsx", "expect(text).toMatch(/kobe found/);", "kobe"],
    // RN-6 (KOBE-750): in-pod paths, image names and the chart directory are renamed.
    ["services/sandbox-agent/src/config.ts", '"/var/run/secrets/kobe/bootstrap-token"', "kobe"],
    ["services/Dockerfile", "COPY ca.pem /etc/kobe/extra-ca/", "kobe"],
    ["e2e/run/10-deploy.sh", "$HELM upgrade --install kobe charts/kobe -n x", "kobe"],
    ["charts/kaiju/values.yaml", "image: ghcr.io/splittingatom/kobe-server", "kobe-server"],
    ["services/server/src/x.ts", "export type KobeTx = Tx;", "Kobe"],
    // RN-14 (KOBE-827): the agent's file names, entry types and folder are renamed.
    ["services/sandbox-agent/src/x.ts", 'join(dir, "agent/kobe-context.json")', "kobe"],
    ["services/sandbox-agent/src/x.test.ts", "expect(m).toMatch(/^kobe\\.model_error:x/);", "kobe"],
    ["services/sandbox-agent/src/x.ts", 'const STATE_DIR = ".kobe";', "kobe"],
  ];
  for (const [path, line, token] of gone) {
    assert.equal(realGroup(path, line, token), "unowned", `${line} ${token}`);
  }
  const kept = [
    // RN-6 is done (KOBE-750): the eval route's old name is served for one release only.
    [
      "services/model-gateway/src/gateway.ts",
      'export const LEGACY_EVAL_CASES_PATH = "/kobe/eval-cases";',
      "kobe",
      /^permanent: Pre-rename names served or accepted for one release/,
    ],
    // The chart's selector label value and the database name stay (KOBE-750).
    [
      "charts/kaiju/templates/_helpers.tpl",
      '{{- define "kaiju.appName" -}}kobe{{- end -}}',
      "kobe",
      /^permanent: The chart's selector label value/,
    ],
    [
      "charts/kaiju/templates/postgres-cnpg.yaml",
      "      database: kobe",
      "kobe",
      /^permanent: The Postgres database name/,
    ],
    // The gallery agent's file moved with the agent (KOBE-831): the old path is not allowed.
    [
      "services/server/src/x.ts",
      'import { KOBE_FILE } from "./agents/kobe.js";',
      "kobe",
      /^unowned$/,
    ],
    // RN-18 is done (KOBE-831): the pre-rename tool value is read for good, in one place.
    [
      "services/server/src/agents/manifest.ts",
      'export const PRE_RENAME_TOOL_ORIGIN = "kobe";',
      "kobe",
      /^permanent: The value `kobe` that Kaiju's skill publisher/,
    ],
    // Escaped forms in regex literals belong to the value they spell (KOBE-747).
    [
      "packages/db/src/team-setters.test.ts",
      "  /\\bSET\\s+[\"']?kobe\\.team_id\\b/i,",
      "kobe",
      /^permanent: Postgres settings/,
    ],
    // RN-14 is done (KOBE-827): the old model-error prefix is read for one release, in one place.
    [
      "packages/protocol/src/sandbox-wire/pi-events.ts",
      'export const PRE_RENAME_MODEL_ERROR_PREFIX = "kobe.model_error:";',
      "kobe",
      /^permanent: The model-error prefix `kobe\.model_error:`/,
    ],
    [
      "services/server/src/auth/x.ts",
      "VALUES (${`kobe:${slotKey(account)}`}, 1)",
      "kobe",
      /^permanent: Rate-limit keys/,
    ],
  ];
  for (const [path, line, token, group] of kept) {
    assert.match(realGroup(path, line, token), group, `${line} ${token}`);
  }
});

test("real allowlist: owners of the cases from review round 1", () => {
  const cases = [
    // RN-5 is done: an old header name is a miss, except where a receiver reads it for one
    // release (KOBE-749).
    ["apps/web/lib/api.ts", 'headers: { "x-kobe-team": id }', "x-kobe-team", "unowned"],
    ["apps/web/lib/api.ts", 'headers: { "X-Kobe-Team": id }', "X-Kobe-Team", "unowned"],
    [
      "services/server/src/authz/middleware.ts",
      "the pre-rename `x-kobe-team` that API clients",
      "x-kobe-team",
      "permanent",
    ],
    ["scripts/hadron.sh", 'echo "KOBE-${BASH_REMATCH[2]}"', "KOBE-", "permanent"],
    ["apps/web/lib/admin/nav/types.ts", "type TicketId = `KOBE-${number}`;", "KOBE-", "permanent"],
    ["packages/db/drizzle/0137_kobe_published_skills.sql", "", "kobe", "permanent"],
    ["services/server/builtin-skills/pdf/kobe.skill.yaml", "", "kobe", "RN-20"],
    ["services/server/builtin-skills/kobe-guide/SKILL.md", "", "kobe", "permanent"],
    ["packages/db/src/schema/registry.ts", '  "kobe-guide",', "kobe-guide", "permanent"],
    ["packages/db/src/schema/registry.ts", "    kobeShippedVersion: text(),", "kobe", "permanent"],
    ["services/server/src/x.ts", "row.kobeShippedVersion", "kobe", "permanent"],
    [
      "packages/db/src/schema/connectors.ts",
      'export const KOBE_BUILTIN_CONNECTOR_URL = "http://kobe-server.internal/internal/v1/mcp/kobe";',
      "kobe-server.internal",
      // KOBE-826 moved the marker URLs to kaiju-server.internal (migration 0260): no longer kept.
      "unowned",
    ],
    [
      "services/server/src/retention/job.ts",
      'export const RETENTION_LOCK = "kobe.retention";',
      "kobe.retention",
      "permanent",
    ],
    ["packages/db/src/sso-required.ts", "hashtext('kobe.sso.required')", "kobe.sso", "permanent"],
    ["services/server/src/m.ts", "`kobe.memory-scope:${loc.lockKey}`", "kobe.memory", "permanent"],
    [
      "packages/db/src/test-support/database.ts",
      "hashtextextended('kobe.audit_log', 0)",
      "kobe.audit_log",
      "permanent",
    ],
    ["services/server/src/s.ts", 'action: "skill.kobe.published"', "kobe.published", "permanent"],
    ["services/server/src/s.ts", '"mcp.kobe.team_level_changed"', "kobe.team", "permanent"],
    [
      "services/server/src/skills/mirror/git-mirror.ts",
      "`Kobe-Registry-Version: ${v}`",
      "Kobe-Registry",
      "permanent",
    ],
    [
      "services/server/src/models/desired.ts",
      'export const SITE_CUSTOMER = "kobe-site";',
      "kobe-site",
      "permanent",
    ],
    [
      "services/server/src/sandbox/constants.ts",
      'export const RESOURCE_QUOTA = "kobe-team-quota";',
      "kobe-team-quota",
      "unowned",
    ],
    [
      "services/server/src/sandbox/constants.ts",
      'export const NETWORK_POLICY = "kobe-sandbox-isolation";',
      "kobe-sandbox",
      "unowned",
    ],
    [
      "services/server/src/routes/internal.ts",
      '"kobe-sandbox-token"',
      "kobe-sandbox-token",
      "unowned",
    ],
    [
      "services/server/src/mcp/principal.ts",
      "else the pre-rename `kobe-sandbox-token` a proxy pod",
      "kobe-sandbox-token",
      "permanent",
    ],
    // RN-4 is done: an old variable name is a miss, except in the one-release fallback (KOBE-748).
    ["services/mcp-proxy/src/config.ts", "env.KOBE_MCP_SERVER_URL", "KOBE_MCP", "unowned"],
    [
      "services/mcp-proxy/src/config.ts",
      "// KAIJU_* names; the old KOBE_* names stand in for one release (KOBE-748).",
      "KOBE_*",
      "permanent",
    ],
    [
      "scripts/check-test-db-env.sh",
      'if [ -z "${KAIJU_TEST_DATABASE_URL:-}" ] && [ -n "${KOBE_TEST_DATABASE_URL:-}" ]; then',
      "KOBE_TEST",
      "permanent",
    ],
    ["images/sandbox/runas/kaiju-runas.c", "#define KOBE_AGENT_UID 1000", "KOBE_AGENT", "unowned"],
    // Round 2: both sides of a paired value stay together.
    [
      "packages/session-token/src/site.ts",
      'if (c.iss !== "kobe-server" || c.aud !== A) return null;',
      "kobe-server",
      "permanent",
    ],
    [
      "services/server/src/models/reconcile.test.ts",
      "`customer.update kobe-install ${SITE_CUSTOMER}`",
      "kobe-install",
      "permanent",
    ],
    ["e2e/run/40-model-gateway-setup.sh", 'grep -q "kobe-site"', "kobe-site", "permanent"],
    // RN-7 is done (KOBE-751): the kept generation is configuration, a fixed name is a miss.
    [
      "services/server/src/sandbox/kube.ts",
      'export const FIELD_MANAGER = "kobe-server";',
      "kobe-server",
      "unowned",
    ],
    [
      "services/server/src/sandbox/constants.ts",
      'export const TEAM_NAMESPACE_PREFIXES = ["kaiju-team-", "kobe-team-"] as const;',
      "kobe-team-",
      "permanent",
    ],
    [
      "packages/db/src/egress/store.ts",
      'export const EGRESS_CHANGES_CHANNEL = "kobe_egress";',
      "kobe_egress",
      "permanent",
    ],
    ["services/server/src/x.ts", '"kobe.tool.name"', "kobe.tool", "unowned"],
    // The setting stays; the span attribute of the same spelling was renamed (KOBE-749).
    [
      "services/server/src/x.ts",
      "set_config('kobe.team_id', $1, true)",
      "kobe.team_id",
      "permanent",
    ],
    ["packages/telemetry/src/spans.ts", '  teamId: "kobe.team_id",', "kobe.team_id", "unowned"],
    // A test variable named kobe is not a telemetry name.
    [
      "apps/web/x.test.tsx",
      'act(() => kobe.agent.delta(runId, "m1", "Here", 1));',
      "kobe",
      "unowned",
    ],
    ["services/server/src/kobe-mcp/h.ts", 'export let kobeName = "kobe";', "kobeName", "unowned"],
    // RN-18 renamed the stored value (KOBE-831): no longer allowed.
    ["services/server/src/kobe-mcp/h.ts", 'export let kobeName = "kobe";', '"kobe"', "unowned"],
  ];
  for (const [path, line, token, step] of cases) {
    assert.equal(realOwner(path, line, token), step, `${path}: ${line || "(path)"} ${token}`);
  }
});

test("real allowlist: after RN-7 only the kept prefix generation is allowed (KOBE-751)", () => {
  const cases = [
    // The admission policy and the server take the prefix from configuration.
    [
      "charts/kaiju/templates/sandbox-admission.yaml",
      "startsWith('kobe-team-')",
      "kobe-team-",
      "unowned",
    ],
    [
      "services/server/src/sandbox/manifests.ts",
      'name: "kobe-sandbox",',
      "kobe-sandbox",
      "unowned",
    ],
    ["e2e/x.sh", 'NS="kobe-team-finance"', "kobe-team-", "unowned"],
    // The chart's list of the two prefixes, and the tests of the kept generation.
    [
      "charts/kaiju/templates/_sandbox.tpl",
      '{{- $known := list "kaiju-team-" "kobe-team-" -}}',
      "kobe-team-",
      "permanent",
    ],
    [
      "services/server/src/sandbox/provider-prefix.test.ts",
      'const OLD_NS = "kobe-team-finance";',
      "kobe-team-",
      "permanent",
    ],
    // The Bifrost team name is stored in Bifrost, not a namespace.
    [
      "services/server/src/models/desired.ts",
      "(teamId: string) => `kobe-team-${teamId}`;",
      "kobe-team-",
      "permanent",
    ],
  ];
  for (const [path, line, token, step] of cases) {
    assert.equal(realOwner(path, line, token), step, `${path}: ${line} ${token}`);
  }
});

test("paired-value rule: a value owned by two steps is reported", () => {
  const list = parseList(
    '== permanent: issuer\n** /\\biss\\b[^\\n]*?"kobe-server"/\n' +
      "== RN-6: image names\n** /\\bkobe-server\\b/\n== RN-3: fake markers\n** /\\bkobe-faux\\b/\n",
  );
  const file = (path, text) => ({ path, read: () => ({ binary: false, text }) });
  const files = [
    file("a.ts", 'const t = { iss: "kobe-server" };\nif (c.iss !== "kobe-server") fail();'),
    file("b.ts", 'const svc = "kobe-server"; const m = "kobe-faux";'),
    file("c.sh", "grep kobe-faux"),
  ];
  const { found } = audit(root, list, files);
  const split = splitValues(found);
  assert.deepEqual(
    split.map((x) => x.value),
    ["kobe-server"],
  );
  assert.deepEqual(Object.keys(split[0].owners).sort(), ["RN-6", "kept"]);
});

/**
 * Values the real allowlist splits on purpose: the same letters name different things, each
 * side consistent within its own meaning. Anything else split fails (review round 2).
 */
const DISTINCT_VALUES = {
  "kobe-server":
    "signed issuer and connector URL host (kept), in-namespace RoleBinding/managed-by/field manager (RN-7); the image/Service name was renamed in RN-6",
  "kobe-sandbox":
    "the ServiceAccount/template/warm pool in team namespaces (RN-7); the image name was renamed in RN-6",
  "kobe-skill-scan":
    "the NetworkPolicy in team namespaces (RN-7); the image name was renamed in RN-6",
  "kobe-pi":
    "the Unix user names (kept, Q7); the runtime directories /run/kobe-pi, /tmp/kobe-pi-* were renamed in RN-6",
  "kobe-agent":
    "the Unix user (kept, Q7); the runtime directory /run/kobe-agent was renamed in RN-6",
  kobe_:
    "test database prefix (RN-8) vs column aliases in docs/perf queries (RN-5, with the span attributes they read)",
  "kobe-sign-in-throttle":
    "the Better Auth plugin id (RN-5) vs the derived-hash label of the throttle key (kept)",
};

test("real allowlist: no paired value is split across steps, apart from the listed distinct ones", () => {
  const { found } = audit(REPO, loadAllowlist(REPO));
  const split = splitValues(found).filter((x) => !Object.hasOwn(DISTINCT_VALUES, x.value));
  assert.deepEqual(
    split.map((x) => `${x.value} ${JSON.stringify(x.owners)}`),
    [],
  );
});
