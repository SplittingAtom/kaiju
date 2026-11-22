"use client";

/**
 * The Raw view of a workspace text file (KOBE-463): a CodeMirror 6 editor, loaded lazily by
 * `file-editor.tsx` (`React.lazy`), so the chat bundle does not carry it. With `original`, it is
 * the review of an agent's proposal (spec FE3, FE10): `@codemirror/merge`'s unified view shows the
 * proposal against the file, added text on green and deleted text on red (struck through), with
 * Accept and Reject on each change. Accepting keeps a change, rejecting puts the original back;
 * the document is always what a commit saves. Inline, Accept and Reject are icon buttons (KOBE-615:
 * a green check and a red cross in a circle, Lucide's CircleCheck and CircleX); the review row
 * above the editor (`proposal-review.tsx`) moves between the changes and decides the change at the
 * cursor through `onReview`.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useLineWrap } from "./use-line-wrap";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import {
  acceptChunk,
  getChunks,
  goToNextChunk,
  goToPreviousChunk,
  rejectChunk,
  unifiedMergeView,
} from "@codemirror/merge";
import { openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import type { EditorLanguage } from "../../lib/files/editor";
import { minimalChange } from "../../lib/files/outside-change";
import { documentCspNonce } from "../../lib/security/csp-nonce";
import { languageExtension } from "./editor-languages";
import { builtInCompletion, completionTheme, kernelCompletion } from "./editor-completion";
import {
  KERNEL_STATE_TEXT,
  type KernelCompleter,
  type KernelCompletionState,
} from "../../lib/notebooks/kernel-completer";

export interface CodeEditorProps {
  readonly value: string;
  readonly language: EditorLanguage | null;
  /** The editable region's accessible name. */
  readonly label: string;
  readonly readOnly?: boolean | undefined;
  /** Review mode: `value` (the proposal) is shown against this content. */
  readonly original?: string | undefined;
  onChange?(text: string): void;
  /** Review mode: how many changes are still open (neither accepted nor rejected). */
  onChunks?(count: number): void;
  /**
   * Review mode: the controls for the review row (null once the view is gone) and, on each
   * change, which open change is current (1-based: the one at the cursor, else the next).
   */
  onReview?(review: ReviewControls | null): void;
  onCurrent?(current: number | null): void;
  /** A notebook cell (KOBE-465): as tall as its text, not the file editor's full column. */
  readonly compact?: boolean | undefined;
  /** Shift+Enter runs (a notebook cell, KOBE-465) instead of inserting a line. */
  readonly onRun?: (() => void) | undefined;
  /** Put the cursor in the editor when it opens (never when read-only). */
  readonly autoFocus?: boolean | undefined;
  /** A `.py` file's kernel completion (KOBE-808); built-in completion needs nothing. */
  readonly kernel?: KernelCompleter | undefined;
}

/** What the review row does to the change at the cursor (KOBE-615). */
export interface ReviewControls {
  previous(): void;
  next(): void;
  accept(): void;
  reject(): void;
}

