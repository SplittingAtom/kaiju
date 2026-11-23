"use client";

/**
 * The run pane's Variables tab (KOBE-804): the kernel's user variables with their current values,
 * live from the sandbox (`use-variables.ts`). Name, type and value (a short repr, with a size
 * summary for containers, arrays and DataFrames); sortable and filterable by name; a row expands to
 * the longer repr and a DataFrame's columns. Every value is text: React escapes it, and control and
 * direction characters are shown as escapes. Credential-like names and environment mappings show
 * their value only after Show. KOBE-816: the sandbox itself withholds those values (`hidden`), and
 * values under credential-like keys of a dict; Show asks for that one variable.
 */
import { ChevronRightIcon, RefreshCwIcon } from "lucide-react";
import { useId } from "react";
import {
  FULL_REPR_CHARS,
  ROW_REPR_CHARS,
  isSensitive,
  reprText,
  shownVariables,
  summaryOf,
  typeLabel,
  visibleText,
  type SortDir,
  type Variable,
} from "../../lib/notebooks/variables";
import { timeOfDay } from "../../lib/notebooks/run-log";
import { ErrorNotice } from "../admin/error-notice";
import { TOOL_BUTTON } from "../files/editor-toolbar";
import type { VariablesState } from "./use-variables";

export const VARIABLES_EMPTY =
  "Variables shows what your code defined in this conversation's kernel and their current values, after each run.";
export const NOT_RUNNING =
  "The kernel is not running, so there are no variables. Run the file or Start the kernel.";
export const TOO_OLD =
  "Variables are not available yet: your sandbox runs an older Kobe agent. They appear once it is updated.";
export const READER_NOTE = "Only the conversation's owner can see the kernel's variables.";
export const STALE_NOTE =
  "Code is running: these values are from before it. They refresh when it ends.";
export const RATE_LIMITED_NOTE =
  "Refresh is paused for a moment: the variables were asked for many times. Try Refresh shortly.";
export const PAUSED_NOTE =
  "Automatic refresh is paused: a snapshot took too long. Use Refresh to ask again.";

const MISSING: Readonly<Record<string, string>> = {
  busy: "Code is running; the variables show when it finishes.",
  no_kernel: NOT_RUNNING,
  unavailable: "The kernel did not answer in time. Try Refresh.",
};

const TOO_OLD_CODES = new Set(["variables_unsupported", "notebooks_unsupported"]);

/** What the panel keeps per file while the pane is open. */
export interface VariablesView {
  readonly filter: string;
  readonly sort: SortDir;
  /** Expanded rows, by name. */
  readonly expanded: readonly string[];
  /** Hidden values the member chose to see, by name. */
  readonly shown: readonly string[];
}

export const VARIABLES_VIEW: VariablesView = {
  filter: "",
  sort: "ascending",
  expanded: [],
  shown: [],
};

const toggle = (list: readonly string[], name: string) =>
  list.includes(name) ? list.filter((n) => n !== name) : [...list, name];

function ValueCell({
  v,
  hidden,
  onShow,
}: {
  readonly v: Variable;
  readonly hidden: boolean;
  onShow(): void;
}) {
  const summary = summaryOf(v);
  if (hidden) {
    return (
      <span className="flex items-center gap-1">
        <span className="text-muted-foreground italic">Hidden</span>
        <button
          type="button"
          className="hover:bg-muted rounded-md border px-1.5 text-xs"
          aria-label={`Show the value of ${v.name}`}
          onClick={onShow}
        >
          Show
        </button>
      </span>
    );
  }
  return (
    <span className="flex min-w-0 flex-col">
      {summary !== "" && <span className="text-muted-foreground">{summary}</span>}
      <span className="truncate font-mono" data-kobe-var-value={v.name}>
        {reprText(v, ROW_REPR_CHARS)}
      </span>
      {v.hidden === "keys" && (
        <button
          type="button"
          className="hover:bg-muted self-start rounded-md border px-1.5 text-xs"
          aria-label={`Show the hidden values in ${v.name}`}
          onClick={onShow}
        >
          Show hidden values
        </button>
      )}
    </span>
  );
}

