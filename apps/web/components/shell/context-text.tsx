"use client";

import type { ContextSection } from "@kaiju/protocol";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { formatText, type FormattedLine } from "../../lib/chat/context-format";
import {
  GAUGE_LABELS,
  buildRows,
  findMatches,
  gaugeKindOf,
  readContextView,
  sectionHeading,
  visibleRange,
  writeContextView,
  type ContextView,
  type GaugeKind,
} from "../../lib/chat/context-viewer";
import { highlighted, TokenLine } from "./context-line";
import { ContextTextControls } from "./context-text-controls";
import styles from "./context-viewer.module.css";

/** One row's height in px: `.row` in context-viewer.module.css sets the same. */
const ROW_PX = 20;
/** The viewport assumed before it is measured (and where nothing is laid out). */
const FALLBACK_VIEWPORT = 800;

/**
 * Each section's formatted lines, made the first time the section is shown expanded in the
 * Formatted view and kept until the sections change (a Refresh): a large context formats only
 * what is opened.
 */
function useFormatCache(sections: readonly ContextSection[]) {
  return useMemo(() => {
    const cache = new Map<number, readonly FormattedLine[]>();
    return (section: number): readonly FormattedLine[] => {
      let lines = cache.get(section);
      if (lines === undefined) {
        lines = formatText(sections[section]?.text ?? "");
        cache.set(section, lines);
      }
      return lines;
    };
  }, [sections]);
}

/** The collapsed sections, cleared when the sections change (a Refresh). */
const NONE: ReadonlySet<number> = new Set();

function useCollapsed(sections: readonly ContextSection[]) {
  const [state, setState] = useState(() => ({ sections, collapsed: NONE }));
  if (state.sections !== sections) setState({ sections, collapsed: NONE });
  const collapsed = state.sections === sections ? state.collapsed : NONE;
  const set = (next: ReadonlySet<number>) => setState({ sections, collapsed: next });
  return {
    collapsed,
    toggle: (i: number) => {
      const next = new Set(collapsed);
      if (!next.delete(i)) next.add(i);
      set(next);
    },
    expandAll: () => set(new Set()),
    collapseAll: () => set(new Set(sections.map((_, i) => i))),
  };
}

/** What the live region says after the filter changes. */
function announce(filter: GaugeKind | null, count: number): string {
  if (filter === null) return "Showing every section.";
  const n = `${count} ${count === 1 ? "section" : "sections"}`;
  return `Showing only ${GAUGE_LABELS[filter]}: ${n}.`;
}

/**
 * The context's text (KOBE-471, KOBE-841): each section under a heading naming its kind and
 * tokens (a button that collapses it to the heading), its text in the Formatted view (YAML, XML,
 * HTML and JSON laid out and coloured, as text nodes only) or the Raw view (exactly as sent),
 * monospace, never Markdown or live HTML. Rows have one height and only those near the viewport
 * are rendered, so a context of thousands of sections scrolls lightly. A legend filter shows one
 * kind only. The search box marks matches and steps through them (Enter, Shift+Enter).
 */
