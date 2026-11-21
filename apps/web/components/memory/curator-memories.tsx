"use client";

import { SEMANTIC_MEMORY_SCOPE_LABELS } from "@kobe/protocol";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createMemoryItemsApi, type MemoryItem } from "../../lib/memory/items-api";
import { ErrorNotice } from "../admin/error-notice";
import { Button, EmptyState, Section } from "../ui/console";
import { CuratorAdd } from "./curator-add";
import { CuratorFilters, type Filters, type ListedScope } from "./curator-filters";
import { itemAnchor } from "./item-checks";
import { ItemRow, type Done, type FocusAfter } from "./item-row";
import { UndoBar, UsageNotice } from "./my-memories";
import { PolicyBudget } from "./policy-budget";
import { useCuratedList } from "./use-curated-list";

export type { ListedScope, SharedScope } from "./curator-filters";

const LIST_HEADING = "curated-memories";

/**
 * The curators' Memories tab (KOBE-385; SM8, SM21) on the Workspace and Site console Memory
 * pages: one scope at a time with filters (scope, kind, tag, status; Policy on the Site), and
 * edit, archive, restore, pin and tags on every row through the KOBE-379 save checks with Undo
 * (KOBE-384's rows). A scope the caller doesn't curate is read-only. `canSetPolicy` (Site admins)
 * adds the Policy toggle and the Policy budget meter's actions.
 */
export function CuratorMemories({
  teamId,
  scopes,
  canSetPolicy = false,
  rowExtra,
}: {
  readonly teamId: string | undefined;
  readonly scopes: readonly ListedScope[];
  readonly canSetPolicy?: boolean;
  /** More for each active row the caller curates (Propose to Site, KOBE-404). */
  readonly rowExtra?: (item: MemoryItem) => ReactNode;
}) {
  const api = useMemo(() => createMemoryItemsApi(teamId), [teamId]);
  const first = scopes[0]?.scope ?? "team";
  const [filters, setFilters] = useState<Filters>({
    scope: first,
    status: "active",
    kind: "",
    tag: "",
    policy: "all",
  });
  const [done, setDone] = useState<{ readonly n: number; readonly done: Done } | null>(null);
  const [focus, setFocus] = useState<FocusAfter | null>(null);
  const curate = scopes.find((s) => s.scope === filters.scope)?.curate === true;
  const site = filters.scope === "site";
  const { state, pageError, load, more, place, refreshUsage } = useCuratedList(api, filters, site);

  useEffect(() => {
    if (focus === null) return;
    const el = focus === "group" || focus === "archive" ? null : document.getElementById(focus);
    (el ?? document.getElementById(LIST_HEADING))?.focus();
    setFocus(null);
  }, [focus, state]);

  const changed = (item: MemoryItem, d: Done, target: FocusAfter) => {
    place(item);
    if (site) void refreshUsage();
    setDone((prev) => ({ n: (prev?.n ?? 0) + 1, done: d }));
    setFocus(target);
  };

  const known = useMemo(() => {
    const map = new Map<string, MemoryItem>();
    if (state.status === "ready") for (const i of state.items) map.set(i.id, i);
    return map;
  }, [state]);

  const tag = filters.tag.trim().toLowerCase();
  const shown =
    state.status === "ready"
      ? state.items.filter((i) => tag === "" || i.tags.some((t) => t.includes(tag)))
      : [];
  const title = SEMANTIC_MEMORY_SCOPE_LABELS[filters.scope];
  const set = (change: Partial<Filters>) => setFilters((f) => ({ ...f, ...change }));

  return (
    <>
      <div role="status">
        {done && (
          <UndoBar
            key={done.n}
            done={done.done}
            known={known}
            onUndone={(item) => {
              place(item);
              setFocus(item.status === "active" ? itemAnchor(item.id) : "group");
            }}
          />
        )}
      </div>
      {curate && (
        <CuratorAdd
          api={api}
          scope={filters.scope}
          canSetPolicy={canSetPolicy}
          known={known}
          onSaved={(item, d) => {
            setDone((prev) => ({ n: (prev?.n ?? 0) + 1, done: d }));
            place(item);
          }}
          onReload={() => void load()}
        />
      )}
      <CuratorFilters scopes={scopes} filters={filters} site={site} set={set} />
      <Section
        id={LIST_HEADING}
        title={title}
        description={
          curate ? undefined : "You can read these memories. Only their curators change them."
        }
      >
        {state.status === "loading" && <p role="status">Loading memories…</p>}
        {state.status === "error" && <ErrorNotice error={state.error} />}
        {state.status === "ready" && (
          <>
            {curate && <UsageNotice usage={state.usage} />}
            {site && <PolicyBudget usage={state.usage} />}
            <p className="m-0 mb-2 text-sm text-console-muted" aria-live="polite">
              {shown.length === 1 ? "1 memory shown" : `${shown.length} memories shown`}
              {state.nextCursor ? " (more to load)" : ""}.
            </p>
            {shown.length === 0 ? (
              <EmptyState title="No memories match.">
                {curate
                  ? "Add one above, or import a file under Import and export."
                  : "Nothing to show here yet."}
              </EmptyState>
            ) : (
              <ul aria-label={title} className="m-0 flex list-none flex-col gap-2 p-0">
                {shown.map((item) => (
                  <ItemRow
                    key={item.id}
                    item={item}
                    api={api}
                    known={known}
                    onChanged={changed}
                    onRefreshed={place}
                    readOnly={!curate}
                    canSetPolicy={canSetPolicy}
                    extra={rowExtra?.(item)}
                  />
                ))}
              </ul>
            )}
            {state.nextCursor && (
              <Button className="mt-2" size="sm" onClick={() => void more()}>
                Show more ({title})
              </Button>
            )}
            {pageError && <ErrorNotice error={pageError} />}
          </>
        )}
      </Section>
    </>
  );
}
