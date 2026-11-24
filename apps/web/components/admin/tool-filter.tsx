"use client";

import { useId, useState } from "react";
import { TextInput } from "../ui/console";

/**
 * A filter for long connector tool lists (KOBE-835: an MCP server may list dozens or hundreds of
 * tools). Shown only from {@link TOOL_FILTER_MIN} tools on; matches the tool's name, title and
 * description, case-insensitively. The caller renders the filtered list (and may act on exactly
 * the tools shown, e.g. tick them all).
 */
export const TOOL_FILTER_MIN = 12;

export interface ToolFilter<T> {
  readonly query: string;
  readonly setQuery: (q: string) => void;
  /** The tools that match (all of them while the query is empty). */
  readonly shown: readonly T[];
  /** Whether the list is long enough to offer the field. */
  readonly offered: boolean;
}

export function useToolFilter<T>(
  tools: readonly T[],
  textOf: (tool: T) => readonly (string | null | undefined)[],
): ToolFilter<T> {
  const [query, setQuery] = useState("");
  const offered = tools.length >= TOOL_FILTER_MIN;
  const needle = offered ? query.trim().toLowerCase() : "";
  const shown =
    needle === ""
      ? tools
      : tools.filter((t) => textOf(t).some((s) => s?.toLowerCase().includes(needle) === true));
  return { query, setQuery, shown, offered };
}

/** The field with a live count ("12 of 140 tools"); nothing while the list is short. */
export function ToolFilterField<T>({
  filter,
  total,
  label,
}: {
  readonly filter: ToolFilter<T>;
  readonly total: number;
  /** The field's accessible name, e.g. "Filter tools of massive". */
  readonly label: string;
}) {
  const id = useId();
  if (!filter.offered) return null;
  return (
    <div className="my-2 flex flex-wrap items-center gap-2">
      <TextInput
        id={id}
        type="search"
        aria-label={label}
        placeholder="Filter tools"
        spellCheck={false}
        className="max-w-xs"
        value={filter.query}
        onChange={(e) => filter.setQuery(e.target.value)}
      />
      <span role="status" className="text-sm text-console-muted">
        {filter.shown.length === total
          ? `${total} tools`
          : `${filter.shown.length} of ${total} tools`}
      </span>
    </div>
  );
}
