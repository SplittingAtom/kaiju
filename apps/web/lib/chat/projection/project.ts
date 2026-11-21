/** The conversation as assistant-ui messages (KOBE-716: out of `lib/chat/tree.ts`). */
import { parseEntry, type ParsedEntry } from "../entries";
import { entryTime } from "../history";
import { nodeMarkers } from "../marker-placement";
import type { ThreadEntry } from "../types";
import { splitAttachedFiles } from "../uploads";
import { withoutSkillLine } from "./branch-point";
import {
  buildNodes,
  entryParts,
  hiddenEntries,
  innerMarkerParts,
  toolDeps,
  type HistoryContext,
} from "./build-nodes";
import { attachSummaries, overlayLive } from "./overlay";
import {
  EMPTY_VERSION_NOTE,
  PREFIX_EMPTY,
  type KobeMessageMeta,
  type LiveOverlay,
  type Node,
  type ProjectedItem,
  type Projection,
  type ToolResultInfo,
} from "./types";
/**
 * The conversation as assistant-ui messages, with the head on the branch on screen: `head` is
 * where it ends (this tab's local head, CT3), `leafEntryId` the thread's leaf, which keeps its own
 * rules (a stopped answer the member chose, markers ending at the leaf). Default: the leaf.
 */
export function projectThread(
  entries: readonly ThreadEntry[],
  head: string | null,
  leafEntryId: string | null = head,
  live?: LiveOverlay,
): Projection {
  const parsed = new Map(entries.map((e) => [e.entryId, parseEntry(e)] as const));
  const { summaries, hidden } = hiddenEntries(entries, parsed, leafEntryId);
  const treeEntries = hidden.size === 0 ? entries : entries.filter((e) => !hidden.has(e.entryId));
  const results = new Map<string, ToolResultInfo>();
  const resultEntries = new Map<string, ThreadEntry>();
  for (const entry of treeEntries) {
    const p = parsed.get(entry.entryId);
    if (p?.kind === "toolResult") {
      results.set(p.toolCallId, { text: p.text, isError: p.isError });
      resultEntries.set(p.toolCallId, entry);
    }
  }
  const {
    nodes,
    order,
    nodeOfEntry,
    lastEntryOfNode,
    markers: book,
  } = buildNodes(treeEntries, parsed);
  const markersOf = (node: Node) =>
    nodeMarkers(book, { id: node.id, role: node.role, listed: node.entries.length }, leafEntryId);
  const tools = live?.run.tools ?? {};
  const history: HistoryContext = {
    resultAt: (call) => {
      const stored = resultEntries.get(call);
      return stored ? entryTime(stored) : undefined;
    },
  };
  const promptOf = (node: Node): string | undefined => {
    const seen = new Set<string>();
    for (let at = node.parentId; at !== null && !seen.has(at);) {
      seen.add(at);
      const up = nodes.get(at);
      if (!up) return undefined;
      if (up.role === "user") return up.id;
      at = up.parentId;
    }
    return undefined;
  };

  const built: ProjectedItem[] = [];
  const indexOf = new Map<string, number>();
  for (const id of order) {
    const node = nodes.get(id) as Node;
    const first = node.entries[0] as ThreadEntry;
    if (node.role === "user") {
      const p = parsed.get(first.entryId);
      const split = splitAttachedFiles(p?.kind === "user" ? p.text : "");
      const { text, skill, references } = withoutSkillLine(split.text);
      const { deps: markerDeps, ...markers } = markersOf(node);
      const meta: KobeMessageMeta = {
        kind: "user",
        entryId: first.entryId,
        parentEntryId: first.parentId,
        text,
        ...(skill === null ? {} : { skill }),
        ...(references.length === 0 ? {} : { references }),
        pending: false,
        ...(split.files.length > 0 ? { attachments: split.files } : {}),
        ...markers,
      };
      indexOf.set(id, built.length);
      built.push({
        parentId: node.parentId,
        message: {
          id,
          role: "user",
          content: [{ type: "text", text }],
          metadata: { custom: meta },
        },
        deps: [first, ...markerDeps],
      });
    } else {
      const content = node.entries.flatMap((e, i) => [
        ...entryParts(e, parsed.get(e.entryId) as ParsedEntry, results, tools, history),
        ...innerMarkerParts(book, node, i),
      ]);
      const { deps: markerDeps, ...markers } = markersOf(node);
      const trimmed = node.entries.flatMap((e) => {
        const p = parsed.get(e.entryId);
        return e.payloadTruncated && p?.kind === "toolResult"
          ? [[p.toolCallId, e.entryId] as const]
          : [];
      });
      const meta: KobeMessageMeta = {
        kind: "assistant",
        entryIds: node.entries.map((e) => e.entryId),
        live: false,
        ...(trimmed.length > 0 ? { fullOutputs: Object.fromEntries(trimmed) } : {}),
        promptEntryId: promptOf(node),
        at: (node.entries.at(-1) as ThreadEntry).createdAt,
        ...(parsed.get(first.entryId)?.kind === "appCard" ? { appCard: true } : {}),
        ...markers,
      };
      indexOf.set(id, built.length);
      built.push({
        parentId: node.parentId,
        message: {
          id,
          role: "assistant",
          content,
          status: { type: "complete", reason: "stop" },
          metadata: { custom: meta },
        },
        deps: [
          ...node.entries,
          ...toolDeps(node.entries, parsed, resultEntries, tools),
          ...markerDeps,
        ],
      });
    }
  }

  // overlayLive appends to this projection's own list below; `built` is not touched again.
  const items = attachSummaries(built, indexOf, summaries, parsed, nodeOfEntry, treeEntries);
  const loaded: ReadonlySet<string> = new Set(treeEntries.map((e) => e.entryId));
  const place = (entryId: string) => placeIn(entryId, loaded, nodeOfEntry);
  const headAt = head === null ? undefined : place(head);
  let lastOfNode: ReadonlyMap<string, string> = lastEntryOfNode;
  let headId: string | null;
  if (typeof headAt === "string") headId = headAt;
  else if (headAt === null && head !== null && order.length > 0) {
    // The head is a hidden entry at the root: its branch has no message above it.
    headId = newestBelow(head, treeEntries, order) ?? null;
    const promptShown = live?.prompt !== undefined && !live.run.promptCommitted;
    if (headId === null && !promptShown) {
      headId = `${PREFIX_EMPTY}${head}`;
      items.push(emptyVersion(headId));
      lastOfNode = new Map([...lastEntryOfNode, [headId, head]]);
    }
  } else headId = order.at(-1) ?? items.at(-1)?.message.id ?? null;
  if (live) headId = overlayLive(live, items, indexOf, place, lastEntryOfNode, headId);
  return { items, headId, nodeOfEntry, lastEntryOfNode: lastOfNode, loaded, parsed };
}

