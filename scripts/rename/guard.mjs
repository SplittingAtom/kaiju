#!/usr/bin/env node
// Rename guard (KOBE-745, docs/specs/rename-kaiju.md §4 step 1): every occurrence of the old name,
// in any case, in tracked file contents and paths must be owned by an entry of
// scripts/rename/allowlist.txt, and every entry must own at least one occurrence, so the list can
// only shrink. Runs from the repo root in CI's static job and `pnpm verify` (not a package test:
// turbo would replay a cached pass when only files outside that package changed).
//
//   node scripts/rename/guard.mjs             check; exit 1 on an unowned occurrence or stale entry
//   node scripts/rename/guard.mjs --report    also print totals per step and per group
//   node scripts/rename/guard.mjs --pairs     list values whose occurrences are owned by more than one
//                                             step (paired-value rule; see splitValues in lib.mjs)
//   node scripts/rename/guard.mjs --final     also fail while any group is not permanent (the
//                                             definition of done, spec §8.2: no step, no question)
//   node scripts/rename/guard.mjs --tokens    print unowned occurrences grouped by area and word
import { fileURLToPath } from "node:url";
import {
  ALLOWLIST,
  PERMANENT,
  PROVISIONAL,
  STEPS,
  audit,
  loadAllowlist,
  splitValues,
  tokenAt,
} from "./lib.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Totals per step and per group: occurrences and distinct files. */
export function totals(found) {
  const by = new Map();
  const add = (key, path) => {
    const t = by.get(key) ?? { count: 0, files: new Set() };
    t.count += 1;
    t.files.add(path);
    by.set(key, t);
  };
  for (const o of found) {
    add(o.owner ? o.owner.step : "unowned", o.path);
    if (o.owner) add(o.owner.group, o.path);
    add("all", o.path);
  }
  return by;
}

function area(path) {
  const parts = path.split("/");
  return ["apps", "services", "packages", "docs"].includes(parts[0]) && parts.length > 2
    ? `${parts[0]}/${parts[1]}`
    : parts.length > 1
      ? parts[0]
      : "(root)";
}

function main(args) {
  const started = Date.now();
  const list = loadAllowlist(ROOT);
  const { found, stale } = audit(ROOT, list);
  const unowned = found.filter((o) => !o.owner);
  if (args.includes("--tokens")) {
    const words = new Map();
    for (const o of unowned) {
      const key = `${area(o.path)}\t${o.kind === "path" ? "path:" : ""}${tokenAt(o.unit.text, o.start)}`;
      words.set(key, (words.get(key) ?? 0) + 1);
    }
    for (const [k, n] of [...words].sort((a, b) => b[1] - a[1])) console.log(`${n}\t${k}`);
    return 0;
  }
  if (args.includes("--pairs")) {
    for (const s of splitValues(found)) console.log(`${s.value}\t${JSON.stringify(s.owners)}`);
    return 0;
  }
  if (args.includes("--report")) {
    const t = totals(found);
    const line = (label, v) =>
      console.log(
        `${label.padEnd(12)} ${String(v?.count ?? 0).padStart(7)} occurrences in ${String(v?.files.size ?? 0).padStart(5)} files`,
      );
    line("all", t.get("all"));
    for (const step of [PERMANENT, PROVISIONAL, ...STEPS, "unowned"]) line(step, t.get(step));
    console.log("");
    for (const g of list.groups) {
      const v = t.get(g);
      console.log(
        `${String(v?.count ?? 0).padStart(7)} ${String(v?.files.size ?? 0).padStart(5)}  [${g.step}] ${g.reason}`,
      );
    }
  }
  for (const o of unowned.slice(0, 200)) {
    const where = o.kind === "path" ? `${o.path} (path)` : `${o.path}:${o.line}`;
    console.error(`${where}: ${tokenAt(o.unit.text, o.start)}`);
  }
  for (const e of stale) {
    console.error(`${ALLOWLIST}:${e.line}: stale entry (owns nothing; delete it): ${e.text}`);
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const open = args.includes("--final") ? list.groups.filter((g) => g.step !== PERMANENT) : [];
  for (const g of open) {
    console.error(`${ALLOWLIST}:${g.line}: not done: [${g.step}] ${g.reason}`);
  }
  if (unowned.length > 0 || stale.length > 0 || open.length > 0) {
    console.error(
      `error: ${unowned.length} occurrence(s) of the old name not covered by ${ALLOWLIST}` +
        `${unowned.length > 200 ? " (first 200 shown)" : ""}, ${stale.length} stale entr(ies)` +
        `${open.length > 0 ? `, ${open.length} group(s) not done (--final)` : ""}. ` +
        "Use the new name, or add an entry with its reason and step (scripts/rename/README.md).",
    );
    return 1;
  }
  console.log(
    `rename guard: ok (${found.length} allowed occurrences, ${list.entries.length} entries, ${seconds}s)`,
  );
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
