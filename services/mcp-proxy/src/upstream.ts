import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { AddressPolicy } from "./address-policy.js";
import { readUiResources } from "./ui-resources.js";
import { createDispatcher } from "./upstream-connect.js";
import { inSession, request, type UpstreamTransport } from "./upstream-session.js";
import type {
  ListToolsOptions,
  UpstreamBase,
  UpstreamCall,
  UpstreamClient,
  UpstreamOptions,
  UpstreamResult,
} from "./upstream-types.js";
import { UpstreamError } from "./upstream-wire.js";
import { upstreamModelVisible } from "./visibility.js";

export type {
  ListToolsOptions,
  UpstreamBase,
  UpstreamCall,
  UpstreamClient,
  UpstreamFailure,
  UpstreamKind,
  UpstreamOptions,
  UpstreamResult,
} from "./upstream-types.js";
export { checkUpstreamUrl } from "./upstream-connect.js";
export { CLIENT_INFO, UPSTREAM_PROTOCOL_VERSIONS } from "./upstream-session.js";

/**
 * The proxy's MCP client towards remote servers (D27: Streamable HTTP only, no stdio). One short
 * session per call: `initialize` → `notifications/initialized` → `tools/call` → `DELETE` session.
 * Answers may be JSON or an SSE stream (the response with our id is taken; server notifications and
 * requests on the stream are ignored: the proxy declares no client capabilities).
 *
 * Where it may connect is checked here, not by the URL's say-so: the scheme (HTTPS unless
 * explicitly allowed), the port, and every address the host resolves to (the egress proxy's
 * ranges: private, loopback, link-local/metadata, …, unless an operator allowed them). The proxy
 * connects only to an address it checked (rebinding-safe) and never follows redirects. Responses
 * are capped in size and time. Connection checks: upstream-connect.ts; sessions:
 * upstream-session.ts; response reading: upstream-wire.ts.
 */

/** Most `tools/list` pages a probe follows (KOBE-101). */
export const MAX_TOOL_PAGES = 20;

function defaultResolve(host: string): Promise<LookupAddress[]> {
  return new Promise((resolve, reject) => {
    dnsLookup(host, { all: true, verbatim: true }, (err, addresses) =>
      err ? reject(err) : resolve(addresses),
    );
  });
}

export function createUpstreamClient(options: UpstreamOptions): UpstreamClient {
  const addresses =
    options.addresses ??
    new AddressPolicy({
      allowedInternal: options.policy.allowedInternalCidrs,
      extraDenied: options.policy.deniedCidrs,
    });
  const resolve = options.resolve ?? defaultResolve;
  const transport: UpstreamTransport = {
    options,
    addresses,
    dispatcher: createDispatcher(resolve, addresses, options.connectionsPerOrigin),
    maxPendingDeletes: options.maxPendingDeletes ?? 64,
    pendingDeletes: 0,
  };
  return {
    callTool: (call) => callTool(transport, call),
    listTools: (call, listOptions) => listTools(transport, call, listOptions),
    get pendingDeletes() {
      return transport.pendingDeletes;
    },
    close: () => transport.dispatcher.close(),
  };
}

type Next = (method: string, params: Record<string, unknown>) => Promise<UpstreamResult>;

/** Every `tools/list` page, or the failure. */
async function allTools(next: Next): Promise<UpstreamResult> {
  const tools: unknown[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
    const answer = await next("tools/list", cursor === undefined ? {} : { cursor });
    if (!answer.ok) return answer;
    const pageTools = answer.result.tools;
    if (!Array.isArray(pageTools)) return { ok: false, failure: "protocol_error" };
    tools.push(...pageTools);
    const nextCursor = answer.result.nextCursor;
    if (typeof nextCursor !== "string" || nextCursor === "") return { ok: true, result: { tools } };
    cursor = nextCursor;
  }
  return { ok: false, failure: "too_large" };
}

const callTool = (t: UpstreamTransport, call: UpstreamCall): Promise<UpstreamResult> =>
  inSession(t, call, "tools/call", async (url, session) => {
    let id = 2;
    const next: Next = (method, params) => request(t, url, call, session, id++, method, params);
    if (call.checkModelVisible === true) {
      const listed = await allTools(next);
      if (!listed.ok) return listed;
      const tools = listed.result.tools as unknown[];
      const tool = tools.find(
        (tl) =>
          typeof tl === "object" && tl !== null && (tl as { name?: unknown }).name === call.tool,
      );
      if (tool === undefined || !upstreamModelVisible(tool)) {
        return { ok: false, failure: "not_offered" };
      }
    }
    return next("tools/call", { name: call.tool, arguments: call.arguments });
  });

/**
 * The template part of a probe (KOBE-433): `ui_resources`, or `ui_resources_skipped` with a
 * reason. Never fails the tool probe; a read answered too large is that template's error.
 */
async function uiPart(
  tools: readonly unknown[],
  next: (method: string, params: Record<string, unknown>) => Promise<UpstreamResult>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const tolerant = async (method: string, params: Record<string, unknown>) => {
    try {
      return await next(method, params);
    } catch (err) {
      if (err instanceof UpstreamError && err.failure === "too_large" && !signal.aborted) {
        return { ok: false as const, failure: "too_large" as const };
      }
      throw err;
    }
  };
  try {
    const ui = await readUiResources(tools, tolerant);
    return ui.ok ? { ui_resources: ui.resources } : { ui_resources_skipped: ui.skipped };
  } catch (err) {
    const cause = (err as { cause?: unknown }).cause;
    const known =
      err instanceof UpstreamError ? err : cause instanceof UpstreamError ? cause : undefined;
    const failure = known?.failure ?? (signal.aborted ? "timeout" : "unreachable");
    return { ui_resources_skipped: failure };
  }
}

async function listTools(
  t: UpstreamTransport,
  call: UpstreamBase,
  listOptions: ListToolsOptions = {},
): Promise<UpstreamResult> {
  return inSession(t, call, "tools/list", async (url, session) => {
    let id = 2;
    const next: Next = (method, params) => request(t, url, call, session, id++, method, params);
    const listed = await allTools(next);
    if (!listed.ok || !listOptions.uiResources) return listed;
    const tools = listed.result.tools as unknown[];
    return { ok: true, result: { tools, ...(await uiPart(tools, next, call.signal)) } };
  });
}
