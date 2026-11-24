import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { withRenamedHeaders, type ServerCallClaims } from "@kaiju/protocol";
import { telemetryState, traceNodeRequest, type RequestSpan } from "@kaiju/telemetry";
import type { Resolution } from "./principals.js";
import { resolveRunAttribution } from "./run-attribution.js";
import { placeRequestSpan } from "./trace-placement.js";
import { isServerCall, serverCallBodyLimit } from "./server-call.js";
import { classify, forwardedQuery, routeTemplate, type Route, type RouteKind } from "./routes.js";
import {
  authenticate,
  NO_SESSION,
  serverCallAttribution,
  type CallerIdentity,
} from "./gateway/auth.js";
import { REASONS, sendError } from "./gateway/errors.js";
import { serveEvalCases } from "./gateway/eval-cases.js";
import { createUpstream, forward, type Upstream } from "./gateway/forward.js";
import type { GatewayOptions } from "./gateway/options.js";
import { prepareBody } from "./gateway/prepare-body.js";
import { readBody } from "./gateway/read-body.js";
import { finishRequest, newRequestState, type RequestState } from "./gateway/usage.js";

export type { GatewayOptions } from "./gateway/options.js";

/** Where an Orbit eval Job reads its shared cases (KOBE-276); never forwarded to Bifrost. */
export const EVAL_CASES_PATH = "/kaiju/eval-cases";

/** One gateway: its options and its Bifrost connection. */
interface Gateway {
  readonly options: GatewayOptions;
  readonly upstream: Upstream;
}

/** One authenticated inference request on a known route, past the per-sandbox limits. */
interface InferenceRequest {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly span: RequestSpan;
  readonly url: URL;
  readonly route: Route;
  readonly kind: RouteKind;
  readonly identity: CallerIdentity;
  readonly serverCall: ServerCallClaims | undefined;
  readonly evalSandbox: boolean | undefined;
  /** Logs a refused server call (sandbox calls are not logged). */
  readonly skipped: (reason: string) => void;
}

type Resolved = Extract<Resolution, { ok: true }>;

export function createModelGateway(options: GatewayOptions): Server {
  const { logger } = options;
  const upstream = createUpstream(options);
  const gateway: Gateway = { options, upstream };

  const server = createServer((req, res) => {
    // Old header names (`x-kobe-run-id`, `x-kobe-run-token`, `x-kobe-server-call`) from sandboxes
    // and servers built before the rename count as the new ones for one release (KOBE-749; removed
    // in KOBE-754), so every check below reads only the new names.
    req.headers = withRenamedHeaders(req.headers);
    traceNodeRequest("model_gateway.request", req, res, (span) =>
      handle(gateway, req, res, span),
    ).catch((err: unknown) => {
      logger.error({ err }, "model gateway request failed");
      if (!res.headersSent) sendError(res, "openai", 500, "internal_error", "Internal error.");
      else res.destroy();
    });
  });
  // Slow-loris bounds: headers within 10 s, the request body within 2 minutes; responses
  // (streams) are bounded by the upstream idle timeout instead.
  server.headersTimeout = 10_000;
  server.requestTimeout = 120_000;
  server.keepAliveTimeout = 5_000;
  server.on("close", () => upstream.agent.destroy());
  return server;
}

