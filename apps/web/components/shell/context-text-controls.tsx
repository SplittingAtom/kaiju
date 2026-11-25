"use client";

import type { ContextView, GaugeKind } from "../../lib/chat/context-viewer";
import { GAUGE_LABELS } from "../../lib/chat/context-viewer";
import styles from "./context-viewer.module.css";

/**
 * The text column's controls (KOBE-841): Formatted or Raw, Expand all and Collapse all, and while
 * a legend row filters the text, what it shows and Clear filter. A polite live region announces
 * each filter change to screen readers.
 */
export function ContextTextControls({
  view,
  onView,
  onExpandAll,
  onCollapseAll,
  filter,
  filterCount,
  onClearFilter,
  announcement,
}: {
  readonly view: ContextView;
  readonly onView: (view: ContextView) => void;
  readonly onExpandAll: () => void;
  readonly onCollapseAll: () => void;
  readonly filter: GaugeKind | null;
  /** Sections the filter shows. */
  readonly filterCount: number;
  readonly onClearFilter: () => void;
  readonly announcement: string;
}) {
  return (
    <div className={styles.controls}>
      <div className={styles.segmented} role="group" aria-label="Text view">
        <button
          type="button"
          className={styles.segmentedButton}
          aria-pressed={view === "formatted"}
          onClick={() => onView("formatted")}
        >
          Formatted
        </button>
        <button
          type="button"
          className={styles.segmentedButton}
          aria-pressed={view === "raw"}
          onClick={() => onView("raw")}
        >
          Raw
        </button>
      </div>
      <button type="button" className={styles.smallButton} onClick={onExpandAll}>
        Expand all
      </button>
      <button type="button" className={styles.smallButton} onClick={onCollapseAll}>
        Collapse all
      </button>
      {filter !== null && (
        <span className={styles.filterChip} data-context-filter={filter}>
          <span>
            Only {GAUGE_LABELS[filter]} ({filterCount} {filterCount === 1 ? "section" : "sections"})
          </span>
          <button type="button" className={styles.smallButton} onClick={onClearFilter}>
            Clear filter
          </button>
        </span>
      )}
      <span className={styles.visuallyHidden} role="status" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}