/** Colours only from the theme tokens (app/theme.css), so light and dark both hold. */
const theme = EditorView.theme({
  "&": {
    backgroundColor: "var(--background)",
    color: "var(--foreground)",
    fontSize: "0.8125rem",
    height: "100%",
  },
  "&.cm-focused": { outline: "2px solid var(--ring)", outlineOffset: "-2px" },
  ".cm-scroller": { fontFamily: "var(--kobe-font-mono)" },
  ".cm-content": { caretColor: "var(--foreground)" },
  ".cm-cursor": { borderLeftColor: "var(--foreground)" },
  ".cm-gutters": {
    backgroundColor: "var(--muted)",
    color: "var(--muted-foreground)",
    borderRight: "1px solid var(--border)",
  },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--muted) 50%, transparent)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--ring) 35%, transparent)",
  },
  // Find, replace and go to line (@codemirror/search): the app's tokens, light and dark.
  ".cm-panels": {
    backgroundColor: "var(--muted)",
    color: "var(--foreground)",
    borderColor: "var(--border)",
  },
  ".cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-panels-bottom": { borderTop: "1px solid var(--border)" },
  ".cm-search, .cm-dialog": { fontSize: "0.75rem", padding: "0.375rem 2rem 0.375rem 0.5rem" },
  ".cm-search label": { color: "var(--muted-foreground)" },
  ".cm-textfield": {
    backgroundColor: "var(--background)",
    color: "var(--foreground)",
    border: "1px solid var(--border)",
    borderRadius: "0.375rem",
    padding: "0.125rem 0.375rem",
  },
  ".cm-textfield:focus-visible": { outline: "2px solid var(--ring)", outlineOffset: "-1px" },
  ".cm-button": {
    backgroundColor: "var(--background)",
    backgroundImage: "none",
    color: "var(--foreground)",
    border: "1px solid var(--border)",
    borderRadius: "0.375rem",
    padding: "0.125rem 0.5rem",
    cursor: "pointer",
  },
  ".cm-button:hover": { backgroundColor: "var(--muted)" },
  ".cm-button:focus-visible": { outline: "2px solid var(--ring)", outlineOffset: "1px" },
  ".cm-panel.cm-search [name=close]": { color: "var(--muted-foreground)" },
  ".cm-searchMatch": {
    backgroundColor: "color-mix(in srgb, var(--ring) 25%, transparent)",
    outline: "1px solid color-mix(in srgb, var(--ring) 60%, transparent)",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "color-mix(in srgb, var(--ring) 50%, transparent)",
  },
  // The diff (unified merge view): added on green, deleted on red and struck through.
  "&.cm-merge-b .cm-changedLine, .cm-inlineChangedLine": {
    backgroundColor: "var(--kobe-diff-added-bg)",
  },
  "&.cm-merge-b .cm-changedText": {
    background: "color-mix(in srgb, var(--kobe-diff-added) 25%, var(--kobe-diff-added-bg))",
  },
  ".cm-deletedChunk": { backgroundColor: "var(--kobe-diff-deleted-bg)" },
  ".cm-deletedChunk del, &.cm-merge-b .cm-deletedText": {
    textDecoration: "line-through",
    textDecorationColor: "var(--kobe-diff-deleted)",
  },
  ".cm-deletedChunk .cm-deletedText, &.cm-merge-b .cm-deletedText": {
    background: "color-mix(in srgb, var(--kobe-diff-deleted) 25%, var(--kobe-diff-deleted-bg))",
  },
  "&.cm-merge-b .cm-changedLineGutter": { background: "var(--kobe-diff-added)" },
  ".cm-deletedLineGutter": { background: "var(--kobe-diff-deleted)" },
  ".cm-deletedChunk .cm-chunkButtons": { display: "flex", gap: "0.25rem", padding: "0.125rem 0" },
  ".cm-chunkButtons button": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    border: "0",
    borderRadius: "9999px",
    padding: "0.125rem",
    background: "transparent",
    cursor: "pointer",
  },
  ".cm-chunkButtons button:hover": { background: "var(--muted)" },
  ".cm-chunkButtons button:focus-visible": { outline: "2px solid var(--ring)" },
  ".cm-chunkButtons button svg": { width: "1.125rem", height: "1.125rem" },
  ".cm-chunkButtons button[name=accept]": { color: "var(--kobe-diff-added)" },
  ".cm-chunkButtons button[name=reject]": { color: "var(--kobe-diff-deleted)" },
});

const SVG_NS = "http://www.w3.org/2000/svg";
/** Lucide's CircleCheck and CircleX (ISC), drawn here: CodeMirror's controls are plain DOM. */
const ICON_PATHS = {
  accept: ["m9 12 2 2 4-4"],
  reject: ["m15 9-6 6", "m9 9 6 6"],
} as const;

