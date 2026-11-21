import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { describe, expect, it } from "vitest";
import { usageRecordOf } from "./usage/sink.js";
import {
  base,
  bearer,
  call,
  hits,
  leased,
  must,
  OTHER,
  principal,
  records,
  sandbox,
  SESSION,
  setGate,
  setPrincipal,
  team,
  token,
  upstreamClosedEarly,
  useGatewayHarness,
  user,
  vkValue,
} from "./testing/gateway-harness.js";

useGatewayHarness();

describe("authentication", () => {
  it("refuses no token, a forged token, another audience's token and an expired one", async () => {
    const now = Math.floor(Date.now() / 1000);
    for (const headers of [
      {},
      { authorization: "Bearer not.a.token" },
      bearer(token({ key: OTHER.signing })),
      bearer(token({ aud: "kobe.egress-proxy", key: SESSION.signing })),
      bearer(token({ exp: now - 1 })),
      { authorization: "Basic a29iZTpwYXNz" },
    ]) {
      const r = await call("/v1/chat/completions", { headers });
      expect(r.status, JSON.stringify(headers)).toBe(401);
      expect(JSON.parse(r.text).error.code).toBe("invalid_session_token");
    }
    expect(hits).toEqual([]);
  });

  it("refuses two different credentials in one request", async () => {
    const r = await call("/anthropic/v1/messages", {
      headers: { ...bearer(), "x-api-key": token() },
    });
    expect(r.status).toBe(401);
  });

  it("refuses a revoked principal (left the team, sandbox destroyed) after the cache TTL", async () => {
    expect((await call("/v1/chat/completions", { headers: bearer() })).status).toBe(200);
    setPrincipal({ ...principal, member: false });
    const r = await call("/anthropic/v1/messages", {
      headers: { "x-api-key": token(), "anthropic-version": "2023-06-01" },
    });
    expect(r.status).toBe(401);
    expect(JSON.parse(r.text)).toMatchObject({
      type: "error",
      error: { type: "session_revoked" },
    });
    setPrincipal({ ...principal, member: true, sandbox: "revoked" });
    expect((await call("/v1/chat/completions", { headers: bearer() })).status).toBe(401);
    expect(hits).toHaveLength(1);
  });
});

