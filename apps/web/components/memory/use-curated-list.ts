"use client";

import { useCallback, useEffect, useState } from "react";
import type { ApiError } from "../../lib/api/client";
import {
  describeItemError,
  type MemoryItem,
  type MemoryItemList,
  type MemoryItemsApi,
} from "../../lib/memory/items-api";
import type { Filters } from "./curator-filters";

export type ListState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly error: ApiError }
  | {
      readonly status: "ready";
      readonly items: readonly MemoryItem[];
      readonly nextCursor: string | null;
      readonly usage: MemoryItemList["usage"];
    };

const worded = (error: ApiError): ApiError => ({ ...error, message: describeItemError(error) });

/**
 * One filtered page list of a shared scope's memories (KOBE-385): loads on every filter change,
 * pages on `more`, and keeps rows and the active count in step with each answer (`place`).
 */
export function useCuratedList(api: MemoryItemsApi, filters: Filters, site: boolean) {
  const [state, setState] = useState<ListState>({ status: "loading" });
  const [pageError, setPageError] = useState<ApiError | null>(null);

  const query = useCallback(
    (cursor: string | null) =>
      api.list({
        scope: filters.scope,
        status: filters.status,
        kind: filters.kind === "" ? undefined : filters.kind,
        policy: site && filters.policy !== "all" ? filters.policy === "policy" : undefined,
        cursor,
      }),
    [api, filters.scope, filters.status, filters.kind, filters.policy, site],
  );

  const load = useCallback(async () => {
    setState({ status: "loading" });
    const res = await query(null);
    setState(
      res.ok ? { status: "ready", ...res.data } : { status: "error", error: worded(res.error) },
    );
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  const more = async () => {
    if (state.status !== "ready" || !state.nextCursor) return;
    setPageError(null);
    const res = await query(state.nextCursor);
    if (!res.ok) return setPageError(worded(res.error));
    setState({
      ...state,
      items: [...state.items, ...res.data.items],
      nextCursor: res.data.nextCursor,
    });
  };

  /**
   * The answer replaces its row; a row that no longer matches the filters leaves the list. The
   * active count follows the item's move in or out of `active` (a new item comes from nowhere).
   */
  const place = (item: MemoryItem) =>
    setState((prev) => {
      if (prev.status !== "ready") return prev;
      const before = prev.items.find((i) => i.id === item.id);
      const fits = item.scope === filters.scope && item.status === filters.status;
      const items = !fits
        ? prev.items.filter((i) => i.id !== item.id)
        : before
          ? prev.items.map((i) => (i.id === item.id ? item : i))
          : [item, ...prev.items];
      const was = before ? before.status === "active" : false;
      const is = item.status === "active";
      const count = prev.usage.count + (is === was ? 0 : is ? 1 : -1);
      return { ...prev, items, usage: { ...prev.usage, count } };
    });

  /** Policy counts move with Policy changes the list can't see: ask again (Site only). */
  const refreshUsage = async () => {
    const res = await query(null);
    if (res.ok)
      setState((prev) => (prev.status === "ready" ? { ...prev, usage: res.data.usage } : prev));
  };

  return { state, pageError, load, more, place, refreshUsage };
}
