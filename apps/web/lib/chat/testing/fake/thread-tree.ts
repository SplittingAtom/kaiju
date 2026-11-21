/** A thread's tree: lineage, labels, card, Compact now and branch summaries (KOBE-717 area). */
import {
  BRANCH_SUMMARIES_MAX,
  branchSummaryError,
  COMPACT_THREAD_ERROR_MESSAGES,
  type BranchSummaryResponse,
  type CompactThreadResponse,
  type ThreadLineageResponse,
} from "@kobe/protocol";
import type { FakeCore } from "./core";
import { error, json, NOW, type FakeThread, type Json } from "./state";

/**
 * `GET /v1/threads/{id}/lineage` (TL1, KOBE-533), like the server: up the readable sources
 * (`forked_from_thread_id`), root first; a fork whose source is unnamed has a hidden root unless
 * `forked_from_purged`; siblings and forks newest activity first.
 */
export function lineage(k: FakeCore, thread: FakeThread): ThreadLineageResponse {
  const all = [...k.threads.values()].filter((t) => t.is_test !== true);
  const forksOf = (id: string) =>
    all
      .filter((t) => t.forked_from_thread_id === id)
      .sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at))
      .map((t) => ({
        thread_id: t.thread_id,
        title: t.title,
        deleted_at: t.deleted_at,
        owner: t.read_only === true ? ("other" as const) : ("me" as const),
        forked_at_entry_id: t.forked_at_entry_id ?? null,
      }));
  const parentOf = (t: FakeThread) =>
    t.forked_from_thread_id ? k.threads.get(t.forked_from_thread_id) : undefined;
  const siblings = (t: FakeThread) => {
    const parent = parentOf(t);
    return parent ? forksOf(parent.thread_id) : [];
  };
  const path: FakeThread[] = [];
  let top: FakeThread = thread;
  for (let p = parentOf(thread); p && path.length < 20; p = parentOf(p)) {
    path.unshift(p);
    top = p;
  }
  const rootHidden =
    !top.forked_from_thread_id && top.forked_at_entry_id != null && top.forked_from_purged !== true;
  return {
    thread_id: thread.thread_id,
    root_hidden: rootHidden,
    ancestors: path.map((a) => ({
      thread_id: a.thread_id,
      title: a.title,
      deleted_at: a.deleted_at,
      siblings: siblings(a),
      siblings_more: false,
    })),
    self: {
      thread_id: thread.thread_id,
      title: thread.title,
      forked_at_entry_id: thread.forked_at_entry_id ?? null,
      siblings: siblings(thread),
      siblings_more: false,
    },
    forks: forksOf(thread.thread_id),
    forks_more: false,
  };
}

/**
 * `PUT /v1/threads/{id}/labels/{entryId}` (CT9, KOBE-543), like the server: owner only, refused
 * in Trash and on test threads, 404 for an entry not in the thread; answers the `branches` body.
 */
export function setLabel(
  k: FakeCore,
  thread: FakeThread,
  entryId: string,
  body: Record<string, unknown> | undefined,
) {
  if (thread.read_only) return error(403, "read_only", "This thread is shared with you read-only.");
  if (thread.deleted_at !== null) return error(409, "thread_in_trash", "Restore it first.");
  if (thread.is_test === true) return error(409, "test_thread", "Not on a test thread.");
  if (!thread.entries.some((e) => e.entry_id === entryId))
    return error(404, "entry_not_found", "Entry not found.");
  const raw = body?.label;
  if (raw !== null && (typeof raw !== "string" || raw.trim() === "" || raw.length > 60))
    return error(400, "invalid_request", "Give a label of 1-60 characters, or null.");
  k.labelWrites.push({ threadId: thread.thread_id, entryId, label: raw });
  const was = k.branches.get(thread.thread_id) ?? { labels: [], runs: [] };
  const others = was.labels.filter((l) => l.entry_id !== entryId);
  const labels = raw === null ? others : [...others, { entry_id: entryId, label: raw.trim() }];
  k.branches.set(thread.thread_id, { ...was, labels });
  return json(200, k.branches.get(thread.thread_id) as unknown as Json);
}

