/**
 * Branches (CT3, CT8, CT11, CT15): the tab's local head and the thread's leaf, as actions through
 * the controller's port (KOBE-716).
 */
import type { ApiError, ApiResult } from "../../api/client";
import type { BranchSummaryResult } from "../api";
import { branchLeafOf, headOf, isBrowsing, onBranchOf, pathOf } from "../head";
import type { ThreadSummary } from "../types";
import type { ControllerPort } from "./port";

/** The web offers a carried summary only off the leaf's branch (CT11; the server allows it). */
export const ON_LEAF_BRANCH: ApiError = {
  status: 0,
  code: "on_leaf_branch",
  message: "This message is on the current branch: there is no other branch to summarize.",
};

/** Moves this tab's head (never the leaf); "Showing another branch" when the bar comes up. */
export function moveHead(
  port: ControllerPort,
  head: string | undefined,
  reveal?: string,
  continueFrom?: string,
): void {
  const was = isBrowsing(port.state());
  port.set((s) => ({
    ...s,
    head,
    // Another branch shown drops Continue from here (CT8), unless that is what moved the head.
    continueFrom,
    ...(reveal === undefined ? {} : { reveal: { entryId: reveal, seq: (s.reveal?.seq ?? 0) + 1 } }),
  }));
  if (!was && isBrowsing(port.state())) port.announce("Showing another branch");
}

/** Scrolls the conversation to an entry already on screen (the tree's node, KOBE-546). */
export function reveal(port: ControllerPort, entryId: string): void {
  port.set((s) => ({ ...s, reveal: { entryId, seq: (s.reveal?.seq ?? 0) + 1 } }));
}

/** Shows the version a reader's branch picker chose, ending at that entry (never writes). */
export function showVersion(port: ControllerPort, entryId: string): void {
  if (port.state().entries.some((e) => e.entryId === entryId)) moveHead(port, entryId);
}

/** The next send continues the branch on screen again (Continue from here ends). */
export function clearContinue(port: ControllerPort): void {
  if (port.state().continueFrom !== undefined) {
    port.set((s) => ({ ...s, continueFrom: undefined }));
  }
}

/** The newest branch at or below an entry (the tree, KOBE-546); the leaf stays. */
export function showBranch(port: ControllerPort, entryId: string, reveal?: string): void {
  const s = port.state();
  const tip = branchLeafOf(s.entries, entryId);
  const leaf = s.summary?.leafEntryId ?? null;
  if (tip !== undefined) moveHead(port, tip === leaf ? undefined : tip, reveal);
}

/** Continue from here (CT8, KOBE-546); see `ThreadController.continueFrom`. */
export function continueFromAnswer(port: ControllerPort, entryId: string): void {
  const s = port.state();
  if (!s.entries.some((e) => e.entryId === entryId)) return;
  const onScreen = pathOf(s.entries, headOf(s)).has(entryId);
  const leaf = s.summary?.leafEntryId ?? null;
  const tip = onScreen ? s.head : branchLeafOf(s.entries, entryId);
  moveHead(port, tip === leaf ? undefined : tip, entryId, entryId);
  port.announce("Continuing from this answer");
}

/** A search hit in a read thread (CT15): off the leaf's branch the head moves to its branch. */
export function showHitNow(port: ControllerPort, entryId: string): void {
  const s = port.state();
  if (!s.entries.some((e) => e.entryId === entryId)) return;
  const leaf = s.summary?.leafEntryId ?? null;
  const off = !onBranchOf(s.entries, leaf, entryId);
  moveHead(port, off ? branchLeafOf(s.entries, entryId) : undefined, entryId);
}

/** Shows another branch (assistant-ui's branch picker) and makes it the thread's leaf. */
export async function switchLeaf(port: ControllerPort, entryId: string): Promise<void> {
  const { threadId, summary, head } = port.state();
  if (threadId === null || !summary) return;
  // Back to the leaf's own version: a local move, nothing to write.
  if (summary.leafEntryId === entryId) {
    moveHead(port, undefined);
    return;
  }
  const previous = summary.leafEntryId;
  port.bumpLeafVersion();
  // Another branch: the follow-ups were for the answer that is no longer shown (review N1).
  port.set((s) =>
    s.summary
      ? {
          ...s,
          followups: undefined,
          head: undefined,
          summary: { ...s.summary, leafEntryId: entryId },
        }
      : s,
  );
  const res = await port.busy("leaf", () => port.api.setLeaf(threadId, entryId));
  if (!res.ok) {
    port.set((s) =>
      s.summary ? { ...s, head, summary: { ...s.summary, leafEntryId: previous } } : s,
    );
    port.fail(res.error);
    return;
  }
  port.set((s) => ({ ...s, summary: res.data }));
  port.leafMoved(threadId);
}

/** Make it current and carry a summary (KOBE-548, CT11); see `ThreadController.carrySummary`. */
export async function carrySummary(
  port: ControllerPort,
  target: string,
  focus?: string,
): Promise<ApiResult<BranchSummaryResult> | undefined> {
  const { threadId, summary, entries, busy } = port.state();
  if (threadId === null || !summary || summary.readOnly === true) return undefined;
  const leaf = summary.leafEntryId;
  if (leaf === null || onBranchOf(entries, leaf, target))
    return { ok: false, error: ON_LEAF_BRANCH };
  if (busy.includes("leaf")) return undefined;
  port.bumpLeafVersion();
  const res = await port.busy("leaf", () =>
    port.api.branchSummary(threadId, {
      to_entry_id: target,
      ...(focus === undefined ? {} : { focus }),
    }),
  );
  if (!res.ok) {
    // As Make it current: the dialog shows every refusal; a busy one stays there alone.
    if (res.error.code !== "thread_busy") port.fail(res.error);
    return res;
  }
  port.set((s) => ({ ...s, followups: undefined, head: undefined }));
  await port.refresh();
  port.leafMoved(threadId);
  port.announce("This branch is now current");
  return res;
}

/** Make it current (owner); see `ThreadController.makeCurrent`. */
export async function makeCurrent(
  port: ControllerPort,
  entryId?: string,
): Promise<ApiResult<ThreadSummary> | undefined> {
  const state = port.state();
  const { threadId, summary, entries } = state;
  if (threadId === null || !summary || summary.readOnly === true) return undefined;
  const head =
    entryId === undefined
      ? isBrowsing(state)
        ? state.head
        : undefined
      : branchLeafOf(entries, entryId);
  if (head === undefined || head === summary.leafEntryId) return undefined;
  if (state.busy.includes("leaf")) return undefined;
  port.bumpLeafVersion();
  const res = await port.busy("leaf", () => port.api.setLeaf(threadId, head));
  if (!res.ok) {
    if (res.error.code !== "thread_busy") port.fail(res.error);
    return res;
  }
  port.set((s) => ({
    ...s,
    followups: undefined,
    summary: res.data,
    // The tree's node is current now: the conversation shows it.
    ...(entryId === undefined ? {} : { head: undefined }),
  }));
  port.leafMoved(threadId);
  port.announce("This branch is now current");
  return res;
}