function circleIcon(type: "accept" | "reject"): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of Object.entries({
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    class: type === "accept" ? "lucide-circle-check" : "lucide-circle-x",
  })) {
    svg.setAttribute(k, v);
  }
  const circle = document.createElementNS(SVG_NS, "circle");
  circle.setAttribute("cx", "12");
  circle.setAttribute("cy", "12");
  circle.setAttribute("r", "10");
  svg.append(circle);
  for (const d of ICON_PATHS[type]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/** Accept and Reject as real icon buttons (click, so Enter and Space work too), named and titled. */
export function chunkButton(
  type: "accept" | "reject",
  action: (e: MouseEvent) => void,
): HTMLElement {
  const button = document.createElement("button");
  const name = type === "accept" ? "Accept change" : "Reject change";
  button.type = "button";
  button.name = type;
  // Its own padding: the chat's base button rule would crush the icon (KOBE-269).
  button.className = "p-0.5";
  button.setAttribute("aria-label", name);
  button.title = name;
  button.append(circleIcon(type));
  button.onclick = action;
  return button;
}

/** The position of the change at the cursor, else the next one, else the first; null: none left. */
function targetChange(state: EditorState): number | null {
  const chunks = getChunks(state)?.chunks ?? [];
  const head = state.selection.main.head;
  const at =
    chunks.find((c) => c.fromB <= head && head <= c.endB) ??
    chunks.find((c) => c.fromB >= head) ??
    chunks[0];
  return at === undefined ? null : at.fromB;
}

function openChanges(state: EditorState): number {
  return getChunks(state)?.chunks.length ?? 0;
}

/** The current change's number (1-based, see `targetChange`); null when none is left. */
function currentChange(state: EditorState): number | null {
  const chunks = getChunks(state)?.chunks ?? [];
  const at = targetChange(state);
  if (at === null) return null;
  const i = chunks.findIndex((c) => c.fromB === at);
  return i < 0 ? null : i + 1;
}

function reviewControls(view: EditorView): ReviewControls {
  const act = (run: (view: EditorView, pos: number) => boolean) => {
    const pos = targetChange(view.state);
    if (pos !== null) run(view, pos);
  };
  return {
    previous: () => void goToPreviousChunk(view),
    next: () => void goToNextChunk(view),
    accept: () => act(acceptChunk),
    reject: () => act(rejectChunk),
  };
}

/** Mod+Alt+F: the find panel with the cursor in its Replace field. */
function openReplace(view: EditorView): boolean {
  openSearchPanel(view);
  view.dom.querySelector<HTMLInputElement>(".cm-search input[name=replace]")?.focus();
  return true;
}

function baseExtensions(label: string): Extension[] {
  return [
    lineNumbers(),
    history(),
    drawSelection(),
    highlightActiveLine(),
    search({ top: true }),
    keymap.of([{ key: "Mod-Alt-f", run: openReplace }, ...searchKeymap]),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    EditorView.contentAttributes.of({ "aria-label": label }),
    // CodeMirror (and @codemirror/merge) inject their styles as <style>; the nonce CSP drops
    // un-nonced ones, leaving the gutter above the text and the diff uncoloured (KOBE-469).
    EditorView.cspNonce.of(documentCspNonce()),
    theme,
    completionTheme,
  ];
}

/** KOBE-808: completion only where the member can type, plus the kernel's for a `.py` file. */
function completionExtensions(readOnly: boolean, kernel: KernelCompleter | undefined): Extension[] {
  if (readOnly) return [];
  return [builtInCompletion(), kernel === undefined ? [] : kernelCompletion(kernel)];
}

/** The states announced to screen readers: kernel completion stopped, and why. */
const ANNOUNCED_STATES: ReadonlySet<KernelCompletionState> = new Set([
  "no_kernel",
  "asleep",
  "unsupported",
  "unavailable",
  "rate_limited",
]);

const NO_STATE = () => () => undefined;
const noState = (): KernelCompletionState | null => null;

/** The member is typing in some other field (the composer, a dialog): never take that focus. */
function typingElsewhere(editor: HTMLElement): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || el === document.body || editor.contains(el)) return false;
  return el.matches("input, textarea, select") || el.isContentEditable;
}

function wrapExtension(on: boolean): Extension {
  return on ? EditorView.lineWrapping : [];
}

function readOnlyExtensions(readOnly: boolean): Extension[] {
  return readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [];
}

