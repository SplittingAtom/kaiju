/**
 * YAML and JSON for the context viewer (KOBE-841). YAML is parsed with the `yaml` package (already
 * a web dependency) as a document only: its core schema has no code-running tags, aliases are
 * never expanded (the document is printed back, not converted to values), and a document with any
 * error or a lone scalar is not formatted. The printed text is then coloured line by line.
 */
import { isMap, isSeq, parseDocument } from "yaml";
import { tok, type FormattedLine, type Token } from "./tokens";

const LITERAL = /^(?:true|false|null|~|yes|no|on|off)$/i;
const NUMBER = /^[-+]?(?:\d[\d_]*(?:\.\d*)?(?:e[-+]?\d+)?|\.\d+|0x[\da-f]+|0o[0-7]+|\.inf|\.nan)$/i;

/** A scalar's kind by how it is written. */
function scalar(text: string): Token {
  const t = text.trim();
  if (t.startsWith('"') || t.startsWith("'")) return tok("string", text);
  if (NUMBER.test(t)) return tok("number", text);
  if (LITERAL.test(t)) return tok("literal", text);
  if (t === "|" || t === ">" || /^[|>][-+]?\d?$/.test(t)) return tok("punct", text);
  if (t.startsWith("&") || t.startsWith("*") || t.startsWith("!")) return tok("meta", text);
  return tok("string", text);
}

/** A value after `key:` or `- `, with a trailing comment set apart. */
function value(rest: string): Token[] {
  if (rest === "") return [];
  const comment = /\s#.*$/.exec(rest);
  const body = comment !== null && !/^\s*["']/.test(rest) ? rest.slice(0, comment.index) : rest;
  const out = [scalar(body)];
  if (body !== rest) out.push(tok("comment", rest.slice(body.length)));
  return out;
}

const KEY_LINE = /^((?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"\-?:][^:#]*?|\?))(:)(\s.*|)$/;

/** Printed YAML coloured: keys, scalars, comments, sequence dashes, block scalars as strings. */
export function colourYaml(text: string): FormattedLine[] {
  const out: FormattedLine[] = [];
  let block: number | null = null; // the indentation a block scalar's lines are deeper than
  for (const line of text.replace(/\n$/, "").split("\n")) {
    const lead = /^\s*/.exec(line)?.[0] ?? "";
    let rest = line.slice(lead.length);
    if (block !== null && (rest === "" || lead.length > block)) {
      out.push(rest === "" ? [] : [tok("plain", lead), tok("string", rest)]);
      continue;
    }
    block = null;
    const tokens: Token[] = [tok("plain", lead)];
    let depth = lead.length;
    while (rest.startsWith("- ") || rest === "-") {
      tokens.push(tok("punct", rest.slice(0, 2)));
      rest = rest.slice(2);
      depth += 2;
    }
    if (rest.startsWith("#")) {
      tokens.push(tok("comment", rest));
    } else if (rest === "---" || rest === "...") {
      tokens.push(tok("punct", rest));
    } else {
      const kv = KEY_LINE.exec(rest);
      if (kv !== null) {
        const [, key = "", colon = "", after = ""] = kv;
        tokens.push(tok("key", key), tok("punct", colon));
        if (after.length > 0) tokens.push(tok("plain", " "), ...value(after.slice(1)));
        if (/^\s*[|>][-+]?\d?\s*$/.test(after)) block = depth;
      } else {
        tokens.push(...value(rest));
        if (/^[|>][-+]?\d?$/.test(rest.trim())) block = depth - 2;
      }
    }
    out.push(tokens.filter((t) => t.text !== ""));
  }
  return out;
}

/** Longer YAML is shown as written: the parser takes about 2 ms a KiB. */
export const YAML_MAX_CHARS = 16 * 1024;

/** YAML (a mapping or a sequence) printed with two-space indents and coloured; null otherwise. */
export function formatYaml(src: string): FormattedLine[] | null {
  if (src.length > YAML_MAX_CHARS) return null;
  let doc;
  try {
    doc = parseDocument(src, { prettyErrors: false, uniqueKeys: false });
  } catch {
    return null;
  }
  if (doc.errors.length > 0 || !(isMap(doc.contents) || isSeq(doc.contents))) return null;
  let printed: string;
  try {
    printed = doc.toString({ indent: 2, lineWidth: 0 });
  } catch {
    return null;
  }
  return colourYaml(printed);
}

/** Deeper JSON than this is shown as written (printing it back would overflow the stack). */
export const MAX_JSON_DEPTH = 64;

/** The deepest bracket nesting of a JSON text, strings skipped; one pass. */
export function jsonDepth(src: string): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    if (inString) {
      if (c === 92)
        i++; // backslash: skip the escaped character
      else if (c === 34) inString = false;
    } else if (c === 34) inString = true;
    else if (c === 91 || c === 123) max = Math.max(max, ++depth);
    else if (c === 93 || c === 125) depth--;
  }
  return max;
}

const JSON_LINE = /^(\s*)(?:("(?:[^"\\]|\\.)*")(: ))?(.*?)(,?)$/;

/** JSON (an object or an array) printed with two-space indents and coloured; null otherwise. */
export function formatJson(src: string): FormattedLine[] | null {
  const t = src.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return null;
  if (jsonDepth(t) > MAX_JSON_DEPTH) return null;
  let printed: string;
  try {
    printed = JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return null;
  }
  return printed.split("\n").map((line) => {
    const [, lead = "", key, colon, val = "", comma = ""] = JSON_LINE.exec(line) ?? [];
    const tokens: Token[] = [tok("plain", lead)];
    if (key !== undefined) tokens.push(tok("key", key), tok("punct", colon ?? ""));
    if (/^[[\]{}]+$/.test(val)) tokens.push(tok("punct", val));
    else if (val !== "") tokens.push(scalar(val));
    tokens.push(tok("punct", comma));
    return tokens.filter((x) => x.text !== "");
  });
}
