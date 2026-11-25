"use client";

import type { ReactNode } from "react";
import type { FormattedLine, TokenKind } from "../../lib/chat/context-format";
import { splitMatches } from "../../lib/chat/context-viewer";
import styles from "./context-viewer.module.css";

const TOKEN_CLASS: Readonly<Record<TokenKind, string | undefined>> = {
  plain: undefined,
  key: styles.tkKey,
  string: styles.tkString,
  number: styles.tkNumber,
  literal: styles.tkLiteral,
  punct: styles.tkPunct,
  comment: styles.tkComment,
  tag: styles.tkTag,
  attr: styles.tkAttr,
  meta: styles.tkMeta,
};

/** `text` with each match of `query` marked; plain text only. */
export function highlighted(text: string, query: string): ReactNode {
  return splitMatches(text, query).map((part, i) =>
    part.hit ? <mark key={i}>{part.text}</mark> : part.text,
  );
}

/**
 * One formatted line (KOBE-841): each token a span whose class colours its kind, its text a React
 * text node. Context text is untrusted (tool output, files, web pages): it never becomes markup.
 */
export function TokenLine({
  tokens,
  query,
}: {
  readonly tokens: FormattedLine;
  readonly query: string;
}) {
  return tokens.map((t, i) => {
    const cls = TOKEN_CLASS[t.kind];
    const body = highlighted(t.text, query);
    return cls === undefined ? (
      <span key={i}>{body}</span>
    ) : (
      <span key={i} className={cls} data-token={t.kind}>
        {body}
      </span>
    );
  });
}