export default function CodeEditor({
  value,
  language,
  label,
  readOnly = false,
  original,
  onChange,
  onChunks,
  onReview,
  onCurrent,
  compact = false,
  onRun,
  autoFocus = false,
  kernel,
}: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<EditorView | null>(null);
  const callbacks = useRef({ onChange, onChunks, onRun, onReview, onCurrent });
  callbacks.current = { onChange, onChunks, onRun, onReview, onCurrent };
  const valueRef = useRef(value);
  valueRef.current = value;
  const autoFocusRef = useRef(autoFocus);
  autoFocusRef.current = autoFocus;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  /** The last value the document was set from. */
  const synced = useRef(value);
  const compartments = useRef({
    language: new Compartment(),
    readOnly: new Compartment(),
    wrap: new Compartment(),
    completion: new Compartment(),
  });
  const kernelRef = useRef(kernel);
  kernelRef.current = kernel;
  const kernelState = useSyncExternalStore(
    kernel?.subscribe ?? NO_STATE,
    kernel?.getState ?? noState,
    kernel?.getState ?? noState,
  );
  const [lineWrap, setLineWrap] = useLineWrap();
  const lineWrapRef = useRef(lineWrap);
  lineWrapRef.current = lineWrap;
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  // Screen readers hear only when kernel completion turns off, each reason once (review L6).
  const [announced, setAnnounced] = useState("");
  useEffect(() => {
    if (kernelState === null || !ANNOUNCED_STATES.has(kernelState)) return;
    const text = KERNEL_STATE_TEXT[kernelState];
    setAnnounced((was) => (was === text ? was : text));
  }, [kernelState]);

  // One view per file and per review; text, language and read-only change in place.
  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    let chunks = -1;
    let current: number | null | undefined;
    synced.current = valueRef.current;
    const report = (state: EditorState) => {
      if (original === undefined) return;
      const open = openChanges(state);
      if (open !== chunks) callbacks.current.onChunks?.((chunks = open));
      const at = currentChange(state);
      if (at !== current) callbacks.current.onCurrent?.((current = at));
    };
    const created = new EditorView({
      parent,
      state: EditorState.create({
        doc: valueRef.current,
        extensions: [
          ...baseExtensions(label),
          Prec.highest(
            keymap.of([
              {
                key: "Shift-Enter",
                run: () => {
                  const run = callbacks.current.onRun;
                  if (!run) return false;
                  run();
                  return true;
                },
              },
            ]),
          ),
          compartments.current.language.of([]),
          compartments.current.wrap.of(wrapExtension(lineWrapRef.current)),
          // Read-only from the start (a read-only view is never briefly editable, KOBE-485).
          compartments.current.readOnly.of(readOnlyExtensions(readOnlyRef.current)),
          compartments.current.completion.of(
            completionExtensions(readOnlyRef.current, kernelRef.current),
          ),
          original === undefined
            ? []
            : unifiedMergeView({
                original,
                mergeControls: chunkButton,
                highlightChanges: true,
                gutter: true,
                syntaxHighlightDeletions: true,
              }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) callbacks.current.onChange?.(update.state.doc.toString());
            if (update.docChanged || update.selectionSet) {
              const head = update.state.selection.main.head;
              const line = update.state.doc.lineAt(head);
              setCursor((was) =>
                was.line === line.number && was.column === head - line.from + 1
                  ? was
                  : { line: line.number, column: head - line.from + 1 },
              );
            }
            report(update.state);
          }),
        ],
      }),
    });
    report(created.state);
    setView(created);
    setCursor({ line: 1, column: 1 });
    if (autoFocusRef.current && !readOnlyRef.current && !typingElsewhere(parent)) created.focus();
    if (original !== undefined) callbacks.current.onReview?.(reviewControls(created));
    return () => {
      if (original !== undefined) callbacks.current.onReview?.(null);
      created.destroy();
      setView(null);
    };
  }, [label, original]);

  useEffect(() => {
    if (!view) return;
    let live = true;
    void languageExtension(language).then((ext) => {
      if (live) view.dispatch({ effects: compartments.current.language.reconfigure(ext) });
    });
    return () => {
      live = false;
    };
  }, [view, language]);

  useEffect(() => {
    view?.dispatch({ effects: compartments.current.wrap.reconfigure(wrapExtension(lineWrap)) });
  }, [view, lineWrap]);

  useEffect(() => {
    view?.dispatch({
      effects: [
        compartments.current.readOnly.reconfigure(readOnlyExtensions(readOnly)),
        compartments.current.completion.reconfigure(completionExtensions(readOnly, kernel)),
      ],
    });
  }, [view, readOnly, kernel]);

  // A new value from outside (a reload, a discarded draft) replaces the document; the value the
  // member's own typing produced comes back equal and changes nothing.
  useEffect(() => {
    if (!view || value === synced.current) return;
    synced.current = value;
    if (view.state.doc.toString() === value) return;
    // Only the changed middle (KOBE-491): the cursor and scroll outside it stay where they were.
    const change = minimalChange(view.state.doc.toString(), value);
    if (!change) return;
    const top = view.scrollDOM.scrollTop;
    view.dispatch({ changes: change });
    view.scrollDOM.scrollTop = top;
  }, [view, value]);

  return (
    <div className={compact ? "flex flex-col" : "flex min-h-0 min-w-0 flex-1 flex-col"}>
      <div
        ref={host}
        data-kobe-code-editor
        className={
          compact
            ? "min-h-10 overflow-hidden rounded-md border"
            : "min-h-24 min-w-0 flex-1 overflow-hidden rounded-md border"
        }
      />
      {!compact && (
        <div
          className="text-muted-foreground flex items-center justify-between gap-2 px-1 pt-1 text-xs"
          data-kobe-editor-status
        >
          <button
            type="button"
            aria-pressed={lineWrap}
            aria-label="Wrap long lines"
            title={lineWrap ? "Long lines wrap: click to scroll sideways" : "Wrap long lines"}
            className="hover:bg-muted aria-pressed:bg-muted rounded-md border px-2 py-0.5"
            onClick={() => setLineWrap(!lineWrap)}
          >
            Wrap
          </button>
          {kernelState !== null && !readOnly && (
            <>
              <span
                role="status"
                aria-live="off"
                data-kobe-kernel-completion={kernelState}
                className="ml-auto truncate"
                title="Completion from the conversation's Python kernel, added to the editor's own"
              >
                {KERNEL_STATE_TEXT[kernelState]}
              </span>
              <span className="sr-only" aria-live="polite" data-kobe-kernel-announce>
                {announced}
              </span>
            </>
          )}
          <span role="status" aria-live="off" aria-label="Cursor position" className="tabular-nums">
            {`Ln ${cursor.line}, Col ${cursor.column}`}
          </span>
        </div>
      )}
    </div>
  );
}
