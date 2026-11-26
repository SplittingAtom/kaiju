"use client";

import type { CSSProperties } from "react";
import { formatTokens } from "../../lib/admin/usage-format";
import {
  GAUGE_LABELS,
  formatShare,
  type GaugeKind,
  type GaugeModel,
  type GaugeSlice,
} from "../../lib/chat/context-viewer";
import styles from "./context-viewer.module.css";

const share = (part: number): CSSProperties => ({ "--share": `${part * 100}%` }) as CSSProperties;

/** A legend row's tokens: "unknown" for memory an approximate answer could not see (CV4). */
function tokensOf(s: GaugeSlice, memoryUnknown: boolean): string {
  return s.kind === "memory" && s.tokens === 0 && memoryUnknown
    ? "unknown"
    : `${formatTokens(s.tokens)} tokens`;
}

/** The gauge's text equivalent: the use against the window, the free space, where the detail is. */
export function gaugeText(model: GaugeModel): string {
  const { total, window, free } = model;
  const used =
    window === null
      ? `${formatTokens(total)} tokens used`
      : `${formatTokens(total)} of ${formatTokens(window)} tokens used (${formatShare(total / window)}), ${formatTokens(free)} free`;
  return `Context window: ${used}. Each kind is listed in Context by kind.`;
}

/**
 * The Context panel's gauge (KOBE-471, laid out by KOBE-846): the context window as a bar running
 * the panel's full height between the text and the right rail, the used kinds stacked from the top
 * in the order of the totals list, free space the bottom segment (a horizontal bar at phone width,
 * free space at the end). Each segment's height is its share of the window; each kind has its own
 * colour and pattern, so colour never tells them apart alone. An `img` with a text equivalent: the
 * totals list (`ContextTotals`) carries the figures and the keyboard's way to filter. A segment is
 * a pointer shortcut for its row: a click filters the text to that kind (again clears it), and the
 * selected segment is outlined while the others fade (KOBE-841).
 */
export function ContextBar({
  model,
  selected,
  onPick,
}: {
  readonly model: GaugeModel;
  /** The kind the text is filtered to; null: none. */
  readonly selected: GaugeKind | null;
  readonly onPick: (kind: GaugeKind) => void;
}) {
  const { window, free } = model;
  return (
    <div
      className={styles.gauge}
      role="img"
      aria-label={gaugeText(model)}
      data-context-bar
      data-filtered={selected !== null || undefined}
    >
      <div className={styles.bar} aria-hidden="true">
        {model.slices
          .filter((s) => s.tokens > 0)
          .map((s) => (
            <button
              key={s.kind}
              type="button"
              tabIndex={-1}
              data-context-segment={s.kind}
              data-kind={s.kind}
              data-selected={selected === s.kind || undefined}
              className={styles.segment}
              style={share(s.share)}
              title={`${GAUGE_LABELS[s.kind]}: ${formatTokens(s.tokens)} tokens`}
              onClick={() => onPick(s.kind)}
            />
          ))}
        {window !== null && model.freeShare > 0 && (
          <span
            className={styles.free}
            data-context-segment-free
            title={`Free: ${formatTokens(free)} tokens`}
          />
        )}
      </div>
    </div>
  );
}

/**
 * The category totals at the top of the right rail (KOBE-471's legend): each kind with its tokens
 * and share of the window, in the gauge's order, Free last as in the gauge; Memory is always
 * listed, 0 tokens included (KOBE-841). A row is a toggle button that filters the text to its kind
 * and highlights its segment; again clears it.
 */
export function ContextTotals({
  model,
  selected,
  memoryUnknown = false,
  onPick,
}: {
  readonly model: GaugeModel;
  /** The kind the text is filtered to; null: none. */
  readonly selected: GaugeKind | null;
  /** The answer may lack the memory (an approximate one, CV4). */
  readonly memoryUnknown?: boolean;
  readonly onPick: (kind: GaugeKind) => void;
}) {
  const { window, free } = model;
  return (
    <ul className={styles.legend} aria-label="Context by kind">
      {model.slices.map((s) => (
        <li key={s.kind}>
          <button
            type="button"
            className={styles.legendRow}
            data-context-legend={s.kind}
            data-selected={selected === s.kind || undefined}
            aria-pressed={selected === s.kind}
            aria-label={`${GAUGE_LABELS[s.kind]}: ${tokensOf(s, memoryUnknown)}, ${formatShare(s.ofWindow)}. ${selected === s.kind ? "Show every section" : "Show only this in the text"}`}
            onClick={() => onPick(s.kind)}
          >
            <span className={styles.swatch} data-kind={s.kind} />
            <span className={styles.legendName}>{GAUGE_LABELS[s.kind]}</span>
            <span className={styles.legendTokens}>{tokensOf(s, memoryUnknown)}</span>
            <span className={styles.legendShare}>{formatShare(s.ofWindow)}</span>
          </button>
        </li>
      ))}
      {window !== null && (
        <li className={styles.legendRow}>
          <span className={styles.swatch} data-kind="free" />
          <span className={styles.legendName}>Free</span>
          <span className={styles.legendTokens}>{formatTokens(free)} tokens</span>
          <span className={styles.legendShare}>{formatShare(free / window)}</span>
        </li>
      )}
    </ul>
  );
}
