#!/usr/bin/env node
// Replacement script of the rename (KOBE-745, docs/specs/rename-kaiju.md §4). One pattern list per
// step in scripts/rename/steps/RN-<n>.txt (format: scripts/rename/README.md). An occurrence of the
// old name changes only when the step's patterns match it, the allowlist gives it to that step and
// no permanent allowlist entry covers it; inside the match only the four letters change, keeping
// their case (Kobe -> Kaiju, kobe -> kaiju, KOBE -> KAIJU). Never a blanket replace.
//
//   node scripts/rename/rename.mjs                       dry run of every step (writes nothing)
//   node scripts/rename/rename.mjs --step RN-3           dry run of one step
//   node scripts/rename/rename.mjs --summary             totals only, no file lists
//   node scripts/rename/rename.mjs --apply --step RN-3   apply one step (clean tree; git mv paths)
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

/** Prints what a step would change; returns the plan. */
export function report(root, step, { files, cache, summary, log = console.log } = {}) {
  const allowlist = loadAllowlist(root);
  const { plan, left } = planStep(root, step, loadStep(root, step), allowlist, files, cache);
  const occurrences = plan.reduce((n, p) => n + p.contentChanges, 0);
  const moved = plan.filter((p) => p.to);
  const edited = plan.filter((p) => p.contentChanges > 0);
  log(
    `${step}: ${occurrences} occurrence(s) in ${edited.length} file(s), ${moved.length} path(s) renamed; ` +
      `${left.length} occurrence(s) the allowlist gives ${step} left for hand edits`,
  );
  if (left.length > 0) log(`  left: ${topTokens(left, 12)}`);
  if (!summary) {
    for (const p of plan) {
      const counts = p.contentChanges > 0 ? `${p.contentChanges}` : "-";
      log(`  ${counts.padStart(5)}  ${p.path}${p.to ? ` -> ${p.to}` : ""}`);
    }
  }
  return { plan, left };
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

/** Applies a step: rewrites contents, then moves paths with `git mv`. */
export function apply(root, step, { allowDirty = false, log = console.log } = {}) {
  if (!allowDirty && git(root, ["status", "--porcelain"]).trim() !== "") {
    throw new Error("the working tree is not clean: commit or stash first (or --allow-dirty)");
  }
  const { plan } = report(root, step, { summary: true, log });
  const edited = plan.filter((p) => p.contentChanges > 0);
  for (const p of edited) writeFileSync(`${root}/${p.path}`, p.text);
  for (let i = 0; i < edited.length; i += 500) {
    git(root, ["add", "--", ...edited.slice(i, i + 500).map((p) => p.path)]);
  }
  for (const p of plan.filter((x) => x.to)) {
    if (existsSync(`${root}/${p.to}`)) throw new Error(`${p.path} -> ${p.to}: target exists`);
    mkdirSync(dirname(`${root}/${p.to}`), { recursive: true });
    git(root, ["mv", p.path, p.to]);
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
    apply(ROOT, step, { allowDirty: args.includes("--allow-dirty") });
    return 0;
  }
  const files = trackedFiles(ROOT);
  const cache = new Map();
  for (const s of step ? [step] : STEPS) {
    report(ROOT, s, { files, cache, summary: args.includes("--summary") });
  }
  console.log("dry run: nothing written");
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
