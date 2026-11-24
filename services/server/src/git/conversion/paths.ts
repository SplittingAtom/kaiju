/**
 * The tree-entry names a git host refuses (KOBE-765 review M1, G16: "a file the host would
 * reject"). GitHub, Gitea and Forgejo run `git fsck` on what they receive (`receive.fsckObjects`),
 * so a name fsck flags as an error makes the push fail part-way. These are git's own rules
 * (git 2.47 `fsck.c` `fsck_tree`, `path.c` `is_ntfs_dotgit`, `is_ntfs_dot_generic`, `utf8.c`
 * `is_hfs_dotgit`), ported exactly, plus a cap on `.gitattributes` lines (`gitattributesLineLength`):
 *
 * - `hasDot` / `hasDotdot` / `emptyName` / `fullPathname`: `.`, `..`, empty components;
 * - `hasDotgit`: `.git` in any case, its NTFS spellings (`.git` or `git~1` followed only by dots and
 *   spaces, or by `:` and anything: an alternate data stream) and its HFS spellings (with the
 *   characters HFS+ ignores);
 * - `.gitmodules` in the same spellings: fsck parses it and refuses `url`, `name` and `path`
 *   values it finds unsafe; submodules are out of scope (§10), so Kaiju refuses the file outright
 *   rather than guess what the host's fsck accepts;
 * - control characters (git accepts them, hosts and checkouts do not handle them safely).
 *
 * Kaiju's own path rules (`project_tree_entries_path`: at most 1024 characters, no leading or
 * trailing slash, no `//`, no backslash, no `.`/`..` segment) already keep paths within every
 * host's limits; they are checked again here so this module stands alone.
 */

/** Code points HFS+ ignores when comparing names (`utf8.c` `next_hfs_char`). */
const HFS_IGNORABLE = new Set([
  0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x206a, 0x206b, 0x206c,
  0x206d, 0x206e, 0x206f, 0xfeff,
]);

const withoutHfsIgnorable = (name: string): string =>
  Array.from(name)
    .filter((c) => !HFS_IGNORABLE.has(c.codePointAt(0) ?? 0))
    .join("");

/** Whether a name holds a control character (U+0000-U+001F, U+007F). */
const hasControl = (name: string): boolean =>
  Array.from(name).some((c) => {
    const code = c.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });

/** `only_spaces_and_periods`: from `i` on, only ' ' and '.' up to the end or a ':' (NTFS stream). */
function onlySpacesAndPeriods(name: string, i: number): boolean {
  for (; i < name.length; i += 1) {
    const c = name[i];
    if (c === ":") return true;
    if (c !== " " && c !== ".") return false;
  }
  return true;
}

/**
 * `is_ntfs_dot_generic(name, dotgit_name, len, shortname_prefix)`: `.<name>`, its 6-character short
 * name `<name[0..6]>~1`..`~4`, or the hashed fall-back short name `<prefix>~<digits>`, each followed
 * only by spaces and dots (or `:`), case-insensitively.
 */
export function isNtfsDotGeneric(name: string, dotName: string, shortPrefix: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith(`.${dotName}`)) return onlySpacesAndPeriods(name, dotName.length + 1);
  if (
    lower.startsWith(dotName.slice(0, 6)) &&
    name[6] === "~" &&
    name[7] !== undefined &&
    name[7] >= "1" &&
    name[7] <= "4"
  ) {
    return onlySpacesAndPeriods(name, 8);
  }
  let sawTilde = false;
  let i = 0;
  for (; i < 8; i += 1) {
    const c = name[i];
    if (c === undefined) return false;
    if (sawTilde) {
      if (c < "0" || c > "9") return false;
    } else if (c === "~") {
      i += 1;
      const d = name[i];
      if (d === undefined || d < "1" || d > "9") return false;
      sawTilde = true;
    } else if (i >= 6) {
      return false;
    } else if (c.charCodeAt(0) >= 0x80) {
      return false;
    } else if (c.toLowerCase() !== shortPrefix[i]) {
      return false;
    }
  }
  return onlySpacesAndPeriods(name, i);
}

/** `is_ntfs_dotgit`: `.git` or `git~1`, then only spaces and dots, up to the end or a `:`. */
export function isNtfsDotgit(name: string): boolean {
  const lower = name.toLowerCase();
  let rest: number;
  if (lower.startsWith(".git")) rest = 4;
  else if (lower.startsWith("git~1")) rest = 5;
  else return false;
  return onlySpacesAndPeriods(name, rest);
}

const hfsIs = (name: string, target: string) => withoutHfsIgnorable(name).toLowerCase() === target;

/** Why the host would refuse one tree-entry name, or undefined when it is fine. */
export function componentRefusal(name: string): string | undefined {
  if (name === "" || name === "." || name === "..") return "a path segment is empty, . or ..";
  if (name.includes("/") || name.includes("\\")) return "a name holds a path separator";
  if (hasControl(name)) return "a name holds a control character";
  if (hfsIs(name, ".git") || isNtfsDotgit(name)) return "a folder or file named .git";
  if (hfsIs(name, ".gitmodules") || isNtfsDotGeneric(name, "gitmodules", "gi7eba")) {
    return "a .gitmodules file (submodules are not carried)";
  }
  return undefined;
}

/** Why the host would refuse a path, or undefined when every component is fine. */
export function pathRefusal(path: string): string | undefined {
  if (path.length === 0 || path.length > 1024) return "the path is empty or longer than 1024";
  for (const part of path.split("/")) {
    const why = componentRefusal(part);
    if (why !== undefined) return why;
  }
  return undefined;
}

/** Whether a host's fsck would refuse a path. */
export function hostRejectsPath(path: string): boolean {
  return pathRefusal(path) !== undefined;
}

/** `gitattributesLineLength`: fsck refuses a `.gitattributes` line of 2048 bytes or more. */
export const GITATTRIBUTES_LINE_MAX = 2048;
/** `gitattributesLarge`: fsck refuses a `.gitattributes` blob over 100 MiB. */
export const GITATTRIBUTES_MAX_BYTES = 100 * 1024 * 1024;

/** Whether a component is a `.gitattributes` name (any spelling git treats as one). */
export function isGitattributes(name: string): boolean {
  return hfsIs(name, ".gitattributes") || isNtfsDotGeneric(name, "gitattributes", "gi7d29");
}

/** Why the host would refuse a `.gitattributes` file's content, or undefined. */
export function gitattributesRefusal(bytes: Uint8Array): string | undefined {
  if (bytes.length > GITATTRIBUTES_MAX_BYTES) return ".gitattributes is larger than 100 MiB";
  let start = 0;
  for (let i = 0; i <= bytes.length; i += 1) {
    if (i === bytes.length || bytes[i] === 0x0a) {
      if (i - start >= GITATTRIBUTES_LINE_MAX)
        return "a .gitattributes line is 2048 bytes or longer";
      start = i + 1;
    }
  }
  return undefined;
}
