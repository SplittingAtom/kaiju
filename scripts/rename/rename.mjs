#!/usr/bin/env node
// Replacement script of the rename (KOBE-745, docs/specs/rename-kaiju.md §4). One pattern list per
// step in scripts/rename/steps/RN-<n>.txt (format: scripts/rename/README.md). An occurrence of the
// old name changes only when the step's patterns match it, the allowlist gives it to that step and
// no kept (permanent or provisional) entry covers it, in contents or paths; inside the match only
// the four letters change, keeping their case (Kobe -> Kaiju, kobe -> kaiju, KOBE -> KAIJU). Never
// a blanket replace. --apply is all or nothing: it checks the whole plan first (step order, clean
// tree, no binary or symlink rewrite, no path whose references belong to another step, no target
// collision) and rolls back to HEAD if anything fails while writing.
//
//   node scripts/rename/rename.mjs                       dry run of every step (writes nothing)
//   node scripts/rename/rename.mjs --step RN-3           dry run of one step
//   node scripts/rename/rename.mjs --summary             totals only, no file lists
//   node scripts/rename/rename.mjs --apply --step RN-3   apply one step (clean tree; git mv paths)
//   node scripts/rename/rename.mjs --conflicts           also list every reference conflict
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { STEPS, loadAllowlist, parseList, planStep, tokenAt, trackedFiles } from "./lib.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

export function loadStep(root, step) {
  const file = `scripts/rename/steps/${step}.txt`;
  const list = parseList(readFileSync(`${root}/${file}`, "utf8"), file);
  const foreign = list.groups.filter((g) => g.step !== step);
  if (foreign.length > 0) {
    throw new Error(`${file}:${foreign[0].line}: group of ${foreign[0].step} in the ${step} list`);
  }
  return list;
}

function topTokens(left, n) {
  const count = new Map();
  for (const o of left) {
    const t = tokenAt(o.text, o.start);
    count.set(t, (count.get(t) ?? 0) + 1);
  }
  return [...count]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([t, c]) => `${t} (${c})`)
    .join(", ");
}

