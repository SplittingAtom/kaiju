import {
  request as httpRequest,
  Agent as HttpAgent,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest, Agent as HttpsAgent } from "node:https";
import { injectTraceHeaders, type Context } from "@kaiju/telemetry";
import { forwardRequestHeaders, forwardResponseHeaders } from "../headers.js";
import { MODEL_LIST_MAX_BYTES, filterModelList } from "../model-list.js";
import type { RouteKind } from "../routes.js";
import { UsageMeter, type UsageReading } from "../usage/meter.js";
import { sendError } from "./errors.js";
import type { GatewayOptions } from "./options.js";
import { NO_TOKENS, unanswered } from "./usage.js";

/** Bifrost's error types meaning "this virtual key does not exist here". */
const KEY_UNKNOWN = new Set(["access_not_found", "virtual_key_required"]);

/** Bifrost, as one gateway reaches it: its URL, transport and keep-alive agent. */
export function createUpstream(
  options: Pick<GatewayOptions, "bifrostUrl" | "settings" | "logger">,
) {
  const target = new URL(options.bifrostUrl);
  const secure = target.protocol === "https:";
  const send = secure ? httpsRequest : httpRequest;
  const agent = secure
    ? new HttpsAgent({ keepAlive: true, maxSockets: 256 })
    : new HttpAgent({ keepAlive: true, maxSockets: 256 });
  return { target, secure, send, agent, settings: options.settings, logger: options.logger };
}

export type Upstream = ReturnType<typeof createUpstream>;

export type Outcome = {
  readonly kind: "done" | "key_unknown";
  readonly status: number;
  readonly errorType: string | undefined;
  readonly bytesOut: number;
  readonly aborted: boolean;
  /** Tokens this attempt used (zero for an error answer); undefined when nothing came back. */
  readonly usage: UsageReading | undefined;
  readonly ttfbMs: number | undefined;
};

type Settled = Omit<Outcome, "bytesOut" | "usage" | "ttfbMs">;

export interface ForwardCall {
  readonly kind: RouteKind;
  readonly started: number;
  readonly outputAllowance: number;
  /** Embeddings generate no text: output is 0, the vectors are not counted (KOBE-409). */
  readonly embeddings: boolean;
  /** `GET /v1/models`: keep only these ids in the listing (`model-list.ts`). */
  readonly listModels?: ReadonlySet<string>;
}

/** One forwarding attempt's running state, shared by the request's and the response's handlers. */
interface Attempt {
  readonly res: ServerResponse;
  readonly mayRetry: boolean;
  readonly call: ForwardCall;
  bytesOut: number;
  meter: UsageMeter | undefined;
  ttfbMs: number | undefined;
  errorAnswer: boolean;
  requestSent: boolean;
  readonly done: (o: Settled) => void;
}

export function forward(
  upstreamOf: Upstream,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  body: Buffer,
  virtualKey: string,
  mayRetry: boolean,
  call: ForwardCall,
  traceContext: Context | undefined,
): Promise<Outcome> {
  const { target, secure, send, agent, settings, logger } = upstreamOf;
  return new Promise((resolve) => {
    let settled = false;
    const attempt: Attempt = {
      res,
      mayRetry,
      call,
      bytesOut: 0,
      meter: undefined,
      ttfbMs: undefined,
      errorAnswer: false,
      requestSent: false,
      done: (o) => {
        if (settled) return;
        settled = true;
        // Usage counts what the upstream produced: a stream cut short still cost its tokens, and
        // a request Bifrost received but never answered (the sandbox hung up first, a reset) is
        // charged its input: the provider may already have it.
        // A 4xx is a refusal (nothing consumed); a 5xx or a call that never answered may have
        // been processed upstream, so it is charged like a call cut short (usage/charge.ts).
        const usage = attempt.meter
          ? attempt.meter.finish(!o.aborted, body.length, call.outputAllowance)
          : attempt.errorAnswer
            ? o.status >= 500
              ? unanswered(body.length, call.outputAllowance)
              : NO_TOKENS
            : attempt.requestSent
              ? unanswered(body.length, call.outputAllowance)
              : undefined;
        resolve({ ...o, bytesOut: attempt.bytesOut, usage, ttfbMs: attempt.ttfbMs });
      },
    };
    const { done } = attempt;
    const upstream = send(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (secure ? 443 : 80),
        method: req.method,
        path,
        agent,
        headers: {
          ...forwardRequestHeaders(req.headers, virtualKey, body.length),
          ...(traceContext === undefined ? {} : injectTraceHeaders({}, traceContext)),
        },
      },
      (up) => relayResponse(attempt, up),
    );
    upstream.on("finish", () => {
      attempt.requestSent = true;
    });
    upstream.setTimeout(settings.idleTimeoutMs, () => upstream.destroy(new Error("idle")));
    upstream.on("error", (err) => {
      if (settled) return;
      if (!res.headersSent) {
        logger.warn({ err: err.message }, "bifrost unreachable");
        sendError(
          res,
          "openai",
          502,
          "model_gateway_unavailable",
          "The model gateway is unavailable.",
        );
        done({ kind: "done", status: 502, errorType: undefined, aborted: false });
      } else {
        res.destroy();
        done({ kind: "done", status: res.statusCode, errorType: undefined, aborted: true });
      }
    });
    // The sandbox went away: cancel the upstream call (Bifrost cancels the provider request).
    res.on("close", () => {
      if (!res.writableFinished) {
        upstream.destroy();
        done({ kind: "done", status: res.statusCode, errorType: undefined, aborted: true });
      }
    });
    upstream.end(body);
  });
}

