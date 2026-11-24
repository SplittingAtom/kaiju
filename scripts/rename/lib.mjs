// Shared engine of the rename tooling (KOBE-745, docs/specs/rename-kaiju.md): parses the allowlist
// and the per-step pattern lists, lists every occurrence of the old name (any case) in tracked file
// contents and paths, decides which entry owns each occurrence, and swaps the old name for the new
// one inside the spans a step's patterns match. No dependencies: runs with plain `node`.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const ALLOWLIST = "scripts/rename/allowlist.txt";

/** The allowlist, with its permanent groups first (they protect what no step may change). */
export function loadAllowlist(root) {
  const list = parseList(readFileSync(`${root}/${ALLOWLIST}`, "utf8"), ALLOWLIST);
  const firstStep = list.groups.findIndex((g) => g.step !== PERMANENT);
  const late = list.groups.findIndex(
    (g, i) => firstStep >= 0 && i > firstStep && g.step === PERMANENT,
  );
  if (late >= 0)
    throw new Error(`${ALLOWLIST}:${list.groups[late].line}: permanent groups come first`);
  return list;
}

/** The old name, any case. Every occurrence of these four letters is accounted for. */
export const OLD = /kobe/gi;
export const STEPS = ["RN-2", "RN-3", "RN-4", "RN-5", "RN-6", "RN-7", "RN-8", "RN-9"];
export const PERMANENT = "permanent";

/** Kobe -> Kaiju, kobe -> kaiju, KOBE -> KAIJU (spec RN6: "Kaiju" in text, `kaiju` in code). */
export function swapCase(word) {
  if (word === word.toUpperCase()) return "KAIJU";
  if (word[0] === word[0].toUpperCase()) return "Kaiju";
  return "kaiju";
}

/**
 * A glob over repo-relative paths: `**` any characters including `/`, `*` and `?` within one path
 * segment, `{a,b}` alternatives. `dir/**` also matches files directly in `dir`.
 */
export function globToRegExp(glob) {
  let re = "";
  let braces = 0;
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      const slash = glob[i + 2] === "/";
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{") {
      braces += 1;
      re += "(?:";
    } else if (c === "}" && braces > 0) {
      braces -= 1;
      re += ")";
    } else if (c === "," && braces > 0) re += "|";
    else re += c.replace(/[.+^$()|[\]\\{}]/g, "\\$&");
  }
  if (glob.endsWith("/**")) re = re.replace(/\/\.\*$/, "(?:/.*)?");
  return new RegExp(`^${re}$`);
}

/**
 * Parses an allowlist or step file. Format, one item per line:
 *   `# comment` and blank lines are ignored;
 *   `== <step>: <reason>` starts a group (<step> is `permanent` or RN-2..RN-9);
 *   `[path] <glob>... /<regex>/[i]` is an entry of the current group: globs (a leading `!`
 *   excludes) select files, the regex is matched line by line against the file's contents (or
 *   against the whole path with the `path` keyword).
 */
export function parseList(text, source = "list") {
  const groups = [];
  const entries = [];
  text.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    const where = `${source}:${index + 1}`;
    if (line === "" || line.startsWith("#")) return;
    const header = /^==\s*(permanent|RN-[2-9])\s*:\s*(\S.*)$/.exec(line);
    if (header) {
      groups.push({ step: header[1], reason: header[2], line: index + 1, entries: [] });
      return;
    }
    if (line.startsWith("==")) throw new Error(`${where}: bad group header: ${line}`);
    const group = groups.at(-1);
    if (!group) throw new Error(`${where}: entry before the first group header`);
    const at = line.search(/(?:^|\s)\//);
    if (at < 0) throw new Error(`${where}: entry without a /regex/: ${line}`);
    const tokens = line.slice(0, at).trim().split(/\s+/).filter(Boolean);
    const literal = /^\/(.+)\/(i?)$/.exec(line.slice(at).trim());
    if (!literal) throw new Error(`${where}: bad regex literal: ${line}`);
    const kind = tokens[0] === "path" ? "path" : "content";
    const globs = kind === "path" ? tokens.slice(1) : tokens;
    if (globs.length === 0) throw new Error(`${where}: entry without a glob: ${line}`);
    let regex;
    try {
      regex = new RegExp(literal[1], `g${literal[2]}`);
    } catch (error) {
      throw new Error(`${where}: ${error.message}`, { cause: error });
    }
    const entry = {
      id: entries.length,
      step: group.step,
      group,
      kind,
      text: line,
      line: index + 1,
      include: globs.filter((g) => !g.startsWith("!")).map(globToRegExp),
      exclude: globs.filter((g) => g.startsWith("!")).map((g) => globToRegExp(g.slice(1))),
      regex,
    };
    if (entry.include.length === 0) throw new Error(`${where}: only exclusions: ${line}`);
    group.entries.push(entry);
    entries.push(entry);
  });
  return { groups, entries };
}

