/**
 * What the projection adds over the tree (KOBE-716: out of `lib/chat/tree.ts`): skipped-actions
 * reports after the message above them, and the active run's prompt and streaming content.
 */
import type { ParsedEntry } from "../entries";
import type { ThreadEntry } from "../types";
import { liveParts } from "./build-nodes";
import {
  PREFIX_LIVE,
  PREFIX_PROMPT,
  PREFIX_SKIPPED,
  messageMeta,
  type KaijuMessageMeta,
  type LiveOverlay,
  type MessagePart,
  type ProjectedItem,
  type SkippedReport,
} from "./types";
/** The nearest shown message at or above `entryId` (hidden entries belong to none). */
function nearestNode(
  entryId: string | null,
  parentOf: ReadonlyMap<string, string | null>,
  nodeOfEntry: ReadonlyMap<string, string>,
): string | undefined {
  const seen = new Set<string>();
  let id = entryId;
  while (id !== null && !seen.has(id)) {
    const node = nodeOfEntry.get(id);
    if (node !== undefined) return node;
    seen.add(id);
    id = parentOf.get(id) ?? null;
  }
  return undefined;
}

function withReports(
  item: ProjectedItem,
  reports: readonly SkippedReport[],
  entries: readonly ThreadEntry[],
): ProjectedItem {
  const meta = messageMeta(item.message);
  const deps = [...item.deps, ...entries];
  if (meta?.kind === "user") {
    const skipped = [...(meta.skipped ?? []), ...reports];
    const custom: KaijuMessageMeta = { ...meta, skipped };
    return { ...item, message: { ...item.message, metadata: { custom } }, deps };
  }
  const parts = reports.map((data): MessagePart => ({ type: "data-kaiju-skipped", data }));
  const content = [...(item.message.content as readonly MessagePart[]), ...parts];
  return { ...item, message: { ...item.message, content }, deps };
}

/**
 * Places each skipped-actions summary after the nearest shown message above it: at the end of an
 * answer, or under a prompt its run never answered. A summary with nothing shown above it (under a
 * hidden root) becomes the only message when there is none; one whose parent is not loaded waits.
 * Returns new items; `items` is left as it was.
 */
export function attachSummaries(
  items: readonly ProjectedItem[],
  indexOf: ReadonlyMap<string, number>,
  summaries: readonly ThreadEntry[],
  parsed: ReadonlyMap<string, ParsedEntry>,
  nodeOfEntry: ReadonlyMap<string, string>,
  treeEntries: readonly ThreadEntry[],
): ProjectedItem[] {
  if (summaries.length === 0) return [...items];
  const parentOf = new Map(treeEntries.map((e) => [e.entryId, e.parentId] as const));
  const byIndex = new Map<number, { reports: SkippedReport[]; entries: ThreadEntry[] }>();
  const unplaced: { report: SkippedReport; entry: ThreadEntry }[] = [];
  for (const entry of summaries) {
    const p = parsed.get(entry.entryId);
    if (p?.kind !== "skipped") continue;
    const report: SkippedReport = { text: p.text, count: p.count };
    const node = nearestNode(entry.parentId, parentOf, nodeOfEntry);
    const index = node === undefined ? undefined : indexOf.get(node);
    if (index !== undefined) {
      const slot = byIndex.get(index) ?? { reports: [], entries: [] };
      byIndex.set(index, { reports: [...slot.reports, report], entries: [...slot.entries, entry] });
    } else if (entry.parentId === null || parentOf.has(entry.parentId)) {
      unplaced.push({ report, entry });
    }
  }
  const placed = items.map((item, i) => {
    const slot = byIndex.get(i);
    return slot ? withReports(item, slot.reports, slot.entries) : item;
  });
  const first = unplaced[0];
  if (placed.length > 0 || first === undefined) return placed;
  const meta: KaijuMessageMeta = { kind: "assistant", entryIds: [], live: false };
  return [
    {
      parentId: null,
      message: {
        id: `${PREFIX_SKIPPED}${first.entry.entryId}`,
        role: "assistant",
        content: unplaced.map(({ report }): MessagePart => ({
          type: "data-kaiju-skipped",
          data: report,
        })),
        status: { type: "complete", reason: "stop" },
        metadata: { custom: meta },
      },
      deps: unplaced.map(({ entry }) => entry),
    },
  ];
}