async function handle(
  gateway: Gateway,
  req: IncomingMessage,
  res: ServerResponse,
  span: RequestSpan,
): Promise<void> {
  const { options } = gateway;
  const { logger } = options;
  const url = new URL(req.url ?? "/", "http://gateway.invalid");
  if (url.pathname === "/healthz" && req.method === "GET") {
    span.setAttributes({ "http.route": "/healthz" });
    const ready = options.ready();
    res.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: ready ? "ok" : "draining", service: "model-gateway" }));
    return;
  }
  const route = classify(req.method ?? "", url.pathname, isServerCall(req.headers));
  const kind = route?.kind ?? "openai";
  // Route templates only (KOBE-525): the per-route latency query groups by them.
  if (route) span.setAttributes({ "http.route": routeTemplate(route) });
  else if (url.pathname === EVAL_CASES_PATH) span.setAttributes({ "http.route": EVAL_CASES_PATH });

  // 1. The caller: a server call's token (KOBE-234), else the sandbox's session token (any SDK's
  // API-key header). No route detail before authentication.
  const caller = authenticate(options, req, url, route);
  if (!caller.ok) {
    sendError(res, kind, caller.status, caller.code, caller.message);
    return;
  }
  if (url.pathname === EVAL_CASES_PATH && !caller.serverCall) {
    await serveEvalCases(options, req, res, caller.identity);
    return;
  }
  // 2. Inference paths only.
  if (!route) {
    sendError(res, kind, 404, "not_found", "Not a model inference endpoint.");
    return;
  }
  const { identity, serverCall, evalSandbox } = caller;
  // Limits are per sandbox; server calls have their own, per team (review L4).
  const limitKey = identity.sandboxId ?? `server-call:${identity.teamId}`;
  const limits = serverCall && options.serverCalls ? options.serverCalls : options;
  const skipped = (reason: string) => {
    if (serverCall) {
      logger.warn(
        {
          teamId: identity.teamId,
          runId: serverCall.run_id,
          purpose: serverCall.purpose,
          reason,
        },
        "server call skipped",
      );
    }
  };

  // 3. Per-sandbox request rate and concurrent calls, before anything touches the database.
  if (!limits.rate.allow(limitKey)) {
    skipped("rate_limited");
    sendError(res, kind, 429, "rate_limited", "Too many model requests; slow down.", 1);
    return;
  }
  const release = limits.limiter.acquire(limitKey);
  if (!release) {
    skipped("too_many_concurrent_calls");
    sendError(res, kind, 429, "too_many_concurrent_calls", "Too many concurrent model calls.", 1);
    return;
  }
  const state = newRequestState(Date.now(), limitKey);
  const request: InferenceRequest = {
    req,
    res,
    span,
    url,
    route,
    kind,
    identity,
    serverCall,
    evalSandbox,
    skipped,
  };
  try {
    await serveInference(gateway, request, state);
  } finally {
    release();
    finishRequest(options, span, state);
  }
}

/** Steps 4.–7. of an inference call; `state` collects what the call's metering needs. */
async function serveInference(
  gateway: Gateway,
  request: InferenceRequest,
  state: RequestState,
): Promise<void> {
  const { options } = gateway;
  const { logger, settings } = options;
  const { req, res, span, route, kind, identity, serverCall } = request;
  // 4. Liveness, the member's virtual key and the team's enabled models.
  const resolution = await options.principals.resolve(
    identity.teamId,
    identity.userId,
    identity.sandboxId,
  );
  if (!resolution.ok) {
    const [code, errCode, message] = REASONS[resolution.reason];
    state.status = code;
    if (code === 401) {
      logger.info({ ...identity, reason: resolution.reason }, "refused a revoked session token");
    }
    sendError(res, kind, code, errCode, message, code === 503 ? 5 : undefined);
    return;
  }

  // 5. Run attribution: the run token when sent (it must verify, no fallback), else the legacy
  // advisory header, unless enforcement makes the token mandatory (KOBE-118).
  // A server call's run is its token's: the completed run that triggered it, of the token's
  // thread and member in the record (review L1). A run-less purpose (KOBE-564: a member's own
  // request, `skill_manifest`) names no run: its row is attributed to the member alone.
  const attribution = serverCall
    ? await serverCallAttribution(options, serverCall)
    : identity.sandboxId === undefined
      ? NO_SESSION
      : await resolveRunAttribution(options, req.headers, {
          teamId: identity.teamId,
          sandboxId: identity.sandboxId,
        });
  if (!attribution.ok) {
    state.status = attribution.status;
    sendError(res, kind, attribution.status, attribution.code, attribution.message);
    return;
  }
  const runId = attribution.runId;
  // The span opens only now, in the attributed run's trace (KOBE-274 listener rule).
  const placement = await placeRequestSpan(options.tracing, req.headers, {
    teamId: identity.teamId,
    runId,
    serverCall,
  });
  span.setAttributes(placement.attributes);
  state.traceContext = span.open(placement.parent);

  // 6. The body (bounded, within the byte budget), its model, the team's enablement.
  const body = await readBody(
    req,
    serverCall
      ? serverCallBodyLimit(settings.maxBodyBytes, serverCall.purpose)
      : settings.maxBodyBytes,
    (n) => options.bytes.tryTake(state.limitKey, n),
    (n) => {
      state.bytesHeld += n;
    },
  );
  if (body === "too_large" || body === "busy") {
    res.setHeader("connection", "close");
    state.status = body === "too_large" ? 413 : 429;
    if (body === "too_large") {
      sendError(res, kind, 413, "request_too_large", "The request body is too large.");
    } else {
      sendError(res, kind, 429, "too_many_bytes_in_flight", "The gateway is busy; retry.", 1);
    }
    return;
  }
  state.bytesIn = body.length;
  if (telemetryState().captureContent) state.promptBody = body;
  const prepared = await prepareBody(
    options,
    req,
    route,
    serverCall,
    resolution,
    identity.teamId,
    runId,
    body,
  );
  if (!prepared.ok) {
    state.status = prepared.status;
    sendError(res, kind, prepared.status, prepared.code, prepared.message);
    return;
  }
  state.thinkingLevel = prepared.thinkingLevel;
  if (!(await admitCall(gateway, request, state, resolution, runId, body, prepared))) return;
  await forwardWithRetry(gateway, request, state, resolution, prepared);
}