function columnsText(columns: NonNullable<Variable["columns"]>, total: number | undefined): string {
  const listed = columns.map((c) => `${visibleText(c.name)} (${visibleText(c.dtype)})`).join(", ");
  const more =
    total !== undefined && total > columns.length ? `, and ${total - columns.length} more` : "";
  return `Columns: ${listed}${more}`;
}

function Details({ v }: { readonly v: Variable }) {
  return (
    <div className="flex flex-col gap-1 py-1">
      <pre className="m-0 font-mono text-xs break-words whitespace-pre-wrap">
        {reprText(v, FULL_REPR_CHARS)}
      </pre>
      {v.columns !== undefined && v.columns.length > 0 && (
        <p className="m-0 text-xs">{columnsText(v.columns, v.columnsTotal)}</p>
      )}
    </div>
  );
}

function Row({
  v,
  view,
  onView,
  onShow,
  detailsId,
}: {
  readonly v: Variable;
  readonly view: VariablesView;
  onView(next: VariablesView): void;
  /** KOBE-816: ask the sandbox for a value it withheld. */
  onShow(name: string): void;
  readonly detailsId: string;
}) {
  const open = view.expanded.includes(v.name);
  // Withheld by the sandbox (KOBE-816; no value here until Show asks for it), or credential-like
  // by name from an older agent (the value is here; shown after Show).
  const withheld = v.hidden === "name";
  const hidden = withheld || (isSensitive(v) && !view.shown.includes(v.name));
  return (
    <>
      <tr className="border-b align-top" data-kobe-variable={v.name}>
        <td className="py-0.5 pe-2">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={open ? detailsId : undefined}
            className="hover:bg-muted flex items-center gap-0.5 rounded-md font-mono"
            title={open ? "Hide the details" : "Show the longer value"}
            disabled={hidden}
            onClick={() => onView({ ...view, expanded: toggle(view.expanded, v.name) })}
          >
            <ChevronRightIcon
              aria-hidden
              className={`size-3 shrink-0 ${open ? "rotate-90" : ""} motion-reduce:transition-none`}
            />
            {visibleText(v.name)}
          </button>
        </td>
        <td className="text-muted-foreground py-0.5 pe-2 font-mono">{visibleText(typeLabel(v))}</td>
        <td className="max-w-0 py-0.5">
          <ValueCell
            v={v}
            hidden={hidden}
            onShow={() => {
              onView({ ...view, shown: [...view.shown, v.name] });
              if (v.hidden !== undefined) onShow(v.name);
            }}
          />
        </td>
      </tr>
      {open && !hidden && (
        <tr id={detailsId}>
          <td colSpan={3} className="border-b ps-4">
            <Details v={v} />
          </td>
        </tr>
      )}
    </>
  );
}

function Status({
  state,
  busy,
}: {
  readonly state: VariablesState & { readonly allowed: boolean };
  readonly busy: boolean;
}) {
  const { snapshot } = state;
  const lines: string[] = [];
  if (snapshot !== null && (busy || snapshot.stale === true)) {
    lines.push(
      busy ? STALE_NOTE : `As of ${timeOfDay(Date.parse(snapshot.takenAt))}; code has run since.`,
    );
  }
  if (snapshot !== null && state.missing !== null && state.missing !== "no_kernel") {
    lines.push(MISSING[state.missing] ?? "");
  }
  if (state.autoPaused) lines.push(PAUSED_NOTE);
  if (snapshot?.truncated) {
    lines.push("Some variables are left out: too many, or too large to list.");
  }
  if (lines.length === 0) return null;
  return (
    <p role="status" className="text-muted-foreground m-0 text-xs" data-kobe-variables-status="">
      {lines.join(" ")}
    </p>
  );
}

