import { randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  SecretBox,
  VIRTUAL_KEY_PURPOSE,
  virtualKeyContext,
  type GatewayPrincipal,
} from "@kaiju/db";
import type { SessionTokenAudience } from "@kaiju/protocol";
import { deriveTraceSpanKey } from "@kaiju/protocol/node";
import {
  generateSessionKeyPair,
  signSessionToken,
  verifySessionToken,
  type SessionSigningKey,
} from "@kaiju/session-token";
import pino from "pino";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import { createModelGateway } from "../gateway.js";
import { ByteBudget, CallLimiter, RequestRate } from "../limits.js";
import { PrincipalCache } from "../principals.js";
import { OPEN_GATE, type CallGate, type CallRecord } from "../seams.js";

/**
 * The shared harness of the gateway's unit tests (gateway*.test.ts): a fake Bifrost, a shim on
 * it, a fake principal store and case store, and what they recorded. Test-only (not built).
 */

export const SESSION = generateSessionKeyPair();
export const OTHER = generateSessionKeyPair();
export const box = new SecretBox("v".repeat(40), VIRTUAL_KEY_PURPOSE);
export const team = randomUUID();
export const user = randomUUID();
export const sandbox = randomUUID();
export const logger = pino({ level: "silent" });

export function token(
  over: Partial<{
    aud: SessionTokenAudience;
    exp: number;
    sub: string;
    key: SessionSigningKey;
    evalThread: string;
  }> = {},
) {
  const now = Math.floor(Date.now() / 1000);
  return signSessionToken(
    {
      iss: "kobe-server",
      aud: over.aud ?? "kobe.model-gateway",
      sub: over.sub ?? sandbox,
      team_id: team,
      user_id: user,
      iat: now - 10,
      exp: over.exp ?? now + 900,
      jti: randomUUID().replace(/-/g, ""),
      ...(over.evalThread ? { eval_thread: over.evalThread } : {}),
    },
    over.key ?? SESSION.signing,
  );
}

/** Fake Bifrost: knows some virtual keys; records what reached it; streams on request. */
export interface Hit {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}
export let bifrost: Server;
export let bifrostUrl = "";
export const hits: Hit[] = [];
export const knownVks = new Set<string>();
export let upstreamClosedEarly = 0;

// Per test: the principal store, the shim, and what it recorded.
export let principal: GatewayPrincipal;
export let vkValue = "";
export let keyRequests = 0;
export let leased = new Set<string>();
/** Run tokens are signed with the model-gateway pair, as session tokens (KOBE-521). */
export const RUN_KEY = SESSION.signing;
export const SPAN_KEY = deriveTraceSpanKey(new TextEncoder().encode("r".repeat(40)));
export const SESSION_THREAD = "2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60";
/** jti of the run tokens the (fake) record still holds as active. */
export let activeTokens = new Set<string>();
export let records: CallRecord[] = [];
export let forgot = 0;
export let gate: CallGate = OPEN_GATE;
export let shim: Server = createServer();
export let base = "";
export const cacheTtl = 0;
/** After the first load, the store returns this (the sync stored a new key meanwhile). */
export let afterFirstLoad: GatewayPrincipal | undefined;
export let loads = 0;

export function setVk(value: string | undefined) {
  vkValue = value ?? "";
  principal = {
    ...principal,
    virtualKey: value
      ? { id: "vk-id", valueEnc: box.seal(value, virtualKeyContext(team, user)) }
      : undefined,
  };
}

export const ENABLED = ["openai/m", "x", "blocked", "gemini/gemini-2.5-pro", "gemini/g"];
export let leaseChecks = 0;
export let loadDelayMs = 0;

export interface ShimOptions {
  readonly perSandboxCalls?: number;
  readonly bytes?: { perSandbox: number; total: number };
  readonly rate?: { burst: number; perSecond: number };
  readonly requireRunToken?: boolean;
}

/** What the fake case store answers, by eval id (KOBE-276); the calls it saw. */
export let caseFiles = new Map<string, string>();
export let caseLoads: [string, string, string][] = [];

