/** Messages, runs, feedback and eval cases (D17, KOBE-30/275/276) (KOBE-717 area). */
import { splitItemReferences, withItemReferences, type ItemReference } from "@kaiju/protocol";
import type { FakeCore } from "./core";
import {
  ACTIVE,
  ENDED,
  error,
  fakeDigest,
  json,
  NOW,
  uuid,
  type FakeAnswer,
  type FakeRequest,
  type FakeRun,
  type FakeThread,
  type Json,
} from "./state";

export function submit(
  k: FakeCore,
  thread: FakeThread,
  body: Json | undefined,
  key: string | null,
): Response {
  k.submittedBodies.push(body ?? {});
  if (thread.deleted_at !== null) return error(409, "thread_in_trash");
  const repeat = [...k.runs.values()].find((r) => key !== null && r.client_key === key);
  if (repeat) return json(201, { run_id: repeat.run_id, queued: repeat.status === "queued" });
  k.counters.run += 1;
  k.counters.queue += 1;
  const run: FakeRun = {
    run_id: uuid(4, k.counters.run),
    thread_id: thread.thread_id,
    status: "queued",
    // As the server (KOBE-490): the references line after the member's text.
    input: withItemReferences(
      (body?.references as readonly ItemReference[] | undefined) ?? [],
      String(body?.content ?? ""),
    ),
    parent_entry_id: (body?.parent_entry_id as string | undefined) ?? null,
    queue_pos: k.counters.queue,
    events: [],
    compacted: false,
    tip: null,
    ...(key ? { client_key: key } : {}),
  };
  k.runs.set(run.run_id, run);
  thread.last_activity_at = new Date(Date.parse(thread.last_activity_at) + 60_000).toISOString();
  if (thread.queue_paused) {
    // Sending releases a held queue: the held messages run first, then this one.
    thread.queue_paused = false;
    k.advance(thread.thread_id);
  }
  const waits = k.activeRun(thread.thread_id) !== undefined || thread.status === "interrupted";
  if (waits) {
    k.emit(run.run_id, "run.queued", {
      thread_id: thread.thread_id,
      trigger: "user",
      queue_pos: k.queued(thread.thread_id).length,
    });
  } else k.start(run);
  return json(201, { run_id: run.run_id, queued: waits });
}

/**
 * `POST /v1/runs/{id}/eval-case[/preview]` (KOBE-276): the owner's thumbs down only; the copy
 * adds a tool output or file name only when its id is ticked; the share needs the preview's
 * digest (a stand-in hash of the content, like the server's).
 */
export function evalCase(
  k: FakeCore,
  method: string,
  runId: string,
  sub: string | undefined,
  body: Json | undefined,
): Response {
  const run = k.runs.get(runId);
  if (!run || method !== "POST") return error(404, "run_not_found", "No answer with that id.");
  const rating = k.feedback.get(runId);
  const thread = k.threads.get(run.thread_id);
  if (rating?.rating !== "down" || thread?.read_only === true) {
    return error(409, "not_shareable", "Only your own thumbs down can be shared.");
  }
  const available = (k.evalCaseAvailable.get(runId) ?? {
    earlier_exchanges: 0,
    tool_outputs: [],
    attachments: [],
  }) as { earlier_exchanges: number; tool_outputs: Json[]; attachments: Json[] };
  const ticked = (key: string) => (Array.isArray(body?.[key]) ? (body[key] as string[]) : []);
  const tools = ticked("tool_output_ids");
  const files = ticked("attachment_ids");
  const known = (list: Json[], ids: string[]) => ids.every((i) => list.some((x) => x.id === i));
  if (!known(available.tool_outputs, tools) || !known(available.attachments, files)) {
    return error(400, "invalid_request");
  }
  const earlier = Math.min(Number(body?.earlier_exchanges ?? 0), available.earlier_exchanges);
  const content = {
    prompt: run.input || "The prompt",
    answer: "Seven, it said.",
    earlier: Array.from({ length: earlier }, (_, i) => [
      { role: "user", text: `Earlier prompt ${i + 1}` },
      { role: "assistant", text: `Earlier answer ${i + 1}` },
    ]).flat(),
    tool_outputs: available.tool_outputs
      .filter((t) => tools.includes(t.id as string))
      .map((t) => ({ tool: t.tool, text: `Output of ${t.id as string}`, is_error: false })),
    attachments: available.attachments
      .filter((a) => files.includes(a.id as string))
      .map((a) => ({ name: a.name, mime_type: a.mime_type, size_bytes: a.size_bytes })),
    reasons: rating.reasons ?? [],
    comment: rating.comment ?? null,
    truncated: false,
  };
  const digest = fakeDigest(JSON.stringify(content));
  const shared = k.evalCases.get(runId);
  if (sub === "preview") {
    return json(200, {
      run_id: runId,
      agent: { scope: "team", id: uuid(7, 1), version: 1 },
      content,
      digest,
      available,
      shared_case_id: shared?.id ?? null,
    });
  }
  if (shared) return error(409, "already_shared", "You already shared this answer.");
  if (body?.digest !== digest) {
    return error(409, "preview_stale", "What would be shared changed since the preview.");
  }
  k.counters.evalCase += 1;
  const stored = {
    id: uuid(8, k.counters.evalCase),
    agent: { scope: "team", id: uuid(7, 1), version: 1 },
    status: "open",
    content,
    shared_at: NOW,
  };
  k.evalCases.set(runId, stored);
  return json(201, stored);
}

