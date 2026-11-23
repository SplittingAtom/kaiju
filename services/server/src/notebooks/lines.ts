/**
 * Run selection (KOBE-805): the member runs some lines of a saved `.py` file. The server still
 * reads the saved file (the body names lines, never code), keeps lines `start`..`end` (1-based,
 * inclusive, stopping at the file's end) and removes their common leading whitespace, so a block
 * selected inside a function runs on its own. Lines keep their order and count, so an error's
 * line in the selection plus `start - 1` is its line in the file.
 */
export interface LineRange {
  readonly start: number;
  readonly end: number;
}

/** The selected code, or null when the range holds no code (past the end, or blank lines). */
export function selectLines(text: string, range: LineRange): string | null {
  const lines = text.split(/\r?\n/u);
  const picked = lines.slice(range.start - 1, range.end);
  if (picked.every((l) => l.trim() === "")) return null;
  const indents = picked.filter((l) => l.trim() !== "").map((l) => /^[ \t]*/u.exec(l)?.[0] ?? "");
  const common = indents.reduce((a, b) => {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return a.slice(0, i);
  });
  return picked
    .map((l) => (l.startsWith(common) ? l.slice(common.length) : l.trimStart()))
    .join("\n");
}
