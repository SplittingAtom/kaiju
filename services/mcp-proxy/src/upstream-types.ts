import type { LookupAddress } from "node:dns";
import type { AddressChecker } from "./address-policy.js";
import type { UpstreamPolicy } from "./config.js";

export type UpstreamFailure =
  | "url_not_allowed"
  | "forbidden_address"
  | "unreachable"
  | "timeout"
  | "auth_required"
  | "http_error"
  | "protocol_error"
  | "too_large"
  /** The upstream offers this tool only to apps, or no longer lists it (KOBE-435 review M3). */
  | "not_offered";

export type UpstreamResult =
  | { readonly ok: true; readonly result: Record<string, unknown> }
  | {
      readonly ok: false;
      readonly failure: "rpc_error";
      readonly code: number;
      readonly message: string;
    }
  | { readonly ok: false; readonly failure: UpstreamFailure };

/**
 * Which Kobe path an upstream session serves, for its span (KOBE-527/528): a sandbox's MCP call,
 * the server's pinning probe, or an MCP App's own call. Default: `mcp` for a call, `probe` for a
 * list.
 */
export type UpstreamKind = "mcp" | "probe" | "app";

export interface UpstreamBase {
  readonly url: string;
  readonly kind?: UpstreamKind;
  /** Credential headers (KOBE-61); never logged. */
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}

export interface UpstreamCall extends UpstreamBase {
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
  /**
   * List the upstream's tools first, in the same session, and refuse (`not_offered`) unless it
   * lists this tool as visible to the model. Set when the server's allow did not say it checked
   * MCP Apps visibility (an older server pod, KOBE-435 review M3).
   */
  readonly checkModelVisible?: boolean;
}

export interface UpstreamClient {
  callTool(call: UpstreamCall): Promise<UpstreamResult>;
  /**
   * The live `tools/list` (all pages) as `{ tools: unknown[] }`, for the server's pinning probe;
   * with `uiResources`, also `ui_resources`: the `ui://` templates the tools name (KOBE-433).
   */
  listTools(call: UpstreamBase, options?: ListToolsOptions): Promise<UpstreamResult>;
  /** Session DELETEs still in flight (bounded by `maxPendingDeletes`). */
  readonly pendingDeletes: number;
  close(): Promise<void>;
}

export interface ListToolsOptions {
  readonly uiResources?: boolean;
}

export interface UpstreamOptions {
  readonly policy: UpstreamPolicy;
  readonly maxResponseBytes: number;
  /** Sockets per upstream origin (default 32). */
  readonly connectionsPerOrigin?: number;
  /** Best-effort session DELETEs in flight at once; beyond it they are skipped (default 64). */
  readonly maxPendingDeletes?: number;
  /** DNS resolution (tests resolve names to loopback). */
  readonly resolve?: (host: string) => Promise<LookupAddress[]>;
  /**
   * The address check, built from `policy` when unset. Tests that reach a local fake upstream
   * inject one that adds loopback, which `policy` can never allow (KOBE-694).
   */
  readonly addresses?: AddressChecker;
}
