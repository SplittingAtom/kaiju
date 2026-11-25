/**
 * XML and HTML for the context viewer (KOBE-841): a small tokenizer and tree builder of its own,
 * written to only ever produce text. It resolves nothing: no entity is expanded (`&amp;` and
 * `&xxe;` stay as written), a DOCTYPE and its internal subset are shown as one declaration and
 * never read, nothing is fetched, nothing runs. `<script>` and `<style>` bodies are text. The
 * result is a pretty-printed tree as token lines; null when the input is not well-formed enough
 * (XML: every tag closed in order; HTML: lenient, as browsers are), and the caller shows plain
 * text instead.
 */
import { indent, tok, type FormattedLine, type Token } from "./tokens";

export type MarkupMode = "xml" | "html";

interface Attr {
  readonly name: string;
  /** The value as written, quotes included; null for a bare attribute. */
  readonly value: string | null;
}

type Node =
  | {
      readonly type: "element";
      name: string;
      attrs: readonly Attr[];
      children: Node[];
      /** Written `<x/>` (or an HTML void element). */
      self: boolean;
    }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "comment" | "meta"; readonly text: string };

/** Above this many nodes the input is shown as plain text (formatting stays fast). */
export const MAX_NODES = 20_000;
/** Deeper trees than this are shown as plain text. */
export const MAX_DEPTH = 64;
/** An element whose only child is a text this short stays on one line. */
const INLINE_TEXT = 80;

const NAME = /^[A-Za-z_][\w:.-]*/;

const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

/** Elements whose body HTML reads as text (shown, never run). */
const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);

/** Common HTML elements: a root among these is read as HTML. */
export const HTML_TAGS = new Set([
  ...VOID,
  ...RAW_TEXT,
  "a",
  "abbr",
  "article",
  "aside",
  "b",
  "blockquote",
  "body",
  "button",
  "code",
  "div",
  "em",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "header",
  "html",
  "i",
  "iframe",
  "label",
  "li",
  "main",
  "nav",
  "noscript",
  "object",
  "ol",
  "option",
  "p",
  "pre",
  "section",
  "select",
  "small",
  "span",
  "strong",
  "svg",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
]);

type Lexeme =
  | { readonly type: "open"; readonly name: string; readonly attrs: Attr[]; readonly self: boolean }
  | { readonly type: "close"; readonly name: string }
  | { readonly type: "text" | "comment" | "meta"; readonly text: string };

/** The attributes of an open tag from `at` (after its name); null when malformed. */
function readTag(src: string, at: number): { attrs: Attr[]; self: boolean; end: number } | null {
  const attrs: Attr[] = [];
  let i = at;
  for (;;) {
    while (i < src.length && /\s/.test(src.charAt(i))) i++;
    if (i >= src.length) return null;
    if (src.startsWith("/>", i)) return { attrs, self: true, end: i + 2 };
    if (src.charAt(i) === ">") return { attrs, self: false, end: i + 1 };
    const name = /^[^\s"'<>/=]+/.exec(src.slice(i, i + 256));
    if (name === null) return null;
    i += name[0].length;
    while (i < src.length && /\s/.test(src.charAt(i))) i++;
    if (src.charAt(i) !== "=") {
      attrs.push({ name: name[0], value: null });
      continue;
    }
    i++;
    while (i < src.length && /\s/.test(src.charAt(i))) i++;
    const q = src.charAt(i);
    if (q === '"' || q === "'") {
      const close = src.indexOf(q, i + 1);
      if (close < 0) return null;
      attrs.push({ name: name[0], value: src.slice(i, close + 1) });
      i = close + 1;
    } else {
      const bare = /^[^\s"'<>=`]+/.exec(src.slice(i, i + 4096));
      if (bare === null) return null;
      attrs.push({ name: name[0], value: bare[0] });
      i += bare[0].length;
    }
  }
}

/** A `<!DOCTYPE …>`'s end, past an internal subset in brackets (shown, never read). */
function declarationEnd(src: string, at: number): number {
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    const c = src.charAt(i);
    if (c === "[") depth++;
    else if (c === "]") depth = Math.max(0, depth - 1);
    else if (c === ">" && depth === 0) return i + 1;
  }
  return -1;
}

/** Cuts `src` into tags, text, comments and declarations; null when a construct never ends. */
function lex(src: string, mode: MarkupMode): Lexeme[] | null {
  const out: Lexeme[] = [];
  let i = 0;
  let text = 0;
  const flush = (to: number) => {
    if (to > text) out.push({ type: "text", text: src.slice(text, to) });
  };
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) break;
    const rest = src.slice(lt, lt + 9);
    let end = -1;
    let lexeme: Lexeme | null = null;
    if (rest.startsWith("<!--")) {
      const close = src.indexOf("-->", lt + 4);
      if (close < 0) return null;
      end = close + 3;
      lexeme = { type: "comment", text: src.slice(lt, end) };
    } else if (rest.startsWith("<![CDATA[")) {
      const close = src.indexOf("]]>", lt + 9);
      if (close < 0) return null;
      end = close + 3;
      lexeme = { type: "meta", text: src.slice(lt, end) };
    } else if (rest.startsWith("<!") || rest.startsWith("<?")) {
      end = rest.startsWith("<?") ? src.indexOf("?>", lt + 2) + 2 : declarationEnd(src, lt + 2);
      if (end <= 1) return null;
      lexeme = { type: "meta", text: src.slice(lt, end) };
    } else if (rest.startsWith("</")) {
      const name = NAME.exec(src.slice(lt + 2, lt + 258));
      const close = name === null ? -1 : src.indexOf(">", lt + 2 + name[0].length);
      if (name !== null && close >= 0 && src.slice(lt + 2 + name[0].length, close).trim() === "") {
        end = close + 1;
        lexeme = { type: "close", name: name[0] };
      }
    } else {
      const name = NAME.exec(src.slice(lt + 1, lt + 257));
      const tag = name === null ? null : readTag(src, lt + 1 + name[0].length);
      if (name !== null && tag !== null) {
        end = tag.end;
        lexeme = { type: "open", name: name[0], attrs: tag.attrs, self: tag.self };
      } else if (name !== null && mode === "xml") {
        return null;
      }
    }
    if (lexeme === null) {
      i = lt + 1; // a lone "<" is text
      continue;
    }
    flush(lt);
    out.push(lexeme);
    i = text = end;
    if (lexeme.type === "open" && !lexeme.self && RAW_TEXT.has(lexeme.name.toLowerCase())) {
      // The body up to its closing tag is text: shown, never parsed or run.
      const close = src.toLowerCase().indexOf(`</${lexeme.name.toLowerCase()}`, end);
      if (close < 0) {
        if (mode === "xml") return null;
        break;
      }
      flush(close);
      i = text = close;
    }
  }
  flush(src.length);
  return out;
}

