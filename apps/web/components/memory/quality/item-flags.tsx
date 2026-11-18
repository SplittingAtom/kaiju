"use client";

import { useEffect, useState } from "react";
import type { ApiError } from "../../../lib/api/client";
import type { ItemSignalsList, QualityApi, QualityFilter } from "../../../lib/memory/quality-api";
import {
  Badge,
  EmptyState,
  Field,
  Notice,
  Section,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../ui/console";

const FILTERS: readonly (readonly [QualityFilter, string])[] = [
  ["all", "All memories"],
  ["check_this", "Check this"],
  ["unused", "Not used lately"],
];

const dateOf = (iso: string | null) =>
  iso === null ? "Never" : new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });

/**
 * How each active memory is used (KOBE-411): runs that received it, the last time, and runs among
 * them that got a thumbs down, with the review flags **Check this** (more than 30% thumbs down over
 * at least 10 runs) and **Not used lately** (no run received it for the Site's threshold). A
 * filter shows flagged memories only. Flags are for review: nothing is archived by them.
 */
export function ItemFlags({
  api,
  scope,
  title = "How memories are used",
  description,
}: {
  readonly api: Pick<QualityApi, "items">;
  readonly scope?: "user" | "team";
  readonly title?: string;
  readonly description?: string;
}) {
  const [filter, setFilter] = useState<QualityFilter>("all");
  const [list, setList] = useState<ItemSignalsList | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    let current = true;
    void api.items(filter, scope).then((res) => {
      if (!current) return;
      if (res.ok) {
        setList(res.data);
        setError(null);
      } else setError(res.error);
    });
    return () => {
      current = false;
    };
  }, [api, filter, scope]);

  const t = list?.thresholds;
  return (
    <Section
      title={title}
      level={3}
      description={
        description ??
        (t
          ? `Check this: more than ${Math.round(t.checkDownRatio * 100)}% of the runs that received a memory got a thumbs down, over at least ${t.checkMinRuns} runs. Not used lately: no run received it in ${t.unusedAfterDays} days. Flags are for review: nothing is archived automatically.`
          : undefined)
      }
    >
      <Field label="Show" className="mb-3 max-w-xs">
        <Select value={filter} onChange={(e) => setFilter(e.target.value as QualityFilter)}>
          {FILTERS.map(([value, label]) => (
            <option key={value} value={value}>
              {list && value !== "all"
                ? `${label} (${value === "check_this" ? list.counts.checkThis : list.counts.unused})`
                : label}
            </option>
          ))}
        </Select>
      </Field>
      {/* A secondary panel: its failure is shown, not announced over the page's own alerts. */}
      {error && (
        <Notice tone="error" role="status">
          {error.message}
        </Notice>
      )}
      {list && list.items.length === 0 && (
        <EmptyState title={filter === "all" ? "No active memories" : "Nothing flagged"}>
          {filter === "all"
            ? "Memories appear here once they are saved."
            : "No memory matches this flag right now."}
        </EmptyState>
      )}
      {list && list.items.length > 0 && (
        <Table caption="Memories with how often runs received them">
          <TableHead>
            <TableRow>
              <TableHeader>Memory</TableHeader>
              <TableHeader numeric>Runs</TableHeader>
              <TableHeader numeric>Thumbs down</TableHeader>
              <TableHeader>Last received</TableHeader>
              <TableHeader>Flags</TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>
            {list.items.map((i) => (
              <TableRow key={i.id} data-item={i.id}>
                <TableCell className="max-w-md break-words">
                  {i.statement}
                  {i.policy && (
                    <Badge tone="accent" className="ml-2">
                      Policy
                    </Badge>
                  )}
                </TableCell>
                <TableCell numeric>{i.runs}</TableCell>
                <TableCell numeric>{i.downRuns}</TableCell>
                <TableCell>{dateOf(i.lastReceivedAt)}</TableCell>
                <TableCell>
                  <span className="flex flex-wrap gap-1">
                    {i.flags.checkThis && <Badge tone="attention">Check this</Badge>}
                    {i.flags.unused && <Badge tone="neutral">Not used lately</Badge>}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}