/** Adds the run's uncommitted prompt and streaming content; returns the run's tail as the head. */
export function overlayLive(
  live: LiveOverlay,
  items: ProjectedItem[],
  indexOf: Map<string, number>,
  place: (entryId: string) => string | null | undefined,
  lastEntryOfNode: ReadonlyMap<string, string>,
  headId: string | null,
): string | null {
  const { run, active } = live;
  const nodeOf = (id: string) => {
    const at = place(id);
    return typeof at === "string" ? at : undefined;
  };
  const lastCommitted = [...run.committed].reverse().find((id) => nodeOf(id) !== undefined);
  let anchor: string | null =
    lastCommitted === undefined ? headId : (nodeOf(lastCommitted) ?? headId);

  if (!run.promptCommitted && live.prompt) {
    const parentEntryId = live.prompt.parentEntryId;
    // A hidden parent at the root (a root edit, always a named entry) puts the prompt beside the
    // first message; an unloaded one under the head, and so does none: a queued message continues
    // from the leaf its run starts on, which the server names only then (KOBE-415).
    const at = parentEntryId === null ? undefined : place(parentEntryId);
    const parentNode = at === undefined ? headId : at;
    const id = `${PREFIX_PROMPT}${run.runId}`;
    const meta: KaijuMessageMeta = {
      kind: "user",
      parentEntryId,
      text: live.prompt.text,
      pending: true,
      waiting: active,
      ...(live.prompt.files && live.prompt.files.length > 0
        ? { attachments: live.prompt.files }
        : {}),
    };
    indexOf.set(id, items.length);
    items.push({
      parentId: parentNode,
      message: {
        id,
        role: "user",
        content: [{ type: "text", text: live.prompt.text }],
        metadata: { custom: meta },
      },
      deps: [live.prompt.text, parentNode, live.prompt.files, active],
    });
    anchor = id;
  }

  const parts = liveParts(run.messages, run.tools);
  const status = active
    ? ({ type: "running" } as const)
    : ({ type: "incomplete", reason: "cancelled" } as const);
  const anchorIndex = anchor === null ? undefined : indexOf.get(anchor);
  const anchorItem = anchorIndex === undefined ? undefined : items[anchorIndex];
  const anchorMeta = anchorItem?.message.metadata?.custom as KaijuMessageMeta | undefined;
  const atTail =
    anchorMeta?.kind === "assistant" &&
    (lastCommitted === undefined || lastEntryOfNode.get(anchor as string) === lastCommitted);

  if (anchorItem && anchorIndex !== undefined && atTail && (parts.length > 0 || active)) {
    const content = [...(anchorItem.message.content as readonly MessagePart[]), ...parts];
    items[anchorIndex] = {
      parentId: anchorItem.parentId,
      message: {
        ...anchorItem.message,
        content,
        status: parts.length > 0 || active ? status : anchorItem.message.status,
        metadata: { custom: { ...(anchorMeta as object), live: true } as KaijuMessageMeta },
      },
      deps: [...anchorItem.deps, ...run.messages, run.tools, active],
    };
    return anchor;
  }
  if (parts.length === 0) return anchor;
  const id = `${PREFIX_LIVE}${run.runId}`;
  const meta: KaijuMessageMeta = { kind: "assistant", entryIds: [], live: true };
  items.push({
    parentId: anchor,
    message: { id, role: "assistant", content: parts, status, metadata: { custom: meta } },
    deps: [...run.messages, run.tools, active, anchor],
  });
  return id;
}