export async function start(over: ShimOptions = {}): Promise<void> {
  if (shim.listening) {
    shim.closeAllConnections();
    await new Promise<void>((r) => shim.close(() => r()));
  }
  const cache = new PrincipalCache(
    {
      load: async () => {
        if (loadDelayMs) await new Promise((r) => setTimeout(r, loadDelayMs));
        return loads++ > 0 && afterFirstLoad ? afterFirstLoad : principal;
      },
      requestKey: async () => {
        keyRequests++;
      },
    },
    box,
    { ttlMs: cacheTtl, keyWaitMs: 1_000, keyPollMs: 20 },
  );
  shim = createModelGateway({
    verify: (t) => verifySessionToken(t, "kobe.model-gateway", SESSION.verify),
    principals: cache,
    isRunLeased: async (_t, runId) => {
      leaseChecks++;
      return leased.has(runId);
    },
    runTokens: {
      keys: SESSION.verify,
      isActive: async (s) => activeTokens.has(s.jti),
      require: over.requireRunToken ?? false,
    },
    tracing: {
      spanKey: SPAN_KEY,
      runSession: async () => ({ threadId: SESSION_THREAD, userId: user }),
    },
    bifrostUrl,
    limiter: new CallLimiter({ perSandbox: over.perSandboxCalls ?? 1, total: 10 }),
    bytes: new ByteBudget(over.bytes ?? { perSandbox: 8192, total: 16384 }),
    rate: new RequestRate(over.rate ?? { burst: 1000, perSecond: 1000 }),
    gate: { admit: (c) => gate.admit(c) },
    sink: { record: (r) => records.push(r) },
    onBifrostForgotKey: () => {
      forgot++;
    },
    logger,
    settings: { maxBodyBytes: 4096, idleTimeoutMs: 5_000 },
    ready: () => true,
    evalCases: {
      load: async (t, u, e) => {
        caseLoads.push([t, u, e]);
        return caseFiles.get(e) ?? null;
      },
    },
  });
  await new Promise<void>((r) => shim.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(shim.address() as AddressInfo).port}`;
}

export async function call(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; headers: Headers; text: string }> {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "POST",
    headers: { "content-type": "application/json", ...init.headers },
    ...(init.method === "GET" ? {} : { body: JSON.stringify(init.body ?? { model: "openai/m" }) }),
  });
  return { status: res.status, headers: res.headers, text: await res.text() };
}
export const bearer = (t = token()) => ({ authorization: `Bearer ${t}` });

export function setPrincipal(value: GatewayPrincipal): void {
  principal = value;
}
export function setGate(value: CallGate): void {
  gate = value;
}
export function setLoadDelayMs(value: number): void {
  loadDelayMs = value;
}
export function setAfterFirstLoad(value: GatewayPrincipal | undefined): void {
  afterFirstLoad = value;
}

export function must<T>(x: T | undefined): T {
  if (x === undefined) throw new Error("missing");
  return x;
}

/**
 * Registers the fake Bifrost (per file) and a fresh shim with clean records (per test); call it
 * at the top of each gateway test file.
 */
export function useGatewayHarness(): void {
  beforeAll(async () => {
    bifrost = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        hits.push({
          path: req.url ?? "",
          headers: req.headers,
          body: Buffer.concat(chunks).toString(),
        });
        const vk = req.headers["x-bf-vk"];
        if (typeof vk !== "string" || !knownVks.has(vk)) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ type: "access_not_found", error: { message: "no such key" } }));
          return;
        }
        if (Buffer.concat(chunks).toString().includes('"model":"blocked"')) {
          res.writeHead(403, { "content-type": "application/json", "x-bf-internal": "1" });
          res.end(JSON.stringify({ type: "model_blocked", error: { message: "not allowed" } }));
          return;
        }
        if (Buffer.concat(chunks).toString().includes('"fail":500')) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ type: "provider_server_error", error: { message: "boom" } }));
          return;
        }
        if (Buffer.concat(chunks).toString().includes('"slow":true')) {
          // Answers late: lets a test hang up before Bifrost's response headers.
          const t = setTimeout(() => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end("{}");
          }, 500);
          res.on("close", () => clearTimeout(t));
          return;
        }
        if (req.url === "/v1/models") {
          // Bifrost lists every model the virtual key allows, the Site embedding model too.
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              object: "list",
              data: [
                { id: "openai/m", object: "model", created: 1, owned_by: "openai" },
                { id: "kobe-local/nomic-embed-text", object: "model", owned_by: "kobe-local" },
                { id: "gemini/g", object: "model", owned_by: "gemini" },
              ],
            }),
          );
          return;
        }
        if (
          req.url?.startsWith("/v1/chat/completions") &&
          chunks.join("").includes('"stream":true')
        ) {
          res.writeHead(200, { "content-type": "text/event-stream", "set-cookie": "x=1" });
          res.write("data: one\n\n");
          const t = setTimeout(() => {
            res.write("data: two\n\n");
            res.end("data: [DONE]\n\n");
          }, 300);
          res.on("close", () => {
            if (!res.writableFinished) {
              upstreamClosedEarly++;
              clearTimeout(t);
            }
          });
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, path: req.url }));
      });
    });
    await new Promise<void>((r) => bifrost.listen(0, "127.0.0.1", r));
    bifrostUrl = `http://127.0.0.1:${(bifrost.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => bifrost.close(() => r())));
  beforeEach(async () => {
    hits.length = 0;
    caseFiles = new Map();
    caseLoads = [];
    records = [];
    forgot = 0;
    keyRequests = 0;
    leaseChecks = 0;
    loadDelayMs = 0;
    leased = new Set();
    activeTokens = new Set();
    gate = OPEN_GATE;
    knownVks.clear();
    principal = { member: true, sandbox: "live", virtualKey: undefined, enabledModels: ENABLED };
    afterFirstLoad = undefined;
    loads = 0;
    setVk(`sk-bf-${randomUUID()}`);
    knownVks.add(vkValue);
    await start();
  });
  afterEach(async () => {
    shim.closeAllConnections();
    await new Promise<void>((r) => shim.close(() => r()));
  });
}