/** Bifrost answered: relay its response (error bodies buffered, listings filtered, else streamed). */
function relayResponse(attempt: Attempt, up: IncomingMessage): void {
  const { res, call, done } = attempt;
  attempt.ttfbMs = Date.now() - call.started;
  const upStatus = up.statusCode ?? 502;
  attempt.errorAnswer = upStatus >= 400;
  const small = upStatus >= 400 && Number(up.headers["content-length"] ?? 0) <= 65_536;
  if (upStatus >= 400 && small) {
    relayErrorBody(attempt, up, upStatus);
    return;
  }
  if (call.listModels !== undefined && !attempt.errorAnswer) {
    readModelList(up, call.listModels, res, (o, bytes) => {
      attempt.bytesOut = bytes;
      done(o);
    });
    return;
  }
  res.writeHead(upStatus, forwardResponseHeaders(up.headers));
  res.flushHeaders();
  if (!attempt.errorAnswer) {
    attempt.meter = new UsageMeter({
      kind: call.kind,
      embeddings: call.embeddings,
      contentType: up.headers["content-type"],
      contentEncoding: up.headers["content-encoding"],
    });
  }
  up.on("data", (chunk: Buffer) => {
    attempt.bytesOut += chunk.length;
    attempt.meter?.write(chunk);
    if (!res.write(chunk)) up.pause();
  });
  res.on("drain", () => up.resume());
  up.on("end", () => {
    res.end();
    done({ kind: "done", status: upStatus, errorType: undefined, aborted: false });
  });
  up.on("error", () => {
    res.destroy();
    done({ kind: "done", status: upStatus, errorType: undefined, aborted: true });
  });
}

/** Buffer error bodies (small): read Bifrost's error type; spot a forgotten key. */
function relayErrorBody(attempt: Attempt, up: IncomingMessage, upStatus: number): void {
  const { res, done } = attempt;
  const chunks: Buffer[] = [];
  up.on("data", (c: Buffer) => chunks.push(c));
  up.on("end", () => {
    const text = Buffer.concat(chunks);
    let type: string | undefined;
    try {
      const parsed = JSON.parse(text.toString("utf8")) as { type?: unknown };
      type = typeof parsed.type === "string" ? parsed.type : undefined;
    } catch {
      type = undefined;
    }
    if (attempt.mayRetry && upStatus === 401 && type && KEY_UNKNOWN.has(type)) {
      done({ kind: "key_unknown", status: upStatus, errorType: type, aborted: false });
      return;
    }
    if (!res.headersSent) {
      res.writeHead(upStatus, {
        ...forwardResponseHeaders(up.headers),
        "content-length": text.length,
      });
    }
    attempt.bytesOut = text.length;
    res.end(text);
    done({ kind: "done", status: upStatus, errorType: type, aborted: false });
  });
  up.on("error", () =>
    done({ kind: "done", status: upStatus, errorType: undefined, aborted: true }),
  );
}

/** Reads Bifrost's whole model listing and answers with the enabled entries only. */
function readModelList(
  up: IncomingMessage,
  enabled: ReadonlySet<string>,
  res: ServerResponse,
  done: (o: Settled, bytesOut: number) => void,
): void {
  const upStatus = up.statusCode ?? 502;
  const chunks: Buffer[] = [];
  let size = 0;
  const fail = () => {
    if (!res.headersSent) {
      sendError(res, "openai", 502, "model_gateway_unavailable", "The model list is unreadable.");
    }
    done({ kind: "done", status: 502, errorType: undefined, aborted: false }, 0);
  };
  up.on("data", (c: Buffer) => {
    size += c.length;
    if (size > MODEL_LIST_MAX_BYTES) {
      up.destroy();
      fail();
      return;
    }
    chunks.push(c);
  });
  up.on("end", () => {
    if (size > MODEL_LIST_MAX_BYTES) return;
    const text = filterModelList(Buffer.concat(chunks), enabled);
    if (text === undefined) {
      fail();
      return;
    }
    const headers = forwardResponseHeaders(up.headers);
    delete headers["content-encoding"];
    res.writeHead(upStatus, { ...headers, "content-length": text.length });
    res.end(text);
    done({ kind: "done", status: upStatus, errorType: undefined, aborted: false }, text.length);
  });
  up.on("error", fail);
}
