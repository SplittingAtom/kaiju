import { randomUUID } from "node:crypto";
import { runRootSpanId, runTraceId } from "@kaiju/protocol";
import { mapSandboxSpanId } from "@kaiju/protocol/node";
import { initTelemetry, InMemorySpanExporter, type Telemetry } from "@kaiju/telemetry";
import { afterEach, describe, expect, it } from "vitest";
import {
  bearer,
  call,
  caseFiles,
  caseLoads,
  hits,
  leased,
  OTHER,
  principal,
  sandbox,
  SESSION_THREAD,
  setPrincipal,
  SPAN_KEY,
  team,
  token,
  useGatewayHarness,
  user,
} from "./testing/gateway-harness.js";

useGatewayHarness();

describe("tracing (KOBE-10)", () => {
  let telemetry: Telemetry | undefined;
  afterEach(async () => {
    await telemetry?.shutdown();
    telemetry = undefined;
  });
  function trace(captureContent: boolean) {
    const exporter = new InMemorySpanExporter();
    telemetry = initTelemetry(
      { enabled: true, endpoint: "http://x:4318", headers: {}, captureContent, serviceName: "t" },
      { exporter },
    );
    return exporter;
  }
  const PROMPT = "summarise the secret merger plan";
  const send = (t: string) =>
    call(`/v1/chat/completions?key=${t}`, {
      headers: bearer(t),
      body: { model: "openai/m", messages: [{ role: "user", content: PROMPT }] },
    });

  it("records ids, model and sizes but no prompt, query or credential by default", async () => {
    const exporter = trace(false);
    const t = token();
    expect((await send(t)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    const span = exporter.getFinishedSpans().find((s) => s.name === "model_gateway.request");
    expect(span?.attributes).toMatchObject({
      "kobe.team_id": team,
      "kobe.user_id": user,
      "kobe.sandbox_id": sandbox,
      "gen_ai.request.model": "openai/m",
      "http.response.status_code": 200,
    });
    const dump = JSON.stringify(exporter.getFinishedSpans().map((s) => s.attributes));
    expect(dump).not.toContain(PROMPT);
    expect(dump).not.toContain(t);
    expect(dump).not.toContain("gen_ai.prompt");
  });

  const RUN = "3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6071";
  const OTHER_RUN = "9e8d7c6b-5a49-4382-b170-6f5e4d3c2b1a";
  const tp = (runId: string, span = "b7ad6b7169203331") => `00-${runTraceId(runId)}-${span}-01`;
  const gatewaySpan = (exporter: InMemorySpanExporter) =>
    exporter.getFinishedSpans().find((s) => s.name === "model_gateway.request");

  it("never joins the caller's trace without an attributed run (KOBE-274)", async () => {
    const exporter = trace(false);
    await call("/v1/chat/completions", { headers: { ...bearer(), traceparent: tp(RUN) } });
    const span = gatewaySpan(exporter);
    expect(span?.spanContext().traceId).not.toBe(runTraceId(RUN));
    expect(span?.parentSpanContext).toBeUndefined();
    const upstream = String(hits[0]?.headers.traceparent);
    expect(upstream).toContain(span?.spanContext().traceId);
    expect(upstream).toContain(span?.spanContext().spanId);
  });

  it("places the call in its run's trace under the caller's remapped span, with the session", async () => {
    const exporter = trace(false);
    leased.add(RUN);
    await call("/v1/chat/completions", {
      headers: { ...bearer(), "x-kobe-run-id": RUN, traceparent: tp(RUN) },
    });
    await new Promise((r) => setTimeout(r, 20));
    const span = gatewaySpan(exporter);
    expect(span?.spanContext().traceId).toBe(runTraceId(RUN));
    expect(span?.parentSpanContext?.spanId).toBe(
      mapSandboxSpanId(SPAN_KEY, RUN, "b7ad6b7169203331"),
    );
    expect(span?.attributes).toMatchObject({
      "session.id": SESSION_THREAD,
      "user.id": user,
      "kobe.thread_id": SESSION_THREAD,
      "kobe.run_id": RUN,
    });
    expect(String(hits[0]?.headers.traceparent)).toContain(runTraceId(RUN));
  });

  it("puts a call naming another run's trace in its own run's trace, under the root", async () => {
    const exporter = trace(false);
    leased.add(RUN);
    await call("/v1/chat/completions", {
      headers: { ...bearer(), "x-kobe-run-id": RUN, traceparent: tp(OTHER_RUN) },
    });
    const span = gatewaySpan(exporter);
    expect(span?.spanContext().traceId).toBe(runTraceId(RUN));
    expect(span?.parentSpanContext?.spanId).toBe(runRootSpanId(RUN));
  });

  it("adds the prompt only with content capture on", async () => {
    const exporter = trace(true);
    await send(token());
    await new Promise((r) => setTimeout(r, 20));
    const span = exporter.getFinishedSpans()[0];
    expect(String(span?.attributes["gen_ai.prompt"])).toContain(PROMPT);
  });
});

describe("shared eval cases for an Orbit eval Job (KOBE-276)", () => {
  const get = (headers: Record<string, string>) =>
    call("/kobe/eval-cases", { method: "GET", headers });

  it("serves the running eval's cases with its own token, from the store, never via Bifrost", async () => {
    caseFiles.set(sandbox, '{"cases":[]}\n');
    const res = await get(bearer());
    expect(res.status).toBe(200);
    expect(res.text).toBe('{"cases":[]}\n');
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(caseLoads).toEqual([[team, user, sandbox]]);
    expect(hits).toEqual([]);
  });

  it("refuses without a valid token, for a revoked principal, another method, or no cases", async () => {
    caseFiles.set(sandbox, "{}");
    expect((await get({})).status).toBe(401);
    expect((await get(bearer(token({ key: OTHER.signing })))).status).toBe(401);
    expect((await call("/kobe/eval-cases", { headers: bearer() })).status).toBe(404);
    expect((await get(bearer(token({ sub: randomUUID() })))).status).toBe(404);
    setPrincipal({ ...principal, sandbox: "revoked" });
    expect((await get(bearer())).status).toBe(403);
    expect(caseLoads.map((l) => l[2])).not.toContain(undefined);
    expect(hits).toEqual([]);
  });
});