const element = (
  name: string,
  attrs: readonly Attr[],
  self = false,
): Node & { type: "element" } => ({ type: "element", name, attrs, children: [], self });

/** The tree of `src`; null when it is not markup this mode accepts. */
export function parseMarkup(src: string, mode: MarkupMode): Node[] | null {
  const lexemes = lex(src, mode);
  if (lexemes === null || lexemes.length > MAX_NODES) return null;
  const root = element("", []);
  const stack: (Node & { type: "element" })[] = [root];
  let elements = 0;
  for (const l of lexemes) {
    const top = stack[stack.length - 1] ?? root;
    if (l.type === "open") {
      elements++;
      const isVoid = mode === "html" && VOID.has(l.name.toLowerCase());
      const el = element(l.name, l.attrs, l.self || isVoid);
      top.children.push(el);
      if (!l.self && !isVoid) {
        if (stack.length > MAX_DEPTH) return null;
        stack.push(el);
      }
    } else if (l.type === "close") {
      const same = (n: string) =>
        mode === "html" ? n.toLowerCase() === l.name.toLowerCase() : n === l.name;
      if (mode === "xml") {
        if (stack.length < 2 || !same(top.name)) return null;
        stack.pop();
      } else {
        const at = stack.findLastIndex((e, k) => k > 0 && same(e.name));
        if (at > 0) stack.length = at; // unmatched closes are ignored, as browsers do
      }
    } else {
      top.children.push(l);
    }
  }
  if (mode === "xml" && stack.length !== 1) return null;
  return elements === 0 ? null : root.children;
}

function openTag(el: { name: string; attrs: readonly Attr[] }, self: boolean): Token[] {
  const out: Token[] = [tok("punct", "<"), tok("tag", el.name)];
  for (const a of el.attrs) {
    out.push(tok("plain", " "), tok("attr", a.name));
    if (a.value !== null) out.push(tok("punct", "="), tok("string", a.value));
  }
  out.push(tok("punct", self ? " />" : ">"));
  return out;
}

const closeTag = (name: string): Token[] => [
  tok("punct", "</"),
  tok("tag", name),
  tok("punct", ">"),
];

/** A text's lines, its common indentation and blank edges removed; none when only whitespace. */
function textLines(text: string): string[] {
  const lines = text.split("\n").map((l) => l.trimEnd());
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const lead = Math.min(
    ...lines.filter((l) => l !== "").map((l) => /^\s*/.exec(l)?.[0].length ?? 0),
  );
  return lines.map((l) => l.slice(Number.isFinite(lead) ? lead : 0));
}

function render(nodes: readonly Node[], depth: number, out: Token[][]): void {
  for (const n of nodes) {
    if (n.type === "text") {
      for (const l of textLines(n.text)) out.push(l === "" ? [] : [indent(depth), tok("plain", l)]);
    } else if (n.type !== "element") {
      for (const l of n.text.split("\n")) out.push([indent(depth), tok(n.type, l.trim())]);
    } else if (n.children.length === 0) {
      out.push([indent(depth), ...openTag(n, n.self), ...(n.self ? [] : closeTag(n.name))]);
    } else {
      const only = n.children.length === 1 ? n.children[0] : undefined;
      const inline = only?.type === "text" ? only.text.trim() : null;
      if (inline !== null && inline.length <= INLINE_TEXT && !inline.includes("\n")) {
        out.push([indent(depth), ...openTag(n, false), tok("plain", inline), ...closeTag(n.name)]);
        continue;
      }
      out.push([indent(depth), ...openTag(n, false)]);
      render(n.children, depth + 1, out);
      out.push([indent(depth), ...closeTag(n.name)]);
    }
  }
}

/** `src` pretty-printed as token lines; null when it does not parse in this mode. */
export function formatMarkup(src: string, mode: MarkupMode): FormattedLine[] | null {
  const tree = parseMarkup(src, mode);
  if (tree === null) return null;
  const out: Token[][] = [];
  render(tree, 0, out);
  return out.map((line) => line.filter((t) => t.text !== ""));
}

/** HTML when it declares itself so or its first element is a common HTML one; XML otherwise. */
export function markupModeOf(src: string): MarkupMode {
  const head = src.trimStart().slice(0, 512);
  if (/^<!doctype\s+html/i.test(head)) return "html";
  const first = /<([A-Za-z][\w:.-]*)/.exec(head);
  return first !== null && HTML_TAGS.has(first[1]?.toLowerCase() ?? "") ? "html" : "xml";
}