export function ContextText({
  sections,
  filter,
  onClearFilter,
}: {
  readonly sections: readonly ContextSection[];
  /** Only sections of this kind (the legend's filter); null: all. */
  readonly filter: GaugeKind | null;
  readonly onClearFilter: () => void;
}) {
  const [view, setView] = useState<ContextView>(readContextView);
  const format = useFormatCache(sections);
  const { collapsed, toggle, expandAll, collapseAll } = useCollapsed(sections);
  const { rows } = useMemo(
    () =>
      buildRows(sections, {
        collapsed,
        filter,
        ...(view === "formatted" ? { format } : {}),
      }),
    [sections, collapsed, filter, view, format],
  );
  const shownCount = useMemo(
    () =>
      filter === null
        ? sections.length
        : sections.filter((s) => gaugeKindOf(s.kind) === filter).length,
    [sections, filter],
  );
  const pane = useRef<HTMLDivElement>(null);
  const viewportRef = useRef(FALLBACK_VIEWPORT);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(FALLBACK_VIEWPORT);
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState(0);
  // Each step bumps it, so stepping to the same match (the only one) scrolls to it again.
  const [stepSeq, setStepSeq] = useState(0);
  const matches = useMemo(() => findMatches(rows, query), [rows, query]);
  // New matches (another query, or a Refresh's text) start again at the first.
  const [seenMatches, setSeenMatches] = useState(matches);
  if (seenMatches !== matches) {
    setSeenMatches(matches);
    setCurrent(0);
  }
  const at = matches.length === 0 ? 0 : Math.min(current, matches.length - 1);

  // A new filter marks its kind's first section, at the top; the live region says what is shown.
  const [seenFilter, setSeenFilter] = useState(filter);
  const [announcement, setAnnouncement] = useState("");
  const active = filter === null ? null : sections.findIndex((s) => gaugeKindOf(s.kind) === filter);
  if (seenFilter !== filter) {
    setSeenFilter(filter);
    setAnnouncement(announce(filter, shownCount));
  }

  useEffect(() => {
    const el = pane.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const height = el.clientHeight || FALLBACK_VIEWPORT;
      viewportRef.current = height;
      setViewport(height);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const scrollToRow = useCallback((row: number, lead: number) => {
    const top = Math.max(0, row * ROW_PX - lead);
    if (pane.current) pane.current.scrollTop = top;
    setScrollTop(top);
  }, []);

  useEffect(() => {
    scrollToRow(0, 0);
  }, [filter, scrollToRow]);

  const onView = (next: ContextView) => {
    setView(next);
    writeContextView(next);
  };

  // The current match is brought into view, a third down from the top.
  const currentRow = matches[at];
  useEffect(() => {
    if (currentRow !== undefined) scrollToRow(currentRow, viewportRef.current / 3);
  }, [currentRow, stepSeq, scrollToRow]);

  const step = (by: number) => {
    if (matches.length === 0) return;
    setCurrent((at + by + matches.length) % matches.length);
    setStepSeq((n) => n + 1);
  };
  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    step(e.shiftKey ? -1 : 1);
  };

  const [start, end] = visibleRange({ scrollTop, viewport, rowPx: ROW_PX, count: rows.length });
  const q = query.trim();
  return (
    <div className={styles.textColumn}>
      <ContextTextControls
        view={view}
        onView={onView}
        onExpandAll={expandAll}
        onCollapseAll={collapseAll}
        filter={filter}
        filterCount={shownCount}
        onClearFilter={onClearFilter}
        announcement={announcement}
      />
      <div className={styles.search} role="search">
        <input
          type="search"
          aria-label="Search the context"
          placeholder="Search the context"
          className={styles.searchInput}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setCurrent(0);
          }}
          onKeyDown={onSearchKey}
        />
        {q !== "" && (
          <>
            <span className={styles.matches} role="status">
              {matches.length === 0 ? "No matches" : `${at + 1} of ${matches.length}`}
            </span>
            <button
              type="button"
              className={styles.smallButton}
              disabled={matches.length === 0}
              onClick={() => step(-1)}
            >
              Previous
            </button>
            <button
              type="button"
              className={styles.smallButton}
              disabled={matches.length === 0}
              onClick={() => step(1)}
            >
              Next
            </button>
          </>
        )}
      </div>
      <div
        ref={pane}
        role="region"
        aria-label="Context text"
        tabIndex={0}
        className={`${styles.pane} kaiju-panel`}
        data-context-view={view}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        {rows.length === 0 && (
          <p className={styles.empty} role="note">
            {filter === null
              ? "This context is empty."
              : `No ${GAUGE_LABELS[filter]} in this context.`}
          </p>
        )}
        <div className={styles.spacer} style={{ height: rows.length * ROW_PX }}>
          {rows.slice(start, end).map((row, k) => {
            const i = start + k;
            const s = sections[row.section];
            if (s === undefined) return null;
            if (row.type === "label") {
              const open = !collapsed.has(row.section);
              return (
                <div
                  key={i}
                  className={`${styles.row} ${styles.label}`}
                  data-kind={s.kind}
                  data-active={active === row.section || undefined}
                  style={{ top: i * ROW_PX }}
                >
                  <button
                    type="button"
                    className={styles.labelButton}
                    aria-expanded={open}
                    data-context-section={row.section}
                    onClick={() => toggle(row.section)}
                  >
                    {sectionHeading(s)}
                  </button>
                </div>
              );
            }
            return (
              <div
                key={i}
                className={`${styles.row} ${styles.line}`}
                data-current={i === currentRow || undefined}
                style={{ top: i * ROW_PX }}
              >
                {row.tokens === undefined ? (
                  highlighted(row.text, query)
                ) : (
                  <TokenLine tokens={row.tokens} query={query} />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
