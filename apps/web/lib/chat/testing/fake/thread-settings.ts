/** A thread's agent, organization, folder, Learn, context and connectors (KOBE-717 area). */
import { THREAD_CONTEXT_ERROR_MESSAGES } from "@kaiju/protocol";
import type { FakeCore } from "./core";
import { NOW, error, json, type FakeThread, type Json } from "./state";

/**
 * Like the server (KOBE-46): the owner's idle thread with an agent moves to `version`, or to the
 * agent's current one; a reader can't change the thread.
 */
export function switchAgent(k: FakeCore, thread: FakeThread, body: Json | undefined): Response {
  if (thread.read_only) return error(404, "thread_not_found", "No thread with that id.");
  if (thread.agent_id == null || thread.agent_version == null)
    return error(409, "no_agent", "This thread has no agent.");
  if (k.activeRun(thread.thread_id))
    return error(409, "thread_busy", "The thread is busy. Try again when the run ends.");
  const version = typeof body?.version === "number" ? body.version : thread.agent_current_version;
  thread.agent_version = version ?? thread.agent_version;
  return json(200, k.summary(thread));
}

/** Like the server (KOBE-458): the owner's idle agentless thread takes a runnable agent once. */
export function chooseAgent(k: FakeCore, thread: FakeThread, body: Json | undefined): Response {
  if (thread.read_only) return error(404, "thread_not_found", "No thread with that id.");
  if (thread.agent_id != null) {
    return error(409, "agent_already_chosen", "This thread already has an agent.");
  }
  if (k.activeRun(thread.thread_id))
    return error(409, "thread_busy", "The thread is busy. Try again when the run ends.");
  const agent = k.runnableAgents.find((a) => a.id === body?.agent_id);
  if (!agent) return error(404, "agent_not_found", "No agent with that id.");
  Object.assign(thread, {
    agent_id: agent.id,
    agent_model: agent.model,
    agent_name: agent.name,
    agent_status: "active",
  });
  return json(200, k.summary(thread));
}

/** Pin, unpin, archive, unarchive and move (CE19, KOBE-220), as the server rules them. */
export function organize(
  k: FakeCore,
  thread: FakeThread,
  action: string,
  body: Json | undefined,
): Response {
  const refusal = k.refuseOrganize;
  if (refusal) {
    k.refuseOrganize = null;
    return error(refusal.status, refusal.code, refusal.message);
  }
  if (thread.read_only) return error(403, "read_only", "This thread is shared with you read-only.");
  if (thread.deleted_at !== null) return error(409, "thread_in_trash", "Restore it first.");
  k.counters.organize += 1;
  const at = `2026-10-03T10:${String(k.counters.organize).padStart(2, "0")}:00.000Z`;
  if (action === "pin") {
    if (thread.archived_at) return error(409, "thread_archived", "Unarchive it first.");
    thread.pinned_at ??= at;
  } else if (action === "unpin") thread.pinned_at = null;
  else if (action === "archive") Object.assign(thread, { archived_at: at, pinned_at: null });
  else if (action === "unarchive") thread.archived_at = null;
  else {
    const target = (body?.project_id as string | null | undefined) ?? null;
    if (target !== null && !k.projects.some((p) => p.id === target)) {
      return error(404, "project_not_found", "No project with that id is available to you.");
    }
    if (k.activeRun(thread.thread_id) || k.queued(thread.thread_id).length > 0) {
      return error(409, "thread_busy", "The thread is busy.");
    }
    // A project share ends with the move; a team share stays (KOBE-221).
    Object.assign(thread, {
      project_id: target,
      visibility: thread.visibility === "team" ? "team" : "private",
    });
  }
  return json(200, k.summary(thread));
}

/** Filing (KOBE-534, TF3): the owner or a reader; refused in Trash and on test threads. */
export function fileThread(k: FakeCore, thread: FakeThread, body: Json | undefined): Response {
  const target = body?.folder_id;
  if (target !== null && typeof target !== "string") {
    return error(400, "invalid_request", "Give folder_id: a folder id, or null.");
  }
  if (thread.deleted_at !== null) return error(409, "thread_in_trash", "Restore it first.");
  if (thread.is_test === true || thread.skill_draft_id !== undefined) {
    return error(409, "test_thread", "A test conversation can't be put in a folder.");
  }
  if (target !== null && !k.folders.has(target)) {
    return error(404, "folder_not_found", "No folder with that id in this team.");
  }
  thread.folder_id = target;
  return json(200, k.summary(thread));
}

