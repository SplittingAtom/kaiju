/**
 * Readable formatting for the context viewer (KOBE-841): finds YAML, XML, HTML and JSON in a
 * section's text, as the whole text or as blocks inside it (YAML front matter, fenced code blocks,
 * tagged blocks such as the system prompt's `<rules>…</rules>`), and formats them as token lines.
 * Everything else, and anything that fails to parse, stays plain text, line for line. Pure and
 * synchronous; the viewer only formats a section when it is shown expanded, and caches the result.
 */
import { formatJson, formatYaml } from "./data";
import { formatMarkup, markupModeOf } from "./markup";
import { plainLines, tok, type FormattedLine } from "./tokens";

export { lineText, wrapLine, type FormattedLine, type Token, type TokenKind } from "./tokens";

/** Longer texts are shown plain (formatting stays fast on large contexts). */
export const FORMAT_MAX_CHARS = 64 * 1024;

export type SegmentKind = "text" | "yaml" | "json" | "xml" | "html";

export interface Segment {
  readonly kind: SegmentKind;
  readonly text: string;
  /** A fence's opening and closing lines (front matter `---`, a code fence), shown around it. */
  readonly fence?: { readonly open: string; readonly close: string };
}

const FENCE_LANGS: Readonly<Record<string, SegmentKind>> = {
  yaml: "yaml",
  yml: "yaml",
  json: "json",
  xml: "xml",
  svg: "xml",
  html: "html",
  htm: "html",
};

/** Whole-text YAML: every line a key, a list item, a comment or deeper than the first. */
function looksLikeYaml(text: string): boolean {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  if (lines.length < 2) return false;
  const first = lines[0] ?? "";
  if (!/^(?:[\w"'][^:]*:(?:\s|$)|- )/.test(first)) return false;
  return lines.every((l) => /^(?:\s+\S|#|- |-$|[\w"'][^:]*:(?:\s|$))/.test(l));
}

/** The text as a whole, when it is one format. */
function wholeKind(text: string): SegmentKind | null {
  const t = text.trim();
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
    return "json";
  }
  if (t.startsWith("<") && t.endsWith(">")) return markupModeOf(t);
  if (looksLikeYaml(t)) return "yaml";
  return null;
}

const TAG_START = /^\s*<([A-Za-z_][\w:.-]*)[\s>/]/;
const TAG_NAME = /^[A-Za-z_][\w:.-]*$/;
const LANG = /^[\w-]*$/;

/**
 * A code fence line (```` ```yaml ````, `~~~`), read by hand so a hostile line costs one pass (a
 * regex with adjacent optional whitespace backtracks quadratically on long blank runs).
 */
export function parseFence(
  line: string,
): { readonly marker: string; readonly lang: string } | null {
  const t = line.trim();
  const c = t.charAt(0);
  if (c !== "`" && c !== "~") return null;
  let n = 0;
  while (t.charAt(n) === c) n++;
  if (n < 3) return null;
  const lang = t.slice(n).trimStart();
  return LANG.test(lang) ? { marker: t.slice(0, n), lang } : null;
}

/** The name of the closing tag a line ends with (`… </rules>`), if any. */
function closingTagOf(line: string): string | null {
  const t = line.trimEnd();
  if (!t.endsWith(">")) return null;
  const at = t.lastIndexOf("</");
  if (at < 0 || t.length - at > 260) return null;
  const name = t.slice(at + 2, -1);
  return TAG_NAME.test(name) ? name : null;
}

/** Line numbers by what they close (a fence marker, a tag), built in one pass. */
function indexClosers(lines: readonly string[]): Map<string, number[]> {
  const closers = new Map<string, number[]>();
  const add = (key: string, i: number) => {
    const list = closers.get(key);
    if (list === undefined) closers.set(key, [i]);
    else list.push(i);
  };
  lines.forEach((line, i) => {
    const fence = parseFence(line);
    if (fence !== null && fence.lang === "") add(`f${fence.marker}`, i);
    const tag = closingTagOf(line);
    if (tag !== null) add(`t${tag}`, i);
  });
  return closers;
}

/** The first entry of an ascending list above `i` (binary search); -1 when none. */
function nextAfter(list: readonly number[] | undefined, i: number): number {
  if (list === undefined) return -1;
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((list[mid] ?? -1) > i) hi = mid;
    else lo = mid + 1;
  }
  return list[lo] ?? -1;
}

/** The text cut into plain text and blocks of a known format. Linear in the text's length. */
export function segmentText(text: string): Segment[] {
  const whole = wholeKind(text);
  if (whole !== null) return [{ kind: whole, text }];
  const lines = text.split("\n");
  const closers = indexClosers(lines);
  const out: Segment[] = [];
  let plain: string[] = [];
  const flush = () => {
    if (plain.length > 0) out.push({ kind: "text", text: plain.join("\n") });
    plain = [];
  };
  let i = 0;
  if (lines[0] === "---") {
    const close = lines.indexOf("---", 1);
    if (close > 1) {
      out.push({
        kind: "yaml",
        text: lines.slice(1, close).join("\n"),
        fence: { open: "---", close: "---" },
      });
      i = close + 1;
    }
  }
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const fence = parseFence(line);
    if (fence !== null) {
      const kind = FENCE_LANGS[fence.lang.toLowerCase()];
      const close = kind === undefined ? -1 : nextAfter(closers.get(`f${fence.marker}`), i);
      if (kind !== undefined && close > i) {
        flush();
        out.push({
          kind,
          text: lines.slice(i + 1, close).join("\n"),
          fence: { open: line, close: lines[close] ?? fence.marker },
        });
        i = close + 1;
        continue;
      }
    }
    const tag = TAG_START.exec(line.slice(0, 300));
    if (tag !== null) {
      const close = nextAfter(closers.get(`t${tag[1] ?? ""}`), i);
      if (close > i) {
        flush();
        const block = lines.slice(i, close + 1).join("\n");
        out.push({ kind: markupModeOf(block), text: block });
        i = close + 1;
        continue;
      }
    }
    plain.push(line);
    i++;
  }
  flush();
  return out;
}

function formatSegment(s: Segment): FormattedLine[] {
  let lines: FormattedLine[] | null = null;
  if (s.kind === "yaml") lines = formatYaml(s.text);
  else if (s.kind === "json") lines = formatJson(s.text);
  else if (s.kind === "xml" || s.kind === "html") {
    lines = formatMarkup(s.text, s.kind);
    // A tagged block in prose that is not well-formed XML may still read as HTML.
    if (lines === null && s.kind === "xml") lines = formatMarkup(s.text, "html");
  }
  const body = lines ?? plainLines(s.text);
  if (s.fence === undefined) return body;
  return [[tok("meta", s.fence.open)], ...body, [tok("meta", s.fence.close)]];
}

/**
 * A section's text as formatted lines: each block in its format, everything else as written.
 * Texts over `FORMAT_MAX_CHARS`, and any text a formatter fails on, are returned plain. Never
 * throws.
 */
export function formatText(text: string): FormattedLine[] {
  if (text.length > FORMAT_MAX_CHARS) return plainLines(text);
  try {
    return segmentText(text).flatMap(formatSegment);
  } catch {
    // Never let a hostile text break the panel: anything unexpected shows as written.
    return plainLines(text);
  }
}
