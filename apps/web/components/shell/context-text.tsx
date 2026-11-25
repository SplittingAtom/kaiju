"use client";

import type { ContextSection } from "@kaiju/protocol";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
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
import { highlighted, LineBoundary, TokenLine } from "./context-line";
import { ContextTextControls } from "./context-text-controls";
import { useLazyFormat } from "./use-lazy-format";
import styles from "./context-viewer.module.css";

/** One row's height in px: `.row` in context-viewer.module.css sets the same. */
const ROW_PX = 20;
/** The viewport assumed before it is measured (and where nothing is laid out). */
const FALLBACK_VIEWPORT = 800;

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
  const { format, formatted, reveal } = useLazyFormat(sections);
  const { collapsed, toggle, expandAll, collapseAll } = useCollapsed(sections);
  const { rows, firstRow } = useMemo(
    () =>
      buildRows(sections, {
        collapsed,
        filter,
        ...(view === "formatted" ? { format, formatted } : {}),
      }),
    [sections, collapsed, filter, view, format, formatted],
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
  // Another query, or a Refresh's text, starts again at the first match (sections formatted as
  // they scroll into view change the rows, not the place in the matches).
  const [seen, setSeen] = useState({ query, sections });
  if (seen.query !== query || seen.sections !== sections) {
    setSeen({ query, sections });
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

  // Sections near the viewport, expanded and not yet formatted, are formatted now; the section at
  // the top of the viewport keeps its place while rows above or inside it change length.
  const anchor = useRef<{ section: number; offset: number } | null>(null);
  useLayoutEffect(() => {
    if (view !== "formatted") return;
    const ids = new Set<number>();
    for (let i = start; i < end; i++) {
      const row = rows[i];
      if (row !== undefined && !formatted.has(row.section) && !collapsed.has(row.section)) {
        ids.add(row.section);
      }
    }
    if (ids.size === 0) return;
    const top = rows[Math.floor(scrollTop / ROW_PX)];
    const at = top === undefined ? undefined : firstRow[top.section];
    if (top !== undefined && at !== undefined) {
      anchor.current = { section: top.section, offset: Math.floor(scrollTop / ROW_PX) - at };
    }
    reveal([...ids]);
  }, [view, rows, firstRow, start, end, formatted, collapsed, scrollTop, reveal]);
  useLayoutEffect(() => {
    const held = anchor.current;
    if (held === null) return;
    anchor.current = null;
    const at = firstRow[held.section];
    if (at === undefined) return;
    const row = Math.min(at + held.offset, Math.max(rows.length - 1, 0));
    if (row !== Math.floor(scrollTop / ROW_PX)) scrollToRow(row, 0);
  }, [rows, firstRow, scrollTop, scrollToRow]);

  // A focused heading stays rendered when it scrolls out of the window, so focus is never lost.
  const [focused, setFocused] = useState<number | null>(null);
  const focusedRow = focused === null ? undefined : firstRow[focused];
  const shownRows = Array.from({ length: Math.max(end - start, 0) }, (_, k) => start + k);
  if (focusedRow !== undefined && (focusedRow < start || focusedRow >= end)) {
    shownRows.push(focusedRow);
  }

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
        onClearFilter={() => {
          onClearFilter();
          // The Clear filter button goes away with the filter: focus moves to the text.
          pane.current?.focus();
        }}
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
          {shownRows.map((i) => {
            const row = rows[i];
            if (row === undefined) return null;
            const s = sections[row.section];
            if (s === undefined) return null;
            if (row.type === "label") {
              const open = !collapsed.has(row.section);
              return (
                <div
                  key={`s${row.section}`}
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
                    onFocus={() => setFocused(row.section)}
                    onBlur={() => setFocused(null)}
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
                  <LineBoundary text={row.text}>
                    <TokenLine tokens={row.tokens} query={query} />
                  </LineBoundary>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
