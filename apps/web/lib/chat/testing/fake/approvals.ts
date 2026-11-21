/** Approvals (KOBE-37) and remembered rules (KOBE-289) (KOBE-717 area). */
import type { FakeCore } from "./core";
import { error, json, type FakeAnswer, type FakeRequest, type Json } from "./state";

export function defaultRemember(k: FakeCore, approvalId: string): Json {
  const approval = k.approvals.get(approvalId);
  const payload = approval?.payload;
  const destructive = payload?.risk === "destructive";
  const scopes = [
    ["thread", "this conversation"],
    ["today", "until end of today"],
    ["run", "this run only"],
    ["day", "for 1 day"],
    ["month", "for 30 days"],
    ["forever", "until revoked"],
  ] as const;
  const strings = Object.entries(payload?.input ?? {}).filter(([, v]) => typeof v === "string");
  const waiting = [...k.approvals.entries()].filter(
    ([, a]) => a.runId === approval?.runId && a.status === "pending",
  );
  const batchable =
    waiting.length >= 2 && waiting.every(([, a]) => a.payload.risk !== "destructive");
  return {
    approval_id: approvalId,
    run_id: approval?.runId ?? "",
    can_remember: !destructive,
    reason: destructive ? "Tools that can delete data are never remembered." : null,
    choices: destructive
      ? []
      : scopes.map(([scope, label]) => ({
          scope,
          label,
          expires_at: scope === "day" ? new Date(Date.now() + 86_400_000).toISOString() : null,
        })),
    time_zone: "UTC",
    exact:
      strings.length === 0
        ? null
        : {
            arg_pattern: Object.fromEntries(strings.map(([k, v]) => [`/${k}`, v as string])),
            pins_all: true,
          },
    exact_only: false,
    approve_all: batchable ? { approval_ids: waiting.map(([id]) => id).sort() } : null,
    approve_all_reason: batchable ? null : "Only one approval is waiting in this run.",
  };
}

/** `POST /v1/approvals/approve-all`: every listed approval resolves allowed, one by one. */
export function approveAll(k: FakeCore, body: Json | undefined): Response {
  const ids = (body?.approval_ids ?? []) as string[];
  const views: Json[] = [];
  for (const id of ids) {
    const approval = k.approvals.get(id);
    if (!approval || approval.runId !== body?.run_id) {
      return error(404, "approval_not_found", "No pending approval with that id.");
    }
  }
  for (const id of ids) {
    const approval = k.approvals.get(id);
    if (!approval) continue;
    approval.status = "allowed";
    k.run(approval.runId).status = "running";
    k.emit(approval.runId, "approval.resolved", {
      approval_id: id,
      tool_call_id: approval.payload.tool_call_id,
      decision: "allowed",
      cause: "user",
      remembered: false,
    });
    views.push({ ...approval.payload, run_id: approval.runId, status: "allowed" });
  }
  return json(200, { approvals: views });
}

/** `GET`/`POST /v1/approvals/{id}`: a decision resolves the card through the stream. */
export function approvalRoute(
  k: FakeCore,
  method: string,
  id: string,
  body: Json | undefined,
): Response {
  const approval = k.approvals.get(id);
  if (!approval) return error(404, "approval_not_found", "No pending approval with that id.");
  const view = () => ({
    ...approval.payload,
    run_id: approval.runId,
    status: approval.status,
    remembered: false,
  });
  if (method === "GET") return json(200, view());
  if (approval.status !== "pending") {
    return error(409, "approval_resolved", `This approval is already ${approval.status}.`);
  }
  const allow = body?.decision === "allow";
  approval.status = allow ? "allowed" : "denied";
  k.run(approval.runId).status = "running";
  k.emit(approval.runId, "approval.resolved", {
    approval_id: id,
    tool_call_id: approval.payload.tool_call_id,
    decision: allow ? "allowed" : "denied",
    cause: "user",
    remembered: allow && body?.remember !== undefined,
  });
  return json(200, view());
}

/** Answers its team-scoped paths; undefined for any other. */
export function approvalsArea(k: FakeCore, req: FakeRequest): FakeAnswer {
  const { method, url } = req;
  const body = req.body;
  const parts = url.pathname.split("/").filter(Boolean); // v1, area, id, action, sub
  const [, area, id, action] = parts;
  if (area === "approvals" && id === "approve-all" && method === "POST") {
    return approveAll(k, body);
  }
  if (area === "approvals" && id && action === "remember" && method === "GET") {
    if (!k.approvals.has(id)) return error(404, "approval_not_found", "No approval.");
    return json(200, k.rememberOptions(id));
  }
  if (area === "approvals" && id) return approvalRoute(k, method, id, body);
  return undefined;
}