export function VariablesPanel({
  state,
  busy,
  view,
  onView,
}: {
  readonly state: VariablesState & {
    readonly allowed: boolean;
    refresh(): void;
    show?(name: string): void | Promise<void>;
  };
  readonly busy: boolean;
  readonly view: VariablesView;
  onView(next: VariablesView): void;
}) {
  const id = useId();
  if (!state.allowed) {
    return <p className="text-muted-foreground text-xs">{READER_NOTE}</p>;
  }
  const { snapshot } = state;
  const tooOld = state.error !== null && TOO_OLD_CODES.has(state.error.code);
  const rows = snapshot === null ? [] : shownVariables(snapshot.variables, view.filter, view.sort);
  let body;
  if (tooOld) body = <p className="text-xs">{TOO_OLD}</p>;
  else if (snapshot === null && state.loading) {
    body = (
      <p role="status" className="text-muted-foreground text-xs">
        Reading the variables…
      </p>
    );
  } else if (snapshot === null && state.missing !== null) {
    body = <p className="text-xs">{busy ? MISSING.busy : MISSING[state.missing]}</p>;
  } else if (snapshot === null) {
    body = <p className="text-muted-foreground text-xs">{VARIABLES_EMPTY}</p>;
  } else if (snapshot.variables.length === 0) {
    body = (
      <p className="text-muted-foreground text-xs">
        No variables yet: your code has not defined any.
      </p>
    );
  } else {
    body = (
      <table className="w-full table-fixed border-collapse text-xs" aria-label="Variables">
        <colgroup>
          <col className="w-1/4" />
          <col className="w-1/5" />
          <col />
        </colgroup>
        <thead>
          <tr className="border-b text-start">
            <th scope="col" className="py-0.5 text-start font-medium" aria-sort={view.sort}>
              <button
                type="button"
                className="hover:bg-muted rounded-md px-0.5"
                title="Sort by name"
                onClick={() =>
                  onView({ ...view, sort: view.sort === "ascending" ? "descending" : "ascending" })
                }
              >
                Name {view.sort === "ascending" ? "↑" : "↓"}
              </button>
            </th>
            <th scope="col" className="py-0.5 text-start font-medium">
              Type
            </th>
            <th scope="col" className="py-0.5 text-start font-medium">
              Value
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((v, i) => (
            <Row
              key={v.name}
              v={v}
              view={view}
              onView={onView}
              onShow={(name) => void state.show?.(name)}
              detailsId={`${id}-d${i}`}
            />
          ))}
        </tbody>
      </table>
    );
  }
  const others = snapshot?.other ?? [];
  return (
    <div className="flex flex-col gap-1.5" data-kobe-variables="">
      <div className="flex flex-wrap items-center gap-1">
        <input
          type="search"
          aria-label="Filter variables by name"
          placeholder="Filter by name"
          value={view.filter}
          onChange={(e) => onView({ ...view, filter: e.target.value })}
          className="bg-background focus-visible:ring-ring min-w-0 flex-1 rounded-md border px-2 py-0.5 text-xs focus-visible:ring-2 focus-visible:outline-none"
        />
        <button
          type="button"
          className={TOOL_BUTTON}
          disabled={busy || state.loading || tooOld}
          aria-busy={state.loading || undefined}
          title={busy ? "Code is running: refresh when it ends." : undefined}
          onClick={state.refresh}
        >
          <RefreshCwIcon aria-hidden className="size-3.5" />
          Refresh
        </button>
      </div>
      <Status state={state} busy={busy} />
      {state.error?.code === "rate_limited" ? (
        <p role="status" className="text-muted-foreground m-0 text-xs">
          {RATE_LIMITED_NOTE}
        </p>
      ) : (
        state.error !== null && !tooOld && <ErrorNotice error={state.error} />
      )}
      {body}
      {snapshot !== null && rows.length === 0 && snapshot.variables.length > 0 && (
        <p className="text-muted-foreground text-xs">No variable names match the filter.</p>
      )}
      {others.length > 0 && (
        <p className="text-muted-foreground m-0 text-xs">
          Also defined (names only):{" "}
          {others.map((o) => `${visibleText(o.name)} (${o.kind})`).join(", ")}
        </p>
      )}
    </div>
  );
}