/** `PUT` / `DELETE /v1/runs/{id}/feedback` (KOBE-275), checked like the server's schema. */
export function feedbackRoute(
  k: FakeCore,
  method: string,
  run: FakeRun,
  body: Json | undefined,
): Response {
  if (method === "DELETE") {
    k.feedback.delete(run.run_id);
    return new Response(null, { status: 204 });
  }
  if (method !== "PUT") return error(405, "method_not_allowed");
  if (!ENDED.has(run.status)) return error(409, "run_not_ended", "Wait for the answer.");
  const rating = body?.rating;
  const reasons = Array.isArray(body?.reasons) ? (body.reasons as string[]) : [];
  const comment = typeof body?.comment === "string" ? body.comment.trim() : null;
  if (rating !== "up" && rating !== "down") return error(400, "invalid_request");
  if (rating === "up" && (reasons.length > 0 || comment !== null))
    return error(400, "invalid_request");
  if (comment !== null && (comment === "" || comment.length > 500))
    return error(400, "invalid_request");
  const before = k.feedback.get(run.run_id);
  const stored = {
    run_id: run.run_id,
    thread_id: run.thread_id,
    entry_id: typeof body?.entry_id === "string" ? body.entry_id : (before?.entry_id ?? null),
    rating,
    reasons,
    comment,
    updated_at: NOW,
  };
  k.feedback.set(run.run_id, stored);
  return json(200, stored);
}

export function runRoute(
  k: FakeCore,
  method: string,
  id: string,
  action: string | undefined,
  body: Json | undefined,
): Response {
  const run = k.runs.get(id);
  if (!run) return error(404, "run_not_found", "No run with that id.");
  if (action === undefined && method === "GET") return json(200, k.snapshot(run));
  if (action === "feedback") return feedbackRoute(k, method, run, body);
  if (action === "usage" && method === "GET") {
    return json(
      200,
      k.usage.get(id) ?? {
        run_id: id,
        models: [],
        calls: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        cost_usd: 0,
        unpriced_calls: 0,
        estimated_calls: 0,
      },
    );
  }
  if (action === undefined && method === "PATCH") {
    if (run.status !== "queued") return error(409, "invalid_transition");
    // As the server: the references line stays, never repeated (KOBE-490).
    run.input = withItemReferences(
      splitItemReferences(run.input).references,
      splitItemReferences(String(body?.content)).rest,
    );
    return json(200, k.snapshot(run));
  }
  if (action === "steer") {
    if (!ACTIVE.has(run.status)) return error(409, "invalid_transition", "The run already ended.");
    k.emit(run.run_id, "steer.applied", { content: String(body?.content) });
    return json(200, k.snapshot(run));
  }
  if (action === "cancel") return cancel(k, run);
  if (action === "retry") return retry(k, run);
  return error(404, "not_found");
}

export function cancel(k: FakeCore, run: FakeRun): Response {
  if (run.status === "queued") {
    run.status = "cancelled";
    return json(200, k.snapshot(run));
  }
  if (!ACTIVE.has(run.status)) return json(200, k.snapshot(run));
  const thread = k.thread(run.thread_id);
  if (k.pauseOnStop && k.queued(run.thread_id).length > 0) thread.queue_paused = true;
  k.end(run, "cancelled", "run.interrupted", {
    reason: "cancelled",
    last_entry_id: run.tip,
    retryable: false,
  });
  k.advance(run.thread_id);
  return json(200, k.snapshot(run));
}

export function retry(k: FakeCore, run: FakeRun): Response {
  const thread = k.thread(run.thread_id);
  if (run.status !== "interrupted" || thread.status !== "interrupted") {
    return error(409, "invalid_transition", "Only an interrupted run can be retried.");
  }
  k.counters.run += 1;
  const retry: FakeRun = {
    run_id: uuid(4, k.counters.run),
    thread_id: run.thread_id,
    status: "queued",
    input: run.input,
    parent_entry_id: run.parent_entry_id,
    queue_pos: 0,
    retry_of_run_id: run.run_id,
    events: [],
    compacted: false,
    tip: null,
  };
  k.runs.set(retry.run_id, retry);
  thread.status = "idle";
  k.start(retry);
  return json(201, { run_id: retry.run_id, queued: false });
}

/** Answers its team-scoped paths; undefined for any other. */
export function runsArea(k: FakeCore, req: FakeRequest): FakeAnswer {
  const { method, url } = req;
  const body = req.body;
  const parts = url.pathname.split("/").filter(Boolean); // v1, area, id, action, sub
  const [, area, id, action, sub] = parts;
  if (area === "runs" && id && action === "eval-case") return evalCase(k, method, id, sub, body);
  if (area === "runs" && id) return runRoute(k, method, id, action, body);
  if (area === "eval-cases" && id && method === "DELETE") {
    for (const [runId, c] of k.evalCases) if (c.id === id) k.evalCases.delete(runId);
    return new Response(null, { status: 204 });
  }
  return undefined;
}
