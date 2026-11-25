/**
 * The context viewer's formatted text (KOBE-841): a line is a list of tokens, each a kind and its
 * text. The viewer renders every token as a React text node in a span whose class names the kind,
 * so nothing a context holds ever becomes markup.
 */
export type TokenKind =
  "plain" | "key" | "string" | "number" | "literal" | "punct" | "comment" | "tag" | "attr" | "meta";

export interface Token {
  readonly kind: TokenKind;
  readonly text: string;
}

export type FormattedLine = readonly Token[];

export const tok = (kind: TokenKind, text: string): Token => ({ kind, text });

/** Spaces for `depth` levels of two. */
export const indent = (depth: number): Token => tok("plain", "  ".repeat(depth));

/** A line's text, as search sees it. */
export const lineText = (line: FormattedLine): string => line.map((t) => t.text).join("");

/** Text lines as plain tokens (the fallback, and text between formatted blocks). */
export const plainLines = (text: string): FormattedLine[] =>
  text.split("\n").map((l) => (l === "" ? [] : [tok("plain", l)]));

/** `line` cut into pieces of at most `columns` characters, tokens split where a cut falls. */
export function wrapLine(line: FormattedLine, columns: number): FormattedLine[] {
  if (lineText(line).length <= columns) return [line];
  const out: Token[][] = [[]];
  let room = columns;
  for (const t of line) {
    let rest = t.text;
    while (rest.length > 0) {
      if (room === 0) {
        out.push([]);
        room = columns;
      }
      const piece = rest.slice(0, room);
      out[out.length - 1]?.push(tok(t.kind, piece));
      rest = rest.slice(piece.length);
      room -= piece.length;
    }
  }
  return out;
}