export function selects(entry, path) {
  return entry.include.some((re) => re.test(path)) && !entry.exclude.some((re) => re.test(path));
}

/** Tracked files (`git ls-files`), with contents; binary files are read as latin1, never skipped. */
export function trackedFiles(root) {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split("\0")
    .filter(Boolean)
    .map((path) => {
      let cached;
      return { path, read: () => (cached ??= readText(`${root}/${path}`)) };
    });
}

export function readText(file) {
  const bytes = readFileSync(file);
  const binary = bytes.subarray(0, 8000).includes(0);
  return { binary, text: bytes.toString(binary ? "latin1" : "utf8") };
}

/** Start offsets of the old name in `text`. */
export function occurrences(text) {
  const found = [];
  OLD.lastIndex = 0;
  for (let m = OLD.exec(text); m; m = OLD.exec(text)) found.push(m.index);
  return found;
}

/** Spans `[start, end)` the entry's regex matches in `text`. */
export function spans(entry, text) {
  const out = [];
  entry.regex.lastIndex = 0;
  for (let m = entry.regex.exec(text); m; m = entry.regex.exec(text)) {
    if (m[0].length === 0) {
      entry.regex.lastIndex += 1;
      continue;
    }
    out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

const covers = (list, start) => list.some(([a, b]) => start >= a && start + 4 <= b);

/**
 * Calls `visit(occurrence)` for every occurrence of the old name in `units` (lines of a file, or
 * the path itself), with the first entry (in list order) whose span covers it, or `null`.
 */
function attribute(units, entries, visit) {
  for (const unit of units) {
    const starts = occurrences(unit.text);
    if (starts.length === 0) continue;
    const cache = new Map();
    for (const start of starts) {
      let owner = null;
      for (const entry of entries) {
        let list = cache.get(entry.id);
        if (!list) cache.set(entry.id, (list = spans(entry, unit.text)));
        if (covers(list, start)) {
          owner = entry;
          break;
        }
      }
      visit({ unit, start, owner });
    }
  }
}

export function linesOf(text) {
  const units = [];
  let offset = 0;
  text.split("\n").forEach((line, index) => {
    units.push({ text: line, number: index + 1, offset });
    offset += line.length + 1;
  });
  return units;
}

/**
 * Every occurrence in the tracked tree, each with its owning allowlist entry (or none). Returns the
 * occurrences and the entries that own nothing (stale).
 */
export function audit(root, list, files = trackedFiles(root)) {
  const found = [];
  const owned = new Set();
  for (const file of files) {
    const pathEntries = list.entries.filter((e) => e.kind === "path" && selects(e, file.path));
    attribute([{ text: file.path, number: 0 }], pathEntries, (o) => {
      found.push({ path: file.path, kind: "path", line: 0, at: o.start, unit: o.unit.text, ...o });
      if (o.owner) owned.add(o.owner.id);
    });
    const { text } = file.read();
    if (!/kobe/i.test(text)) continue;
    const entries = list.entries.filter((e) => e.kind === "content" && selects(e, file.path));
    attribute(linesOf(text), entries, (o) => {
      found.push({ path: file.path, kind: "content", line: o.unit.number, ...o });
      if (o.owner) owned.add(o.owner.id);
    });
  }
  return { found, stale: list.entries.filter((e) => !owned.has(e.id)) };
}

/** The word around an occurrence, for reports: `x-kobe-team`, `KOBE-745`, `@kobe/db`. */
export function tokenAt(text, start) {
  let a = start;
  let b = start + 4;
  while (a > 0 && /[\w.@/$:-]/.test(text[a - 1])) a -= 1;
  while (b < text.length && /[\w.@/$:-]/.test(text[b])) b += 1;
  return text.slice(a, b);
}

/** Owning allowlist entry per occurrence start in one unit of text. */
export function ownersOf(text, allowEntries) {
  const owners = new Map();
  attribute([{ text }], allowEntries, (o) => owners.set(o.start, o.owner));
  return owners;
}

/**
 * Swaps the old name in one unit of text (a line, or a path) where three things hold: a span of the
 * step's patterns covers it, the allowlist attributes it to a group of this step whose header the
 * step file repeats (so a step never renames what the allowlist gives to another step, or to a
 * group the step file leaves out), and no permanent allowlist entry covers it.
 * Returns the new text, the occurrences changed, and the ones of this step left unchanged.
 */
export function swapUnit(
  text,
  step,
  stepEntries,
  allowEntries,
  owners = ownersOf(text, allowEntries),
) {
  const starts = occurrences(text);
  const none = { text, changed: 0, starts: [], left: [] };
  if (starts.length === 0) return none;
  const matched = stepEntries.flatMap((e) => spans(e, text));
  const kept = allowEntries.filter((e) => e.step === PERMANENT).flatMap((e) => spans(e, text));
  const mine = starts.filter((s) => owners.get(s)?.step === step);
  const reasons = new Set(stepEntries.map((e) => e.group.reason));
  const change = mine.filter(
    (s) => reasons.has(owners.get(s).group.reason) && covers(matched, s) && !covers(kept, s),
  );
  const left = mine.filter((s) => !change.includes(s));
  if (change.length === 0) return { ...none, left };
  let out = "";
  let last = 0;
  for (const s of change) {
    out += text.slice(last, s) + swapCase(text.slice(s, s + 4));
    last = s + 4;
  }
  return { text: out + text.slice(last), changed: change.length, starts: change, left };
}

/**
 * What one step would change: per file the new contents (when they change), the new path (when it
 * changes), the occurrence counts, and the occurrences the allowlist gives this step that its
 * patterns leave alone (hand edits, or a pattern to add). Pure: writes nothing.
 */
export function planStep(
  root,
  step,
  stepList,
  allowlist,
  files = trackedFiles(root),
  cache = new Map(),
) {
  /** Ownership does not depend on the step: computed once per unit when a cache is shared. */
  const owned = (key, text, entries) => {
    let owners = cache.get(key);
    if (!owners) cache.set(key, (owners = ownersOf(text, entries)));
    return owners;
  };
  const plan = [];
  const left = [];
  const pick = (list, kind, path) =>
    list.entries.filter((e) => e.kind === kind && selects(e, path));
  for (const file of files) {
    const pathAllow = pick(allowlist, "path", file.path);
    const moved = swapUnit(
      file.path,
      step,
      pick(stepList, "path", file.path),
      pathAllow,
      owned(`${file.path}\0path`, file.path, pathAllow),
    );
    for (const s of moved.left) left.push({ path: file.path, line: 0, text: file.path, start: s });
    let content = { changed: 0, lines: [] };
    const { text } = file.read();
    if (/kobe/i.test(text)) {
      const stepEntries = pick(stepList, "content", file.path);
      const allowEntries = pick(allowlist, "content", file.path);
      const lines = linesOf(text).map((u) => ({
        u,
        r: !/kobe/i.test(u.text)
          ? { text: u.text, changed: 0, starts: [], left: [] }
          : swapUnit(
              u.text,
              step,
              stepEntries,
              allowEntries,
              owned(`${file.path}\0${u.number}`, u.text, allowEntries),
            ),
      }));
      for (const { u, r } of lines) {
        for (const s of r.left)
          left.push({ path: file.path, line: u.number, text: u.text, start: s });
      }
      const changed = lines.reduce((n, l) => n + l.r.changed, 0);
      if (changed > 0) {
        content = {
          changed,
          text: lines.map((l) => l.r.text).join("\n"),
          lines: lines.filter((l) => l.r.changed > 0).map((l) => l.u.number),
        };
      }
    }
    if (moved.changed > 0 || content.changed > 0) {
      plan.push({
        path: file.path,
        to: moved.changed > 0 ? moved.text : null,
        pathChanges: moved.changed,
        contentChanges: content.changed,
        text: content.text,
        lines: content.lines,
      });
    }
  }
  return { plan, left };
}
