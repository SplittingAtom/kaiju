/** Request access (KOBE-39) and blocked domains (KOBE-605) (KOBE-717 area). */
import type { FakeCore } from "./core";
import { error, json, NOW, uuid, type FakeAnswer, type FakeRequest, type Json } from "./state";

/** `/v1/egress/requests` (KOBE-39): the member's own requests; one pending per domain. */
export function egressRequests(
  k: FakeCore,
  method: string,
  url: URL,
  body: Json | undefined,
): Response {
  if (method === "GET") {
    const domain = url.searchParams.get("domain");
    return json(200, {
      requests: k.egressRequests.filter((r) => domain === null || r.domain === domain).reverse(),
    });
  }
  const domain = String(body?.domain ?? "");
  if (k.enabledDomains.has(domain)) {
    return error(409, "already_enabled", `${domain} is already enabled for your team. Try again.`);
  }
  const pending = k.egressRequests.find((r) => r.domain === domain && r.status === "pending");
  if (pending) return json(200, { request: pending });
  const request: Json = {
    id: uuid(9, k.egressRequests.length + 1),
    domain,
    pattern: domain,
    status: "pending",
    thread_id: body?.thread_id ?? null,
    requested_by: { id: uuid(8, 1), name: "Member" },
    decided_by: null,
    created_at: NOW,
    decided_at: null,
  };
  k.egressRequests.push(request);
  return json(201, { request });
}

/** `GET /v1/threads/{id}/egress-blocked` (KOBE-605): each run's first block per domain. */
export function egressBlocked(k: FakeCore, threadId: string): Json {
  const blocked: Json[] = [];
  for (const run of k.runs.values()) {
    if (run.thread_id !== threadId) continue;
    const seen = new Set<string>();
    for (const event of run.events) {
      if (event.type !== "egress.blocked" || seen.has(event.payload.domain)) continue;
      seen.add(event.payload.domain);
      blocked.push({
        run_id: run.run_id,
        user_entry_id: run.user_entry_id ?? null,
        seq: event.seq,
        ts: event.ts,
        payload: event.payload as unknown as Json,
      });
    }
  }
  return { blocked };
}

/** Answers its team-scoped paths; undefined for any other. */
export function egressArea(k: FakeCore, req: FakeRequest): FakeAnswer {
  const { method, url } = req;
  const body = req.body;
  const parts = url.pathname.split("/").filter(Boolean); // v1, area, id, action, sub
  const [, area, id] = parts;
  if (area === "egress" && id === "requests") return egressRequests(k, method, url, body);
  return undefined;
}
