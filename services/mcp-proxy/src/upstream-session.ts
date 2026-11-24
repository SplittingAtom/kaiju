import { SpanKind, SpanStatusCode, withSpan } from "@kaiju/telemetry";
import { fetch as undiciFetch, type Dispatcher } from "undici";
import type { AddressChecker } from "./address-policy.js";
import { checkUpstreamUrl } from "./upstream-connect.js";
import type { UpstreamBase, UpstreamOptions, UpstreamResult } from "./upstream-types.js";
import { isObject, readLimited, readSse, responseFor, UpstreamError } from "./upstream-wire.js";

export const CLIENT_INFO = { name: "kobe-mcp-proxy", version: "1.0.0" } as const;
/** Upstream protocol versions the proxy speaks (newest first). */
export const UPSTREAM_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;

/** One upstream client's connection state, shared by its sessions. */
export interface UpstreamTransport {
  /** The client's options (policy and response cap are read from them per request). */
  readonly options: UpstreamOptions;
  readonly addresses: AddressChecker;
  readonly dispatcher: Dispatcher;
  /** Best-effort session DELETEs in flight at once; beyond it they are skipped. */
  readonly maxPendingDeletes: number;
  /** Session DELETEs still in flight. */
  pendingDeletes: number;
}

export interface Session {
  id?: string;
  version?: string;
  /** HTTP requests sent in this session (its span's `kobe.upstream.requests`). */
  requests: number;
}

async function post(
  t: UpstreamTransport,
  url: URL,
  call: UpstreamBase,
  session: Session,
  message: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  session.requests += 1;
  const res = await undiciFetch(url, {
    method: "POST",
    dispatcher: t.dispatcher,
    redirect: "error",
    signal: call.signal,
    headers: {
      ...call.headers,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(session.id === undefined ? {} : { "mcp-session-id": session.id }),
      ...(session.version === undefined ? {} : { "mcp-protocol-version": session.version }),
    },
    body: JSON.stringify(message),
  });
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel();
    throw new UpstreamError("auth_required", res.status);
  }
  if (!("id" in message)) {
    await res.body?.cancel();
    if (res.status >= 200 && res.status < 300) return undefined;
    throw new UpstreamError("http_error");
  }
  if (res.status !== 200) {
    await res.body?.cancel();
    throw new UpstreamError("http_error");
  }
  const sessionId = res.headers.get("mcp-session-id");
  if (sessionId !== null && session.id === undefined) {
    if (!/^[\x21-\x7e]{1,256}$/.test(sessionId)) throw new UpstreamError("protocol_error");
    session.id = sessionId;
  }
  const type = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  const id = message.id as number;
  if (type === "text/event-stream") return readSse(res.body, id, t.options.maxResponseBytes);
  if (type !== "application/json") {
    await res.body?.cancel();
    throw new UpstreamError("protocol_error");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readLimited(res.body, t.options.maxResponseBytes));
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    throw new UpstreamError("protocol_error");
  }
  const response = responseFor(parsed, id);
  if (!response) throw new UpstreamError("protocol_error");
  return response;
}

// Session DELETEs are best effort and fire after the call's slot is released: bounded separately
// so a slow upstream cannot pile them up (review L5).
function endSession(t: UpstreamTransport, url: URL, call: UpstreamBase, session: Session): void {
  if (session.id === undefined || t.pendingDeletes >= t.maxPendingDeletes) return;
  t.pendingDeletes += 1;
  void undiciFetch(url, {
    method: "DELETE",
    dispatcher: t.dispatcher,
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
    headers: {
      ...call.headers,
      "mcp-session-id": session.id,
      ...(session.version === undefined ? {} : { "mcp-protocol-version": session.version }),
    },
  })
    .then((res) => res.body?.cancel())
    .catch(() => undefined)
    .finally(() => {
      t.pendingDeletes -= 1;
    });
}

/**
 * One upstream session as a client span `mcp.upstream` (KOBE-527/528), so a trace separates the
 * upstream's time from Kaiju's. Low-cardinality attributes only: the path's kind, the MCP method,
 * the outcome (`ok` or the failure kind), an error flag and the request count; never the
 * connector, its URL, the tool or any content. The best-effort session DELETE is not in it.
 */
export function inSession(
  t: UpstreamTransport,
  call: UpstreamBase,
  method: "tools/call" | "tools/list",
  run: (url: URL, session: Session) => Promise<UpstreamResult>,
): Promise<UpstreamResult> {
  const kind = call.kind ?? (method === "tools/call" ? "mcp" : "probe");
  const session: Session = { requests: 0 };
  return withSpan(
    "mcp.upstream",
    {
      kind: SpanKind.CLIENT,
      attributes: { "kobe.upstream.kind": kind, "kobe.upstream.method": method },
    },
    async (span) => {
      const result = await sessionResult(t, call, session, run);
      span.setAttributes({
        "kobe.upstream.outcome": result.ok ? "ok" : result.failure,
        "kobe.upstream.error": !result.ok,
        "kobe.upstream.requests": session.requests,
      });
      if (!result.ok) span.setStatus({ code: SpanStatusCode.ERROR });
      return result;
    },
  );
}

/** initialize → initialized → `run` → session DELETE; maps every failure to a result. */
async function sessionResult(
  t: UpstreamTransport,
  call: UpstreamBase,
  session: Session,
  run: (url: URL, session: Session) => Promise<UpstreamResult>,
): Promise<UpstreamResult> {
  const url = checkUpstreamUrl(call.url, t.options.policy, t.addresses);
  if (!url) return { ok: false, failure: "url_not_allowed" };
  try {
    const init = await post(t, url, call, session, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: UPSTREAM_PROTOCOL_VERSIONS[0],
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
    });
    const initResult = init?.result;
    const version = isObject(initResult) ? initResult.protocolVersion : undefined;
    if (
      typeof version !== "string" ||
      !(UPSTREAM_PROTOCOL_VERSIONS as readonly string[]).includes(version)
    ) {
      return { ok: false, failure: "protocol_error" };
    }
    session.version = version;
    await post(t, url, call, session, { jsonrpc: "2.0", method: "notifications/initialized" });
    return await run(url, session);
  } catch (err) {
    const cause = (err as { cause?: unknown }).cause;
    const known =
      err instanceof UpstreamError ? err : cause instanceof UpstreamError ? cause : undefined;
    if (known) {
      return known.authStatus === undefined
        ? { ok: false, failure: known.failure }
        : { ok: false, failure: known.failure, authStatus: known.authStatus };
    }
    if (call.signal.aborted) return { ok: false, failure: "timeout" };
    return { ok: false, failure: "unreachable" };
  } finally {
    endSession(t, url, call, session);
  }
}

/** One request after initialize, its `result` object or the failure. */
export async function request(
  t: UpstreamTransport,
  url: URL,
  call: UpstreamBase,
  session: Session,
  id: number,
  method: string,
  params: Record<string, unknown>,
): Promise<UpstreamResult> {
  const response = await post(t, url, call, session, { jsonrpc: "2.0", id, method, params });
  if (response && isObject(response.error)) {
    const { code, message } = response.error;
    return {
      ok: false,
      failure: "rpc_error",
      code: typeof code === "number" && Number.isSafeInteger(code) ? code : -32603,
      message: typeof message === "string" ? message.slice(0, 1000) : "Upstream error.",
    };
  }
  if (!response || !isObject(response.result)) return { ok: false, failure: "protocol_error" };
  return { ok: true, result: response.result };
}
