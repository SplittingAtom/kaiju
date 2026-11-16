/**
 * The Memory page's tabs (KOBE-384, SM5): **Memories** (the default: short statements, the item
 * store of KOBE-378) and **Notes** (the D24 memory files of KOBE-155..164). The tab is in the
 * address (`?tab=notes`) so a link, a reload and the "Note saved" chip open it; a project's memory
 * (`?project=`) is notes only, so it opens on Notes.
 */
export const MEMORY_TABS = ["memories", "notes"] as const;
export type MemoryTab = (typeof MEMORY_TABS)[number];

export const MEMORY_PAGE_HREF = "/me/memory";
export const NOTES_TAB_HREF = `${MEMORY_PAGE_HREF}?tab=notes`;

/** The tab an address opens on. */
export function memoryTabOf(search: string): MemoryTab {
  const params = new URLSearchParams(search);
  if (params.get("tab") === "notes" || params.has("project")) return "notes";
  return "memories";
}

/** Keeps the address in step with the tab (Memories, the default, needs no parameter). */
export function showTabInUrl(tab: MemoryTab): void {
  const url = new URL(window.location.href);
  if (tab === "notes") url.searchParams.set("tab", "notes");
  else {
    url.searchParams.delete("tab");
    url.searchParams.delete("project");
  }
  window.history.replaceState(null, "", url);
}

/**
 * The address of one saved memory (KOBE-399, the chat's "Open in Memory" chip): the Memories tab
 * with `?item=<id>` (and `&scope=` when known), where it is shown first with Archive and Undo.
 */
export function memoryItemHref(id: string, scope?: string): string {
  const params = new URLSearchParams({ item: id });
  if (scope !== undefined) params.set("scope", scope);
  return `${MEMORY_PAGE_HREF}?${params.toString()}`;
}

/**
 * A link to To review (KOBE-396): `?review=…` (the bell) or `?tab=review` (KOBE-395's Learn).
 * To review sits atop the Memories tab, so it opens Memories and focuses the first card.
 */
export function isReviewLink(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.has("review") || params.get("tab") === "review";
}
