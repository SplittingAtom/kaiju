"use client";

/**
 * Find in a PDF (KOBE-801): every page's text is read once (pdf.js text content, the same items
 * the text layer draws as spans), searched case-insensitively, and the matches are kept per page
 * with one current match that Previous and Next move through, wrapping at the ends.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PdfDocument } from "../../lib/files/pdfjs";
import { findInItems, type TextMatch } from "../../lib/files/viewer";

/** Typing pauses this long before a search starts. */
const FIND_DELAY_MS = 200;

export interface FindHit {
  readonly page: number;
  /** Its index among the page's matches. */
  readonly index: number;
}

export interface PdfFind {
  readonly query: string;
  setQuery(query: string): void;
  readonly searching: boolean;
  readonly total: number;
  /** 0-based index into all matches, or null when there are none. */
  readonly current: number | null;
  readonly hit: FindHit | null;
  matchesOn(page: number): readonly TextMatch[];
  selectedOn(page: number): number | null;
  next(): void;
  previous(): void;
  clear(): void;
}

const NONE: readonly TextMatch[] = [];

async function pageItems(doc: PdfDocument, page: number): Promise<string[]> {
  const content = await (await doc.getPage(page)).getTextContent();
  return content.items.flatMap((i) => ("str" in i ? [i.str] : []));
}

/** Searches pages 1..`count` (the viewer's page cap). */
export function usePdfFind(doc: PdfDocument | null, count: number): PdfFind {
  const [query, setQuery] = useState("");
  const [byPage, setByPage] = useState<ReadonlyMap<number, readonly TextMatch[]>>(new Map());
  const [searching, setSearching] = useState(false);
  const [current, setCurrent] = useState<number | null>(null);
  const texts = useRef(new Map<number, Promise<string[]>>());

  useEffect(() => {
    texts.current = new Map();
  }, [doc]);

  useEffect(() => {
    if (!doc || query.trim() === "") {
      setByPage(new Map());
      setCurrent(null);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      void (async () => {
        const found = new Map<number, readonly TextMatch[]>();
        for (let page = 1; page <= count && !cancelled; page++) {
          let items = texts.current.get(page);
          if (!items) {
            items = pageItems(doc, page).catch(() => []);
            texts.current.set(page, items);
          }
          const matches = findInItems(await items, query);
          if (matches.length > 0) found.set(page, matches);
        }
        if (cancelled) return;
        setByPage(found);
        setCurrent(found.size > 0 ? 0 : null);
        setSearching(false);
      })();
    }, FIND_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [doc, query, count]);

  /** Every match in reading order. */
  const hits = useMemo(() => {
    const all: FindHit[] = [];
    for (const page of [...byPage.keys()].sort((a, b) => a - b)) {
      (byPage.get(page) ?? NONE).forEach((_, index) => all.push({ page, index }));
    }
    return all;
  }, [byPage]);

  const total = hits.length;
  const hit = current === null ? null : (hits[current] ?? null);
  const step = useCallback(
    (by: number) => setCurrent((c) => (total === 0 ? null : ((c ?? 0) + by + total) % total)),
    [total],
  );
  return {
    query,
    setQuery,
    searching,
    total,
    current,
    hit,
    matchesOn: (page) => byPage.get(page) ?? NONE,
    selectedOn: (page) => (hit && hit.page === page ? hit.index : null),
    next: () => step(1),
    previous: () => step(-1),
    clear: () => setQuery(""),
  };
}
