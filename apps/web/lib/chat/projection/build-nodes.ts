/**
 * The projection's nodes and message parts (KOBE-716: out of `lib/chat/tree.ts`): entries grouped
 * into messages, their parts, and the entries that never become messages.
 */
import { recordedModel, type ParsedEntry } from "../entries";
import { entryTime, stepStart, timing, type PartTiming } from "../history";
import type { LiveMessage, ToolActivity } from "../live";
import {
  childCarry,
  innerMarkers,
  markerPlacer,
  type Carry,
  type MarkerBook,
} from "../marker-placement";
import { entryMarker, type BranchModels } from "../markers";
import type { ThreadEntry } from "../types";
import { PART_MARKER, type MessagePart, type Node, type ToolResultInfo } from "./types";
function isAssistantSide(parsed: ParsedEntry): boolean {
  return parsed.kind === "assistant" || parsed.kind === "toolResult" || parsed.kind === "offloaded";
}

/** Builds the nodes; iterative so a long thread can't overflow the stack. */
export function buildNodes(
  entries: readonly ThreadEntry[],
  parsed: ReadonlyMap<string, ParsedEntry>,
) {
  const present = new Set(entries.map((e) => e.entryId));
  const byId = new Map(entries.map((e) => [e.entryId, e] as const));
  const parentOf = new Map(entries.map((e) => [e.entryId, e.parentId] as const));
  const children = new Map<string | null, ThreadEntry[]>();
  for (const entry of entries) {
    const key = entry.parentId !== null && present.has(entry.parentId) ? entry.parentId : null;
    const list = children.get(key);
    if (list) list.push(entry);
    else children.set(key, [entry]);
  }

  const nodes = new Map<string, Node>();
  const order: string[] = [];
  const nodeOfEntry = new Map<string, string>();
  const lastEntryOfNode = new Map<string, string>();
  const placer = markerPlacer();
  const create = (
    id: string,
    parentId: string | null,
    role: Node["role"],
    entry: ThreadEntry,
    carry: Carry,
  ) => {
    nodes.set(id, { id, parentId, role, entries: [entry] });
    order.push(id);
    lastEntryOfNode.set(id, entry.entryId);
    placer.created(id, carry);
    return id;
  };
  const attach = (nodeId: string, entry: ThreadEntry, listed: boolean) => {
    if (listed) nodes.get(nodeId)?.entries.push(entry);
    if (lastEntryOfNode.get(nodeId) === entry.parentId) lastEntryOfNode.set(nodeId, entry.entryId);
  };

  type Frame = {
    entry: ThreadEntry;
    parentNode: string | null;
    group: string | null;
    carry: Carry;
    /** The models the branch records above this entry (KOBE-280). */
    models: BranchModels;
  };
  const none: BranchModels = { model: null, from: null };
  const stack: Frame[] = (children.get(null) ?? [])
    .map((entry): Frame => ({ entry, parentNode: null, group: null, carry: [], models: none }))
    .reverse();
  while (stack.length > 0) {
    const { entry, parentNode, group, carry, models } = stack.pop() as Frame;
    const p = parsed.get(entry.entryId) as ParsedEntry;
    const kids = children.get(entry.entryId) ?? [];
    let ctx: string | null;
    let openGroup: string | null;
    let childParent: string | null = parentNode;
    let next: Carry = null;
    if (p.kind === "user") {
      ctx = create(entry.entryId, group ?? parentNode, "user", entry, carry);
      openGroup = null;
      childParent = ctx;
    } else if (p.kind === "appCard") {
      // A rail launch (KOBE-440): its own message, never part of an answer; what follows hangs
      // below it.
      ctx = create(entry.entryId, group ?? parentNode, "assistant", entry, carry);
      openGroup = null;
      childParent = ctx;
    } else if (isAssistantSide(p)) {
      if (group !== null) {
        attach(group, entry, true);
        ctx = group;
      } else {
        ctx = create(entry.entryId, parentNode, "assistant", entry, carry);
      }
      openGroup = ctx;
    } else {
      ctx = group ?? parentNode;
      if (ctx !== null) attach(ctx, entry, false);
      openGroup = group;
      next = placer.hidden({
        entry,
        marker: entryMarker(entry, parsed, parentOf, byId, models),
        ctx,
        listed: ctx === null ? 0 : (nodes.get(ctx)?.entries.length ?? 0),
        carry,
        kids: kids.length,
      });
    }
    if (ctx !== null) nodeOfEntry.set(entry.entryId, ctx);

    const branches = kids.length > 1 && openGroup !== null;
    const childrenCarry = childCarry(next, kids.length);
    // A message, or a fork that starts carrying, starts a new row of markers below it.
    const model = recordedModel(entry, p) ?? models.model;
    const message = p.kind === "user" || p.kind === "appCard" || isAssistantSide(p);
    const startsRow = message || (kids.length > 1 && next === null);
    const childModels: BranchModels = { model, from: startsRow ? model : models.from };
    for (let i = kids.length - 1; i >= 0; i--) {
      stack.push({
        entry: kids[i] as ThreadEntry,
        parentNode: branches ? openGroup : childParent,
        group: branches ? null : openGroup,
        carry: childrenCarry,
        models: childModels,
      });
    }
  }
  return { nodes, order, nodeOfEntry, lastEntryOfNode, markers: placer.book() };
}

/** Markers inside a turn, after its `index`-th listed entry, as message parts. */
export function innerMarkerParts(book: MarkerBook, node: Node, index: number): MessagePart[] {
  return innerMarkers(book, node.id, index, node.entries.length).map(
    (data) => ({ type: PART_MARKER, data }) as MessagePart,
  );
}

