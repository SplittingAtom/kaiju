import { MEMORY_INDEX_MAX_LINES } from "@kobe/protocol";
import { lineCount } from "../store.js";

/**
 * Add to project notes (KOBE-398, SM7): where a statement lands in the project's `MEMORY.md`.
 * Pure, so the preview the person approves and the write at click compute the same text.
 *
 * - The statement becomes one list line (`- …`): whitespace collapsed, so it can never start a
 *   heading or break the file's structure.
 * - It goes at the end of the first `## Learned` section (up to the next `#` or `##` heading; deeper
 *   headings stay inside), after its last non-blank line.
 * - A file without the section gets one at its end, after a blank line.
 */

export const LEARNED_HEADING = "## Learned";
const LEARNED = /^##\s+learned\s*$/i;
const SECTION_END = /^#{1,2}\s/;

export function learnedLine(statement: string): string {
  const text = statement
    .replace(/\s+/g, " ")
    .trim()
    // A renderer must not hide later lines: no raw HTML start (`<!--`, `<details>`) and no code
    // spans or fences.
    .replace(/^</, "\\<")
    .replace(/`/g, "\\`");
  return `- ${text}`;
}

export function appendLearned(content: string, line: string): string {
  const lines = content === "" ? [] : content.replace(/\n$/, "").split("\n");
  const start = lines.findIndex((l) => LEARNED.test(l));
  if (start === -1) {
    const lead = lines.length === 0 ? [] : [...lines, ""];
    return `${[...lead, LEARNED_HEADING, "", line].join("\n")}\n`;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (SECTION_END.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  let at = end;
  while (at > start + 1 && (lines[at - 1] ?? "").trim() === "") at -= 1;
  return `${[...lines.slice(0, at), line, ...lines.slice(at)].join("\n")}\n`;
}

/** Whether the index can take one more line (the click checks the exact result again). */
export function indexHasRoom(content: string): boolean {
  return lineCount(content) + 1 <= MEMORY_INDEX_MAX_LINES;
}

/** Whether the file with the line added still fits the index's line cap. */
export function fitsIndex(content: string): boolean {
  return lineCount(content) <= MEMORY_INDEX_MAX_LINES;
}
