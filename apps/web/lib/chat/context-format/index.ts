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

/** The text cut into plain text and blocks of a known format. */
export function segmentText(text: string): Segment[] {
  const whole = wholeKind(text);
  if (whole !== null) return [{ kind: whole, text }];
  const lines = text.split("\n");
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
    const fence = /^\s*(```+|~~~+)\s*([\w-]*)\s*$/.exec(line);
    if (fence !== null) {
      const marker = fence[1] ?? "```";
      const close = lines.findIndex((l, k) => k > i && l.trim() === marker);
      const kind = FENCE_LANGS[(fence[2] ?? "").toLowerCase()];
      if (close > i && kind !== undefined) {
        flush();
        out.push({
          kind,
          text: lines.slice(i + 1, close).join("\n"),
          fence: { open: line, close: lines[close] ?? marker },
        });
        i = close + 1;
        continue;
      }
    }
    const tag = TAG_START.exec(line);
    if (tag !== null) {
      const closing = `</${tag[1] ?? ""}>`;
      const close = lines.findIndex((l, k) => k > i && l.trimEnd().endsWith(closing));
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
 * Texts over `FORMAT_MAX_CHARS` are returned plain.
 */
export function formatText(text: string): FormattedLine[] {
  if (text.length > FORMAT_MAX_CHARS) return plainLines(text);
  return segmentText(text).flatMap(formatSegment);
}