/** The call's context, the team's enablement of its model and the {@link CallGate}. */
async function admitCall(
  gateway: Gateway,
  request: InferenceRequest,
  state: RequestState,
  resolution: Resolved,
  runId: string | undefined,
  body: Buffer,
  prepared: { readonly model: string | undefined; readonly outputAllowance: number },
): Promise<boolean> {
  const { req, res, route, kind, identity, serverCall, evalSandbox } = request;
  const { model, outputAllowance } = prepared;
  state.call = {
    ...identity,
    callId: randomUUID(),
    runId,
    ...(serverCall ? { purpose: serverCall.purpose } : {}),
    ...(evalSandbox ? { eval: true } : {}),
    route: route.kind,
    path: route.path,
    model,
    inputEstimate: Math.ceil(body.length / 4),
    outputAllowance,
  };
  // Every model call names a model the team enabled (checked here too, so a disable holds even
  // when a push to Bifrost failed). Listing models (GET) names none.
  // KOBE-409: the Site embedding model is a Site choice, never a Workspace's chat model (it is
  // in no catalog, so in no picker): a server-signed `memory_embed` token names it, and the
  // member's virtual key allows it only because the sync adds the Site's embedding model to
  // every key, so Bifrost still refuses any other model.
  const siteEmbedding = serverCall?.purpose === "memory_embed";
  if (
    req.method === "POST" &&
    (!model || (!siteEmbedding && !resolution.enabledModels.has(model)))
  ) {
    state.status = 403;
    sendError(
      res,
      kind,
      403,
      "model_not_enabled",
      "That model is not enabled for this team (use a model from the team's catalog).",
    );
    return false;
  }
  const decision = await gateway.options.gate.admit(state.call);
  if (decision.ok && decision.release) state.releaseGate = decision.release;
  if (!decision.ok) {
    request.skipped(decision.code);
    state.status = decision.status;
    sendError(
      res,
      kind,
      decision.status,
      decision.code,
      decision.message,
      decision.retryAfterSeconds,
    );
    return false;
  }
  return true;
}

/** 6.–7. Forward; retry once if Bifrost no longer knows the virtual key (restarted, resynced). */
async function forwardWithRetry(
  gateway: Gateway,
  request: InferenceRequest,
  state: RequestState,
  admitted: Resolved,
  prepared: {
    readonly forwardBody: Buffer;
    readonly outputAllowance: number;
    readonly embeddings: boolean;
  },
): Promise<void> {
  const { options, upstream } = gateway;
  const { req, res, url, route, kind, identity } = request;
  const { forwardBody, outputAllowance, embeddings } = prepared;
  let resolution = admitted;
  const path = `${route.path}${forwardedQuery(url.searchParams)}`;
  for (let attempt = 0; ; attempt++) {
    const outcome = await forward(
      upstream,
      req,
      res,
      path,
      forwardBody,
      resolution.virtualKey,
      attempt === 0,
      {
        kind: route.kind,
        started: state.started,
        outputAllowance,
        embeddings,
        // KOBE-409 L4: a listing names only the team's enabled models.
        ...(req.method === "GET" && route.path === "/v1/models"
          ? { listModels: resolution.enabledModels }
          : {}),
      },
      state.traceContext,
    );
    state.status = outcome.status;
    state.errorType = outcome.errorType;
    state.bytesOut = outcome.bytesOut;
    state.aborted = outcome.aborted;
    state.usage = outcome.usage;
    state.ttfbMs = outcome.ttfbMs;
    if (outcome.kind !== "key_unknown") return;
    options.onBifrostForgotKey();
    const fresh = await options.principals.resolve(
      identity.teamId,
      identity.userId,
      identity.sandboxId,
      true,
    );
    if (attempt === 0 && fresh.ok && fresh.virtualKey !== resolution.virtualKey) {
      resolution = fresh;
      continue;
    }
    state.status = 503;
    sendError(
      res,
      kind,
      503,
      "model_gateway_resyncing",
      "The model gateway is resyncing; retry.",
      2,
    );
    return;
  }
}