describe("routing", () => {
  it("lists only the team's enabled models (the Site embedding model stays out, KOBE-409 L4)", async () => {
    const r = await call("/v1/models", { method: "GET", headers: bearer() });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.text) as { object: string; data: { id: string }[] };
    expect(body.object).toBe("list");
    expect(body.data).toEqual([
      { id: "openai/m", object: "model", created: 1, owned_by: "openai" },
      { id: "gemini/g", object: "model", owned_by: "gemini" },
    ]);
    expect(Number(r.headers.get("content-length"))).toBe(Buffer.byteLength(r.text));
  });

  it("serves inference paths only: admin API, health, batches and unknown paths are 404", async () => {
    for (const [method, path] of [
      ["GET", "/api/providers"],
      ["POST", "/api/governance/virtual-keys"],
      ["GET", "/health"],
      ["POST", "/anthropic/v1/messages/batches"],
      ["POST", "/v1/files"],
      ["GET", "/v1/chat/completions"],
      ["POST", "/v1/../api/providers"],
      ["POST", "/v1/%2e%2e/api/config"],
      ["POST", "/genai/v1beta/models/x:batchGenerateContent"],
    ] as const) {
      const r = await call(path, { method, headers: bearer() });
      expect(r.status, `${method} ${path}`).toBe(404);
    }
    expect(hits).toEqual([]);
  });

  it("forwards with the member's virtual key and only allowlisted headers", async () => {
    const t = token();
    const r = await call(`/v1/chat/completions?key=${t}&foo=bar`, {
      headers: {
        ...bearer(t),
        cookie: "a=b",
        "x-bf-direct-key": "true",
        "x-bf-eh-authorization": "Bearer stolen",
        "x-forwarded-for": "1.2.3.4",
        "openai-beta": "assistants=v2",
        "x-stainless-lang": "js",
      },
    });
    expect(r.status).toBe(200);
    const hit = hits[0];
    expect(hit?.path).toBe("/v1/chat/completions");
    expect(hit?.headers["x-bf-vk"]).toBe(vkValue);
    for (const h of [
      "authorization",
      "cookie",
      "x-bf-direct-key",
      "x-bf-eh-authorization",
      "x-forwarded-for",
    ]) {
      expect(hit?.headers[h], h).toBeUndefined();
    }
    expect(hit?.headers["openai-beta"]).toBe("assistants=v2");
    expect(hit?.headers["x-stainless-lang"]).toBe("js");
    expect(records[0]).toMatchObject({
      teamId: team,
      userId: user,
      sandboxId: sandbox,
      model: "openai/m",
      status: 200,
    });
  });

  it("KOBE-327: an eval sandbox's call is usage kind eval and carries the eval cap", async () => {
    const r = await call("/v1/chat/completions", {
      headers: bearer(token({ evalThread: randomUUID() })),
    });
    expect(r.status).toBe(200);
    expect(records[0]).toMatchObject({ teamId: team, sandboxId: sandbox, eval: true });
    expect(usageRecordOf(must(records[0]))?.kind).toBe("eval");
    const plain = await call("/v1/chat/completions", { headers: bearer(token()) });
    expect(plain.status).toBe(200);
    expect(records[1]?.eval).toBeUndefined();
    expect(usageRecordOf(must(records[1]))?.kind).toBeUndefined();
  });

  it("takes the token from each SDK's header and strips it (Anthropic, Gemini, ?key=)", async () => {
    const anthropic = await call("/anthropic/v1/messages", {
      headers: {
        "x-api-key": token(),
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "prompt-caching-2024-07-31",
      },
    });
    expect(anthropic.status).toBe(200);
    expect(hits[0]?.headers["x-api-key"]).toBeUndefined();
    expect(hits[0]?.headers["anthropic-beta"]).toBe("prompt-caching-2024-07-31");
    const gem = await call(
      `/genai/v1beta/models/gemini/gemini-2.5-pro:streamGenerateContent?alt=sse&key=${token()}`,
      { body: { contents: [] } },
    );
    expect(gem.status).toBe(200);
    expect(hits[1]?.path).toBe(
      "/genai/v1beta/models/gemini/gemini-2.5-pro:streamGenerateContent?alt=sse",
    );
    expect(records[1]?.model).toBe("gemini/gemini-2.5-pro");
    const goog = await call("/genai/v1beta/models/gemini/g:generateContent", {
      headers: { "x-goog-api-key": token() },
    });
    expect(goog.status).toBe(200);
    expect(hits[2]?.headers["x-goog-api-key"]).toBeUndefined();
  });
});

