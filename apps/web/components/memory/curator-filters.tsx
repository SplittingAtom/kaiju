"use client";

import { SEMANTIC_MEMORY_KINDS, SEMANTIC_MEMORY_SCOPE_LABELS } from "@kaiju/protocol";
import type { ItemKind, ItemStatus } from "../../lib/memory/items-api";
import { Field, Select, TextInput } from "../ui/console";
import { KIND_LABELS } from "./item-fields";

export type SharedScope = "team" | "site";

/** One scope the console lists, and whether the caller curates it there. */
export interface ListedScope {
  readonly scope: SharedScope;
  readonly curate: boolean;
}

/**
 * Status filter: the contract's three statuses. Staleness (KOBE-386) is not a status but a flag on
 * items and a `stale` list filter (`MemoryItem.stale`, `ListQuery.stale`); not shown here yet.
 */
const STATUS_LABELS: Readonly<Record<ItemStatus, string>> = {
  active: "Active",
  archived: "Archived",
  superseded: "Superseded",
};
export type PolicyFilter = "all" | "policy" | "ordinary";

export interface Filters {
  readonly scope: SharedScope;
  readonly status: ItemStatus;
  readonly kind: ItemKind | "";
  readonly tag: string;
  readonly policy: PolicyFilter;
}

/** The curators' filters (KOBE-385): scope, kind, status, Policy (Site only) and tag. */
export function CuratorFilters({
  scopes,
  filters,
  site,
  set,
}: {
  readonly scopes: readonly ListedScope[];
  readonly filters: Filters;
  readonly site: boolean;
  set(change: Partial<Filters>): void;
}) {
  return (
    <form
      aria-label="Filter memories"
      className="my-4 flex flex-wrap items-end gap-3"
      onSubmit={(e) => e.preventDefault()}
    >
      {scopes.length > 1 && (
        <Field label="Scope" className="w-fit">
          <Select
            value={filters.scope}
            onChange={(e) => set({ scope: e.target.value as SharedScope, policy: "all" })}
          >
            {scopes.map((s) => (
              <option key={s.scope} value={s.scope}>
                {SEMANTIC_MEMORY_SCOPE_LABELS[s.scope]}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field label="Kind" className="w-fit">
        <Select
          value={filters.kind}
          onChange={(e) => set({ kind: e.target.value as ItemKind | "" })}
        >
          <option value="">All kinds</option>
          {SEMANTIC_MEMORY_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Status" className="w-fit">
        <Select
          value={filters.status}
          onChange={(e) => set({ status: e.target.value as ItemStatus })}
        >
          {(Object.keys(STATUS_LABELS) as ItemStatus[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </Select>
      </Field>
      {site && (
        <Field label="Policy" className="w-fit">
          <Select
            value={filters.policy}
            onChange={(e) => set({ policy: e.target.value as PolicyFilter })}
          >
            <option value="all">Policy and other memories</option>
            <option value="policy">Policy only</option>
            <option value="ordinary">Not Policy</option>
          </Select>
        </Field>
      )}
      <Field label="Tag" hint="Matches the memories loaded so far.">
        <TextInput value={filters.tag} onChange={(e) => set({ tag: e.target.value })} />
      </Field>
    </form>
  );
}
