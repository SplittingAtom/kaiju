/** One thread's routes (`/v1/threads/{id}/…`) (KOBE-717 area). */
import { launch } from "./apps";
import type { FakeCore } from "./core";
import { egressBlocked } from "./egress";
import { submit } from "./runs";
import {
  ENDED,
  error,
  json,
  NOW,
  ORGANIZE,
  type FakeEntry,
  type FakeThread,
  type Json,
} from "./state";
import {
  chooseAgent,
  connectorsAnswer,
  contextAnswer,
  fileThread,
  learnRoute,
  memoriesAnswer,
  organize,
  statsAnswer,
  switchAgent,
} from "./thread-settings";
import { branchSummary, card, compact, lineage, setLabel } from "./thread-tree";

/** `/v1/threads/{id}/<action>[/<sub>]` of a thread the caller may read. */
export function threadAction(
  k: FakeCore,
  method: string,
  thread: FakeThread,
  action: string,
  sub: string | undefined,
  url: URL,
  body: Json | undefined,
  headers: Headers,
): Response {
  if (action === "entries" && sub !== undefined && url.pathname.endsWith("/output")) {
    return toolOutput(k, thread, sub);
  }
  if (action === "entries") return json(200, k.entryPage(thread, url));
  if (action === "file-links" && method === "GET") {
    return k.fileLinks.route(url) ?? error(404, "not_found");
  }
  if (action === "learn") return learnRoute(k, method, thread, body);
  if (action === "connectors" && method === "GET") return connectorsAnswer(k, thread.thread_id);
  if (action === "connectors" && method === "PUT" && sub !== undefined) {
    const row = k.chatConnectors.find((c) => c.connector_id === sub);
    if (!row) return error(404, "connector_not_found", "That connector isn't available.");
    if (row.problem != null) {
      return error(409, "connector_not_working", "That connector isn't working right now.");
    }
    const off = new Set(k.connectorsOff.get(thread.thread_id) ?? []);
    if (body?.enabled === false) off.add(String(sub));
    else off.delete(String(sub));
    k.connectorsOff.set(thread.thread_id, off);
    return json(200, { connector: { ...row, enabled: body?.enabled !== false } });
  }
  if (action === "skills" && method === "GET") {
    return json(200, { skills: k.chatSkills.map((name) => ({ name })) });
  }
  // `/export` (KOBE-450): the owner's conversation as Markdown, or the refusal set here.
  if (action === "export" && method === "GET") {
    const refusal = k.exportRefusal;
    if (refusal) return error(refusal.status, refusal.code, refusal.message);
    return new Response(`# ${thread.title ?? "Untitled"}\n`, {
      status: 200,
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="2026-10-20-export-${thread.thread_id.slice(0, 8)}.md"`,
      },
    });
  }
  if (action === "context" && sub === "memories" && method === "GET") {
    return memoriesAnswer(k, thread);
  }
  if (action === "context" && method === "GET") return contextAnswer(k, thread);
  if (action === "stats" && method === "GET") return statsAnswer(k, thread);
  if (action === "usage" && method === "GET") {
    const runs = k.threadUsage.get(thread.thread_id) ?? [];
    const latest = k.threadLatestCall.get(thread.thread_id) ?? null;
    return json(200, { thread_id: thread.thread_id, runs, latest_call: latest });
  }
  if (action === "app-cards" && method === "POST" && sub === undefined) {
    return launch(k, thread.thread_id, body?.app_id);
  }
  if (action === "app-cards" && method === "DELETE" && sub !== undefined) {
    const waiting = k.queuedCards.get(thread.thread_id) ?? [];
    if (!waiting.some((c) => c.ref === sub)) return error(404, "not_found", "No waiting card.");
    k.queuedCards.set(
      thread.thread_id,
      waiting.filter((c) => c.ref !== sub),
    );
    k.appResults.set(
      thread.thread_id,
      (k.appResults.get(thread.thread_id) ?? []).filter((v) => v.result_ref !== sub),
    );
    return new Response(null, { status: 204 });
  }
  if (action === "app-results" && method === "GET") {
    if (sub === undefined) {
      return json(200, {
        results: k.appResults.get(thread.thread_id) ?? [],
        truncated: false,
      });
    }
    const body = k.appResultBodies.get(sub);
    return body === undefined
      ? error(409, "text_only", "This app shows as text for you.")
      : json(200, { result: body });
  }
  if (action === "markers" && method === "GET") {
    return json(200, k.threadMarkers.get(thread.thread_id) ?? { runs: [], approvals: [] });
  }
  if (action === "feedback" && method === "GET") {
    // Like the server: the thread's ended runs with their prompt and the caller's rating.
    const answers = [...k.runs.values()]
      .filter((r) => r.thread_id === thread.thread_id && ENDED.has(r.status))
      .map((r) => ({
        run_id: r.run_id,
        user_entry_id: r.user_entry_id ?? null,
        feedback: k.feedback.get(r.run_id) ?? null,
        eval_case_id: (k.evalCases.get(r.run_id)?.id as string | undefined) ?? null,
      }));
    return json(200, { thread_id: thread.thread_id, answers });
  }
  if (action === "share" && method === "POST") {
    if (thread.read_only)
      return error(403, "read_only", "This thread is shared with you read-only.");
    const visibility = body?.visibility;
    if (visibility !== "private" && visibility !== "project" && visibility !== "team")
      return error(400, "invalid_request", "Give visibility: private, project or team.");
    if (visibility === "project" && !thread.project_id)
      return error(409, "not_in_project", "Only threads in a project can be shared.");
    thread.visibility = visibility;
    return json(200, k.summary(thread));
  }
  if (action === "compact" && method === "POST") return compact(k, thread, body);
  if (action === "branch-summary" && method === "POST") return branchSummary(k, thread, body);
  if (action === "agent-version" && method === "POST") return switchAgent(k, thread, body);
  if (action === "agent" && method === "POST") return chooseAgent(k, thread, body);
  if (ORGANIZE.has(action) && method === "POST") return organize(k, thread, action, body);
  if (action === "file" && method === "POST") return fileThread(k, thread, body);
  if (action === "fork" && method === "POST") {
    // Root to the entry (default: the leaf), with the source as provenance (KOBE-216).
    const at = typeof body?.entry_id === "string" ? body.entry_id : thread.leaf_entry_id;
    const byId = new Map(thread.entries.map((e) => [e.entry_id, e]));
    if (at !== null && !byId.has(at)) return error(404, "entry_not_found", "Entry not found.");
    const path: FakeEntry[] = [];
    for (let e = at === null ? undefined : byId.get(at); e;) {
      path.unshift(e);
      e = e.parent_id === null ? undefined : byId.get(e.parent_id);
    }
    const forkId = k.addThread(typeof body?.title === "string" ? body.title : thread.title);
    const fork = k.thread(forkId);
    fork.project_id = thread.project_id ?? null;
    fork.entries = path.map((e, i) => ({ ...e, seq: i + 1 }));
    fork.leaf_entry_id = at;
    fork.forked_from_thread_id = thread.thread_id;
    fork.forked_from_title = thread.title;
    fork.forked_at_entry_id = at;
    return json(201, { thread_id: forkId });
  }
  if (action === "leaf") {
    // Like the server (CT3, KOBE-543): owner only; refused while a run is active or queued.
    if (thread.read_only)
      return error(403, "read_only", "This thread is shared with you read-only.");
    if (k.activeRun(thread.thread_id) || k.queued(thread.thread_id).length > 0)
      return error(409, "thread_busy", "The thread is busy.");
    thread.leaf_entry_id = String(body?.entry_id);
    return json(200, k.summary(thread));
  }
  if (action === "restore") {
    thread.deleted_at = null;
    return json(200, k.summary(thread));
  }
  if (action === "purge" && method === "POST") {
    if (thread.deleted_at === null) return error(409, "not_in_trash", "Move it to Trash first.");
    k.threads.delete(thread.thread_id);
    return new Response(null, { status: 204 });
  }
  if (action === "card" && method === "GET") return json(200, card(k, thread));
  if (action === "lineage" && method === "GET") return json(200, lineage(k, thread));
  if (action === "branches" && method === "GET") {
    k.branchesReads += 1;
    if (k.branchesFailing.has(thread.thread_id)) return error(500, "internal");
    return json(200, k.branches.get(thread.thread_id) ?? { labels: [], runs: [] });
  }
  if (action === "egress-blocked" && method === "GET") {
    k.egressBlockedReads += 1;
    return json(200, egressBlocked(k, thread.thread_id));
  }
  if (action === "labels" && method === "PUT" && sub !== undefined) {
    return setLabel(k, thread, sub, body);
  }
  if (action === "files" && method === "GET") {
    k.threadFilesReads += 1;
    if (k.threadFilesHidden.has(thread.thread_id)) {
      return error(404, "thread_not_found", "No thread with that id.");
    }
    return json(200, { files: k.threadFiles.get(thread.thread_id) ?? [] });
  }
  if (action === "sync-conflicts" && method === "GET") {
    k.syncConflictReads += 1;
    if (k.threadFilesHidden.has(thread.thread_id)) {
      return error(404, "thread_not_found", "No thread with that id.");
    }
    return json(200, { conflicts: k.syncConflicts.get(thread.thread_id) ?? [] });
  }
  if (action === "sync-conflicts" && method === "POST" && sub !== undefined) {
    const list = k.syncConflicts.get(thread.thread_id) ?? [];
    if (!list.some((c) => c.id === sub)) return error(404, "conflict_not_found");
    k.syncConflictActions.push({
      conflictId: sub,
      action: String((body as { action?: unknown } | undefined)?.action),
    });
    k.syncConflicts.set(
      thread.thread_id,
      list.filter((c) => c.id !== sub),
    );
    return new Response(null, { status: 204 });
  }
  if (action === "file-edit-proposals" && method === "GET") {
    return json(200, { proposals: k.fileEditProposals.get(thread.thread_id) ?? [] });
  }
  if (action === "messages") return submit(k, thread, body, headers.get("idempotency-key"));
  if (action === "runs") return json(200, k.runsOf(thread.thread_id));
  if (action === "pending-messages") return json(200, k.pendingOf(thread.thread_id));
  if (action === "queue" && sub === "resume") {
    if (thread.status === "interrupted") thread.status = "idle";
    thread.queue_paused = false;
    k.advance(thread.thread_id);
    return json(200, k.runsOf(thread.thread_id));
  }
  if (action === "queue" && sub === "pause" && method === "POST") {
    if (k.queued(thread.thread_id).length > 0) thread.queue_paused = true;
    return json(200, k.runsOf(thread.thread_id));
  }
  if (action === "queue" && sub === "order" && method === "POST") {
    const ids = ((body as { run_ids?: unknown } | undefined)?.run_ids ?? []) as string[];
    const queued = k.queued(thread.thread_id);
    const same = ids.length === queued.length && queued.every((r) => ids.includes(r.run_id));
    if (!same) return error(409, "queue_changed", "The queue changed meanwhile.");
    // Like the server: retries keep running first, each group in the order given.
    const retry = (id: string) => k.runs.get(id)?.retry_of_run_id !== undefined;
    for (const id of [...ids.filter(retry), ...ids.filter((id) => !retry(id))]) {
      const run = k.runs.get(id);
      if (run) run.queue_pos = ++k.counters.queue;
    }
    return json(200, k.runsOf(thread.thread_id));
  }
  return error(404, "not_found");
}

export function threadItself(
  k: FakeCore,
  method: string,
  thread: FakeThread,
  url: URL,
  body: Json | undefined,
): Response {
  if (method === "GET") {
    const page = k.entryPage(thread, url);
    return json(200, {
      ...k.summary(thread),
      agent_current_version: thread.agent_current_version ?? null,
      agent_model: thread.agent_model ?? null,
      agent_name: thread.agent_name ?? null,
      agent_status: thread.agent_status ?? null,
      ...page,
    });
  }
  if (method === "PATCH") {
    if (body && "model" in body) {
      const model = (body.model as string | null) ?? null;
      if (model !== null && model !== thread.model && !k.modelEnabled(model)) {
        return k.modelNotEnabled();
      }
      thread.model = model;
    }
    if (body && "thinking_level" in body) {
      thread.thinking_level = (body.thinking_level as string | null) ?? null;
    }
    if (body && "title" in body) thread.title = (body.title as string | null) ?? null;
    return json(200, k.summary(thread));
  }
  if (method === "DELETE") {
    const busy = k.activeRun(thread.thread_id) || k.queued(thread.thread_id).length > 0;
    if (busy) return error(409, "thread_busy", "Stop the run and clear the queue first.");
    thread.deleted_at = NOW;
    return json(200, k.summary(thread));
  }
  return error(405, "method_not_allowed");
}

/** `GET /v1/threads/{id}/entries/{entryId}/output` (KOBE-208): a tool output in full. */
export function toolOutput(k: FakeCore, thread: FakeThread, entryId: string): Response {
  const found = thread.entries.find((e) => e.entry_id === entryId);
  if (!found) return error(404, "entry_not_found");
  const payload = found.payload_offloaded ? k.entryBodies.get(entryId) : found.payload;
  if (!payload) return error(409, "entry_unavailable");
  const message = payload.message as Json | undefined;
  if (message?.role !== "toolResult") return error(409, "not_a_tool_output");
  const content = message.content as { type: string; text?: string }[];
  return json(200, {
    entry_id: entryId,
    tool_call_id: message.toolCallId,
    tool_name: message.toolName,
    is_error: message.isError === true,
    text: content.map((p) => p.text ?? "").join(""),
    truncated: false,
  });
}