/** `GET /v1/threads/{id}/card` (KOBE-219), like the server: first message, agent, count. */
export function card(k: FakeCore, thread: FakeThread): Json {
  const messages = thread.entries.filter((e) => e.type === "message");
  const role = (e: (typeof messages)[number]) =>
    (e.payload as { message?: { role?: string } }).message?.role;
  const first = messages.find((e) => role(e) === "user");
  const content = (first?.payload as { message?: { content?: unknown } } | undefined)?.message
    ?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((p: { text?: string }) => p.text ?? "").join("")
        : "";
  const flat = text.replace(/\s+/g, " ").trim();
  return {
    thread_id: thread.thread_id,
    first_message: flat === "" ? null : flat.slice(0, 280),
    first_message_truncated: flat.length > 280,
    agent_id: thread.agent_id ?? null,
    agent_name: thread.agent_name ?? null,
    last_activity_at: thread.last_activity_at,
    message_count: messages.filter((e) => role(e) === "user" || role(e) === "assistant").length,
    message_count_capped: false,
  };
}

/** Like the server (KOBE-213): idle threads only; Pi's `compaction` entry becomes the leaf. */
export function compact(k: FakeCore, thread: FakeThread, body: Json | undefined): Response {
  if (thread.read_only) return error(403, "read_only", "This thread is shared with you read-only.");
  if (thread.status !== "idle" || k.activeRun(thread.thread_id)) {
    return error(409, "thread_busy", COMPACT_THREAD_ERROR_MESSAGES.thread_busy);
  }
  const parent = thread.leaf_entry_id;
  const id = `kc-${thread.entries.length + 1}`;
  const focus = typeof body?.focus === "string" ? ` Focus: ${body.focus}` : "";
  const summary = `Summary of the earlier conversation.${focus}`;
  thread.entries.push({
    entry_id: id,
    parent_id: parent,
    seq: thread.entries.length + 1,
    type: "compaction",
    payload: {
      type: "compaction",
      id,
      parentId: parent,
      timestamp: NOW,
      summary,
      firstKeptEntryId: parent ?? id,
      tokensBefore: 1234,
    },
    payload_offloaded: false,
    created_at: NOW,
  });
  thread.leaf_entry_id = id;
  return json(200, {
    thread_id: thread.thread_id,
    summary,
    first_kept_entry_id: parent ?? id,
    tokens_before: 1234,
  } satisfies CompactThreadResponse);
}

/**
 * Like the server (KOBE-548, CT11): owner, idle, not a test thread, a known entry other than the
 * leaf, at most 20 summaries; Pi's `branch_summary` lands under the target and becomes the leaf.
 */
export function branchSummary(k: FakeCore, thread: FakeThread, body: Json | undefined): Response {
  k.branchSummaryRequests.push(body ?? {});
  const refuse = (code: Parameters<typeof branchSummaryError>[0], status: number) =>
    json(status, branchSummaryError(code));
  if (thread.read_only) return refuse("read_only", 403);
  if (thread.is_test === true) return refuse("test_thread", 409);
  if (
    thread.status !== "idle" ||
    k.activeRun(thread.thread_id) ||
    k.queued(thread.thread_id).length > 0
  )
    return refuse("thread_busy", 409);
  const to = typeof body?.to_entry_id === "string" ? body.to_entry_id : "";
  if (!thread.entries.some((e) => e.entry_id === to))
    return error(404, "entry_not_found", "That message is not in this conversation.");
  if (to === thread.leaf_entry_id) return refuse("nothing_to_summarize", 409);
  if (thread.entries.filter((e) => e.type === "branch_summary").length >= BRANCH_SUMMARIES_MAX)
    return refuse("summary_limit", 409);
  const id = `kb-${thread.entries.length + 1}`;
  const focus = typeof body?.focus === "string" ? ` Focus: ${body.focus}` : "";
  thread.entries.push({
    entry_id: id,
    parent_id: to,
    seq: thread.entries.length + 1,
    type: "branch_summary",
    payload: {
      type: "branch_summary",
      id,
      parentId: to,
      timestamp: NOW,
      fromId: thread.leaf_entry_id,
      summary: `Summary of the branch left.${focus}`,
    },
    payload_offloaded: false,
    created_at: NOW,
  });
  thread.leaf_entry_id = id;
  const done: BranchSummaryResponse = {
    thread_id: thread.thread_id,
    entry_id: id,
    leaf_entry_id: id,
  };
  return json(200, done);
}