/**
 * Where an entry sits: the message it belongs to, null at the root level (a hidden entry with no
 * message above it, like Pi's root settings entry), undefined when it isn't loaded.
 */
export function placeIn(
  entryId: string,
  loaded: ReadonlySet<string>,
  nodeOfEntry: ReadonlyMap<string, string>,
): string | null | undefined {
  if (!loaded.has(entryId)) return undefined;
  return nodeOfEntry.get(entryId) ?? null;
}

/**
 * Every entry below `entryId` (not itself): the projection's fallback head and the local head's
 * branch tip (`branchLeafOf`, CT3) walk the same descendants.
 */
export function descendantsOf(entryId: string, entries: readonly ThreadEntry[]): Set<string> {
  const children = new Map<string, string[]>();
  for (const e of entries) {
    if (e.parentId === null) continue;
    const list = children.get(e.parentId);
    if (list) list.push(e.entryId);
    else children.set(e.parentId, [e.entryId]);
  }
  const below = new Set<string>();
  const stack = [...(children.get(entryId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (below.has(id)) continue;
    below.add(id);
    stack.push(...(children.get(id) ?? []));
  }
  return below;
}

/** The newest message below `entryId` (the last in tree order), if any. */
export function newestBelow(
  entryId: string,
  entries: readonly ThreadEntry[],
  order: readonly string[],
): string | undefined {
  const below = descendantsOf(entryId, entries);
  return [...order].reverse().find((id) => below.has(id));
}

/** A version with nothing to show yet: the leaf is a root edit whose prompt Pi never saved. */
function emptyVersion(id: string): ProjectedItem {
  const meta: KobeMessageMeta = { kind: "assistant", entryIds: [], live: false };
  const note = { reason: "empty", message: EMPTY_VERSION_NOTE };
  return {
    parentId: null,
    message: {
      id,
      role: "assistant",
      content: [{ type: "data-kobe-problem", data: note }],
      status: { type: "complete", reason: "stop" },
      metadata: { custom: meta },
    },
    deps: [id],
  };
}