function toolCallPart(
  toolCallId: string,
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  result: ToolResultInfo | undefined,
  time?: PartTiming,
): MessagePart {
  return {
    type: "tool-call",
    toolCallId,
    toolName,
    args: args as never,
    argsText: JSON.stringify(args),
    ...(result ? { result: result.text, isError: result.isError } : {}),
    ...(time ? { timing: time } : {}),
  };
}

/** What the rich history (KOBE-208) adds to committed parts. */
export interface HistoryContext {
  /** When Pi stored a tool call's result. */
  readonly resultAt: (toolCallId: string) => number | undefined;
}

function liveResult(activity: ToolActivity | undefined): ToolResultInfo | undefined {
  const result = activity?.result;
  if (!result) return undefined;
  return {
    text: result.truncated ? `${result.preview}…` : result.preview,
    isError: result.is_error,
  };
}

export function entryParts(
  entry: ThreadEntry,
  p: ParsedEntry,
  results: ReadonlyMap<string, ToolResultInfo>,
  tools: Readonly<Record<string, ToolActivity>>,
  history: HistoryContext,
): MessagePart[] {
  if (p.kind === "offloaded") {
    return [{ type: "data-kaiju-offloaded", data: { entryId: entry.entryId } }];
  }
  if (p.kind === "appCard") {
    return [{ type: "data-kaiju-app-card", data: { entryId: entry.entryId, tool: p.tool } }];
  }
  if (p.kind !== "assistant") return [];
  const parts: MessagePart[] = [];
  const end = entryTime(entry);
  const thought = timing(stepStart(entry), end);
  for (const piece of p.pieces) {
    if (piece.kind === "text") parts.push({ type: "text", text: piece.text });
    else if (piece.kind === "reasoning") {
      parts.push({ type: "reasoning", text: piece.text, ...(thought ? { timing: thought } : {}) });
    } else {
      const result = results.get(piece.toolCallId) ?? liveResult(tools[piece.toolCallId]);
      const time = timing(end, history.resultAt(piece.toolCallId));
      parts.push(toolCallPart(piece.toolCallId, piece.toolName, piece.args, result, time));
    }
  }
  if (p.problem) parts.push({ type: "data-kaiju-problem", data: p.problem });
  return parts;
}

export function liveParts(
  messages: readonly LiveMessage[],
  tools: Readonly<Record<string, ToolActivity>>,
) {
  const parts: MessagePart[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.kind !== "tool") {
        parts.push({ type: part.kind === "text" ? "text" : "reasoning", text: part.text });
      } else {
        const activity = tools[part.toolCallId];
        const call = activity?.call;
        parts.push(
          toolCallPart(
            part.toolCallId,
            call?.tool ?? "tool",
            (call?.input ?? {}) as Readonly<Record<string, unknown>>,
            liveResult(activity),
          ),
        );
      }
    }
  }
  return parts;
}

export function toolDeps(
  entries: readonly ThreadEntry[],
  parsed: ReadonlyMap<string, ParsedEntry>,
  resultEntries: ReadonlyMap<string, ThreadEntry>,
  tools: Readonly<Record<string, ToolActivity>>,
) {
  const deps: unknown[] = [];
  for (const entry of entries) {
    const p = parsed.get(entry.entryId);
    if (p?.kind !== "assistant") continue;
    for (const piece of p.pieces) {
      if (piece.kind === "toolCall") {
        deps.push(resultEntries.get(piece.toolCallId), tools[piece.toolCallId]);
      }
    }
  }
  return deps;
}

/**
 * Empty answers Pi wrote when a run was stopped before its first token (KOBE-290) that a later
 * run branched beside: Pi keeps them, but they are no version of anything, so they would show as
 * a fork ("2 branches") on the next message. Hidden unless something hangs below or the member
 * chose that branch (the leaf).
 */
function staleStoppedAnswers(
  entries: readonly ThreadEntry[],
  parsed: ReadonlyMap<string, ParsedEntry>,
  leafEntryId: string | null,
): ReadonlySet<string> {
  const kids = new Map<string | null, number>();
  for (const e of entries) kids.set(e.parentId, (kids.get(e.parentId) ?? 0) + 1);
  const stale = new Set<string>();
  for (const e of entries) {
    const p = parsed.get(e.entryId);
    const empty =
      p?.kind === "assistant" && p.problem?.reason === "aborted" && p.pieces.length === 0;
    if (!empty || e.entryId === leafEntryId || (kids.get(e.entryId) ?? 0) > 0) continue;
    if ((kids.get(e.parentId) ?? 0) > 1) stale.add(e.entryId);
  }
  return stale;
}

/**
 * Entries that never enter the tree as messages or branches: skipped-actions reports (cards) and
 * stale stopped answers (KOBE-290). projectThread and the tree's junction count share this rule.
 */
export function hiddenEntries(
  entries: readonly ThreadEntry[],
  parsed: ReadonlyMap<string, ParsedEntry>,
  leafEntryId: string | null,
): { readonly summaries: readonly ThreadEntry[]; readonly hidden: ReadonlySet<string> } {
  const summaries = entries.filter((e) => parsed.get(e.entryId)?.kind === "skipped");
  const stale = staleStoppedAnswers(entries, parsed, leafEntryId);
  if (summaries.length === 0) return { summaries, hidden: stale };
  return { summaries, hidden: new Set([...stale, ...summaries.map((e) => e.entryId)]) };
}