export function memoriesAnswer(k: FakeCore, thread: FakeThread): Response {
  if (thread.read_only === true) {
    return error(403, "not_owner", THREAD_CONTEXT_ERROR_MESSAGES.not_owner);
  }
  const items = k.threadMemories.get(thread.thread_id);
  return json(200, {
    thread_id: thread.thread_id,
    run_id: items === undefined ? null : "00000000-0000-4000-8000-0000000000aa",
    latest: !k.threadMemoriesEarlier.has(thread.thread_id),
    items: items ?? [],
  });
}

export function learnStateOf(k: FakeCore, thread: FakeThread): Json {
  const own = k.learnState.get(thread.thread_id);
  return {
    thread_id: thread.thread_id,
    blocker:
      own === undefined
        ? {
            code: "memory_learning_model_unavailable",
            reason: "no_learning_model",
            message: "No learning model is set.",
          }
        : null,
    running: null,
    new_messages: false,
    candidates: 0,
    passes_left: 20,
    last_failure: null,
    estimate: null,
    ...own,
  };
}

export function learnRoute(
  k: FakeCore,
  method: string,
  thread: FakeThread,
  body: Json | undefined,
): Response {
  if (thread.read_only === true)
    return error(403, "read_only", "Only the thread's author can teach Kaiju from it.");
  if (method === "GET") return json(200, learnStateOf(k, thread));
  const refusal = k.learnRefusal;
  if (refusal !== null) return error(refusal.status, refusal.code, refusal.message);
  const mode = body?.mode === "all" ? "all" : "new";
  k.learnStarts.push({ threadId: thread.thread_id, mode });
  const passId = "00000000-0000-4000-8000-00000000aa01";
  k.learnState.set(thread.thread_id, {
    ...k.learnState.get(thread.thread_id),
    running: { pass_id: passId, started_at: "2026-11-15T10:00:00.000Z" },
  });
  return json(202, {
    pass_id: passId,
    run_id: "00000000-0000-4000-8000-00000000aa02",
    model_alias: "k2",
    mode,
    input: {
      entries: 2,
      truncated: false,
      summarised: false,
      partial: false,
      estimated_tokens: 900,
    },
  });
}

export function contextAnswer(k: FakeCore, thread: FakeThread): Response {
  if (thread.read_only === true) {
    return error(403, "not_owner", THREAD_CONTEXT_ERROR_MESSAGES.not_owner);
  }
  const queue = k.threadContext.get(thread.thread_id);
  const next = queue && (queue.length > 1 ? queue.shift() : queue[0]);
  if (next === undefined) {
    return error(409, "context_unsupported", THREAD_CONTEXT_ERROR_MESSAGES.context_unsupported);
  }
  return json(next.status, next.body);
}

export function connectorsAnswer(k: FakeCore, threadId: string | null): Response {
  const off = threadId === null ? new Set<string>() : (k.connectorsOff.get(threadId) ?? new Set());
  return json(200, {
    connectors: k.chatConnectors.map((c) => ({
      ...c,
      enabled: !off.has(String(c.connector_id)),
    })),
  });
}

/** Empty stats (KOBE-842) for a thread, wire casing. */
export function emptyStats(threadId: string): Json {
  return {
    thread_id: threadId,
    as_of: NOW,
    conversation: {
      turns: 0,
      outcomes: {
        completed: 0,
        failed: 0,
        interrupted: 0,
        cancelled: 0,
        budget_stopped: 0,
        in_progress: 0,
      },
      retries: 0,
      compactions: 0,
      branch_summaries: 0,
      failures_by_code: [],
      models: [],
    },
    tools: {
      calls: 0,
      failed: 0,
      refused: 0,
      approvals: { asked: 0, allowed: 0, denied: 0, expired: 0, pending: 0 },
      skills: { uses: 0, names: [] },
      mcp: [],
    },
    tokens: {
      calls: 0,
      input: 0,
      output: 0,
      cache_read: 0,
      cache_write: 0,
      reasoning: null,
      reasoning_estimated: false,
      runs_with_reasoning: 0,
      thinking_levels: [],
      cost_usd: 0,
      unpriced_calls: 0,
    },
    performance: { first_token: null, duration: null },
    events: { kept: 0, folded: 0 },
  };
}

export function statsAnswer(k: FakeCore, thread: FakeThread): Response {
  return json(200, { ...emptyStats(thread.thread_id), ...k.threadStats.get(thread.thread_id) });
}
