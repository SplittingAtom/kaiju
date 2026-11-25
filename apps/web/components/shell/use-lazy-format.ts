"use client";

import type { ContextSection } from "@kaiju/protocol";
import { useCallback, useMemo, useState } from "react";
import { formatText, type FormattedLine } from "../../lib/chat/context-format";
import { plainLines } from "../../lib/chat/context-format/tokens";

const NONE: ReadonlySet<number> = new Set();

/**
 * Lazy formatting for the context text (KOBE-841): a section is formatted only once one of its
 * rows comes near the viewport while it is expanded in the Formatted view (`reveal`), then cached
 * until the sections change (a Refresh). Opening a 2 MiB context formats one screenful, not the
 * whole context. Formatting never throws: a failure shows the section as written.
 */
export function useLazyFormat(sections: readonly ContextSection[]) {
  const format = useMemo(() => {
    const cache = new Map<number, readonly FormattedLine[]>();
    return (section: number): readonly FormattedLine[] => {
      let lines = cache.get(section);
      if (lines === undefined) {
        const text = sections[section]?.text ?? "";
        try {
          lines = formatText(text);
        } catch {
          lines = plainLines(text);
        }
        cache.set(section, lines);
      }
      return lines;
    };
  }, [sections]);
  const [state, setState] = useState(() => ({ sections, formatted: NONE }));
  if (state.sections !== sections) setState({ sections, formatted: NONE });
  const formatted = state.sections === sections ? state.formatted : NONE;
  /** Marks these sections for formatting (the ones now near the viewport). */
  const reveal = useCallback(
    (ids: readonly number[]) =>
      setState((prev) => {
        const base = prev.sections === sections ? prev.formatted : NONE;
        const fresh = ids.filter((i) => !base.has(i));
        if (fresh.length === 0 && prev.sections === sections) return prev;
        return { sections, formatted: new Set([...base, ...fresh]) };
      }),
    [sections],
  );
  return { format, formatted, reveal };
}