/** Prints what a step would change; returns the plan and what blocks an apply. */
export function report(
  root,
  step,
  { files, cache, summary, conflicts: listConflicts, log = console.log } = {},
) {
  const allowlist = loadAllowlist(root);
  const { plan, left, refused, conflicts } = planStep(
    root,
    step,
    loadStep(root, step),
    allowlist,
    files,
    cache,
  );
  const occurrences = plan.reduce((n, p) => n + p.contentChanges, 0);
  const moved = plan.filter((p) => p.to);
  const edited = plan.filter((p) => p.contentChanges > 0);
  log(
    `${step}: ${occurrences} occurrence(s) in ${edited.length} file(s), ${moved.length} path(s) renamed; ` +
      `${left.length} occurrence(s) the allowlist gives ${step} left for hand edits`,
  );
  if (left.length > 0) log(`  left: ${topTokens(left, 12)}`);
  for (const r of refused) log(`  REFUSED ${r}`);
  if (conflicts.length > 0) {
    const renamed = [...new Set(conflicts.map((c) => c.renamed))];
    const blocking = conflicts.filter((c) => c.blocking).length;
    log(
      `  CONFLICT: ${conflicts.length} reference(s) to ${renamed.length} renamed path(s) stay old ` +
        `(${blocking} blocking; Markdown and generated files only reported):`,
    );
    for (const c of listConflicts ? conflicts : conflicts.slice(0, 10)) {
      log(`    ${c.blocking ? "" : "(note) "}${c.renamed}: ${c.name} at ${c.at} (${c.owner})`);
    }
  }
  if (!summary) {
    for (const p of plan) {
      const counts = p.contentChanges > 0 ? `${p.contentChanges}` : "-";
      log(`  ${counts.padStart(5)}  ${p.path}${p.to ? ` -> ${p.to}` : ""}`);
    }
  }
  return { plan, left, refused, conflicts };
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

/** Groups of steps before `step` still in the allowlist: the steps run strictly in order. */
export function earlierSteps(allowlist, step) {
  const before = STEPS.slice(0, STEPS.indexOf(step));
  return [...new Set(allowlist.groups.filter((g) => before.includes(g.step)).map((g) => g.step))];
}

/** Everything that blocks applying `plan`, checked before anything is written. */
export function blockers(root, step, plan, refused, conflicts) {
  const out = [];
  const earlier = earlierSteps(loadAllowlist(root), step);
  if (earlier.length > 0) {
    out.push(
      `earlier step(s) ${earlier.join(", ")} still have allowlist groups: finish them first`,
    );
  }
  if (git(root, ["status", "--porcelain"]).trim() !== "") {
    out.push("the working tree is not clean: commit or stash first");
  }
  out.push(...refused);
  const blocking = conflicts.filter((c) => c.blocking);
  if (blocking.length > 0) {
    out.push(
      `${blocking.length} reference(s) to renamed paths stay old (dry run with --conflicts)`,
    );
  }
  const tracked = new Set(trackedFiles(root).map((f) => f.path.toLowerCase()));
  const leaving = new Set(plan.filter((p) => p.to).map((p) => p.path.toLowerCase()));
  const targets = new Set();
  for (const p of plan.filter((x) => x.to)) {
    const key = p.to.toLowerCase();
    if ((tracked.has(key) && !leaving.has(key)) || targets.has(key)) {
      out.push(`${p.path} -> ${p.to}: the target exists or collides (case-insensitive)`);
    }
    targets.add(key);
  }
  return out;
}

/** Applies a step, all or nothing: contents rewritten and staged, paths moved with `git mv`. */
export function apply(root, step, { log = console.log } = {}) {
  const { plan, refused, conflicts } = report(root, step, { summary: true, log });
  const blocked = blockers(root, step, plan, refused, conflicts);
  if (blocked.length > 0) throw new Error(`${step} not applied:\n  ${blocked.join("\n  ")}`);
  try {
    const edited = plan.filter((p) => p.contentChanges > 0);
    for (const p of edited) writeFileSync(`${root}/${p.path}`, p.text, "utf8");
    for (let i = 0; i < edited.length; i += 500) {
      git(root, ["add", "--", ...edited.slice(i, i + 500).map((p) => p.path)]);
    }
    for (const p of plan.filter((x) => x.to)) {
      mkdirSync(dirname(`${root}/${p.to}`), { recursive: true });
      git(root, ["mv", p.path, p.to]);
    }
  } catch (error) {
    // The tree was clean before: back to HEAD, new directories removed (ignored files untouched).
    git(root, ["reset", "-q", "--hard", "HEAD"]);
    git(root, ["clean", "-fdq"]);
    throw new Error(`${step} not applied (rolled back to HEAD): ${error.message}`, {
      cause: error,
    });
  }
  log(
    `${step}: applied. Next: delete the ${step} groups the step finished from allowlist.txt and run the guard.`,
  );
  return plan;
}

function main(args) {
  const at = args.indexOf("--step");
  const step = at >= 0 ? args[at + 1] : null;
  if (step !== null && !STEPS.includes(step)) {
    console.error(`unknown step ${step}; one of ${STEPS.join(", ")}`);
    return 2;
  }
  if (args.includes("--apply")) {
    if (!step) {
      console.error("--apply needs --step RN-<n>: one step per PR");
      return 2;
    }
    try {
      apply(ROOT, step);
    } catch (error) {
      console.error(error.message);
      return 1;
    }
    return 0;
  }
  const files = trackedFiles(ROOT);
  const cache = new Map();
  for (const s of step ? [step] : STEPS) {
    report(ROOT, s, {
      files,
      cache,
      summary: args.includes("--summary"),
      conflicts: args.includes("--conflicts"),
    });
  }
  console.log("dry run: nothing written");
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