describe("calls", () => {
  it("streams the response as it arrives, without Bifrost's cookies or x-bf headers", async () => {
    const started = Date.now();
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { ...bearer(), "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/m", stream: true }),
    });
    expect(res.headers.get("set-cookie")).toBeNull();
    const reader = res.body?.getReader();
    const first = await reader?.read();
    expect(Buffer.from(first?.value ?? []).toString()).toContain("data: one");
    expect(Date.now() - started).toBeLessThan(250);
    let rest = "";
    for (;;) {
      const chunk = await reader?.read();
      if (!chunk || chunk.done) break;
      rest += Buffer.from(chunk.value).toString();
    }
    expect(rest).toContain("[DONE]");
  });

  it("cancels the upstream call when the sandbox goes away", async () => {
    await new Promise<void>((resolve) => {
      const req = request(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { ...bearer(), "content-type": "application/json" },
      });
      req.on("response", (res) => {
        res.once("data", () => {
          req.destroy();
          resolve();
        });
      });
      req.end(JSON.stringify({ model: "openai/m", stream: true }));
    });
    for (let i = 0; i < 50 && upstreamClosedEarly === 0; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(upstreamClosedEarly).toBeGreaterThan(0);
    for (let i = 0; i < 50 && records.length === 0; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(records[0]?.aborted).toBe(true);
    // KOBE-43: a stream cut short is charged an estimate, never nothing.
    expect(records[0]?.usage?.source).toBe("estimated");
    expect(records[0]?.usage?.counts.input).toBeGreaterThan(0);
  });

  it("KOBE-43: asks for the usage report of a streaming chat call (include_usage forced)", async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { ...bearer(), "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai/m",
        stream: true,
        stream_options: { include_usage: false },
      }),
    });
    await res.text();
    expect(hits[0]?.body.endsWith(',"stream_options":{"include_usage":true}}')).toBe(true);
    // A non-streaming call is forwarded as sent.
    await call("/v1/chat/completions", { headers: bearer(), body: { model: "openai/m" } });
    expect(hits[1]?.body).toBe(JSON.stringify({ model: "openai/m" }));
  });

  it("KOBE-43: charges the input of a call Bifrost got but the sandbox hung up on", async () => {
    await new Promise<void>((resolve) => {
      const req = request(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { ...bearer(), "content-type": "application/json" },
      });
      req.on("error", () => resolve());
      req.end(JSON.stringify({ model: "openai/m", slow: true, pad: "p".repeat(400) }));
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 150);
    });
    for (let i = 0; i < 50 && records.length === 0; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(records[0]).toMatchObject({ aborted: true });
    expect(records[0]?.usage?.source).toBe("estimated");
    expect(records[0]?.usage?.counts.input).toBeGreaterThan(100);
    // The output the provider may already have produced: what the request allowed (no cap: 8,192).
    expect(records[0]?.usage?.counts.output).toBe(8_192);
  });

  it("KOBE-43 review: a 5xx is charged like a call cut short; a 4xx refusal is free", async () => {
    const r = await call("/v1/chat/completions", {
      headers: bearer(),
      body: { model: "openai/m", fail: 500, max_tokens: 300 },
    });
    expect(r.status).toBe(500);
    expect(records[0]?.usage).toEqual({
      source: "estimated",
      counts: { input: expect.any(Number), output: 300, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it("KOBE-43 re-review: a count-only endpoint is never charged output", async () => {
    const r = await call("/anthropic/v1/messages/count_tokens", {
      headers: bearer(),
      body: { model: "openai/m", fail: 500, max_tokens: 300 },
    });
    expect(r.status).toBe(500);
    expect(records[0]?.usage?.counts.output).toBe(0);
  });

  it("KOBE-43 review: refuses background Responses (billed later, out of the ledger's sight)", async () => {
    const r = await call("/v1/responses", {
      headers: bearer(),
      body: { model: "x", background: true },
    });
    expect(r.status).toBe(400);
    expect(JSON.parse(r.text).error.code).toBe("background_not_supported");
    expect(hits).toEqual([]);
    expect(records).toEqual([]);
  });

  it("limits concurrent calls per sandbox (429)", async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { ...bearer(), "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/m", stream: true }),
    });
    const second = await call("/v1/chat/completions", { headers: bearer() });
    expect(second.status).toBe(429);
    await res.text();
    expect((await call("/v1/responses", { headers: bearer(), body: { model: "x" } })).status).toBe(
      200,
    );
  });

  it("passes Bifrost's refusals through (status, body), without its x-bf headers", async () => {
    const r = await call("/v1/chat/completions", { headers: bearer(), body: { model: "blocked" } });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.text).type).toBe("model_blocked");
    expect(r.headers.get("x-bf-internal")).toBeNull();
    expect(records[0]).toMatchObject({ status: 403, errorType: "model_blocked" });
    expect(records[0]?.usage).toEqual({
      source: "reported",
      counts: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it("refuses an oversized body (413) and lets the gate refuse before Bifrost", async () => {
    const big = await call("/v1/chat/completions", {
      headers: bearer(),
      body: { x: "a".repeat(5000) },
    });
    expect(big.status).toBe(413);
    setGate({
      admit: async () => ({
        ok: false,
        status: 402,
        code: "budget_exhausted",
        message: "Team budget reached",
      }),
    });
    const refused = await call("/v1/chat/completions", { headers: bearer() });
    expect(refused.status).toBe(402);
    expect(JSON.parse(refused.text).error.code).toBe("budget_exhausted");
    // Refused before Bifrost: no usage to record.
    expect(records.at(-1)?.usage).toBeUndefined();
    expect(hits).toEqual([]);
  });

  it("attributes a run only when it is leased to this sandbox", async () => {
    const runId = randomUUID();
    expect(
      (await call("/v1/chat/completions", { headers: { ...bearer(), "x-kobe-run-id": runId } }))
        .status,
    ).toBe(403);
    leased.add(runId);
    expect(
      (await call("/v1/chat/completions", { headers: { ...bearer(), "x-kobe-run-id": runId } }))
        .status,
    ).toBe(200);
    expect(hits[0]?.headers["x-kobe-run-id"]).toBeUndefined();
    expect(records.at(-1)?.runId).toBe(runId);
    expect(
      (await call("/v1/chat/completions", { headers: { ...bearer(), "x-kobe-run-id": "nope" } }))
        .status,
    ).toBe(400);
  });
});
