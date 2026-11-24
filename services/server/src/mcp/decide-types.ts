import type { PolicyDecision, PolicyInput, PolicyReasonCode, ToolDescriptor } from "@kaiju/protocol";
import type { ConnectorAuthKind, KaijuDb, PinnedTool } from "@kaiju/db";
import type { RunPolicyContextSource } from "../sandbox-wire/types.js";
import type { McpApprovalFailure, McpApprovalVerifier } from "./approvals.js";
import type { EnabledConnector } from "./catalog.js";
import type { PolicySources } from "./fan-out.js";
import type { ActiveRunContext } from "./run-context.js";

export interface McpPrincipal {
  readonly sandboxId: string;
  readonly teamId: string;
  readonly userId: string;
  /** A skill eval's sandbox (KOBE-325): never given the member's personal credentials. */
  readonly evalThreadId?: string;
}

export interface McpCallRequest {
  readonly connectorId: string;
  /** The upstream MCP tool name (`tools/call` `params.name`). */
  readonly tool: string;
  readonly arguments: unknown;
  /** The thread whose Pi process makes the call (per-session header, KOBE-62). */
  readonly threadId?: string;
  /** `_meta["kobe.dev/tool_call_id"]` when the client sends one. */
  readonly toolCallId?: string;
}

export interface McpUpstreamTarget {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly auth_kind: ConnectorAuthKind;
}

export type McpCallDecision =
  | {
      readonly decision: "allow";
      readonly connector: McpUpstreamTarget;
      /**
       * `model_visible: true` (KOBE-435 review M3): this server checked the tool's MCP Apps
       * visibility. A proxy that gets an allow without it (an older server mid-rollout) checks
       * the upstream's own `tools/list` before calling.
       */
      readonly tool: {
        readonly name: string;
        readonly pi_name: string;
        readonly model_visible: true;
      };
      /** SHA-256 (hex) of `canonicalJson(input)`: the proxy forwards exactly these bytes. */
      readonly input_sha256: string;
      readonly reason: PolicyReasonCode;
      readonly approval_id?: string;
      /**
       * The run the call was decided for and the tool call id it was decided under (KOBE-619: the
       * Kaiju MCP executor's delegation). Server-internal: the proxy's schema ignores them.
       */
      readonly run_id?: string;
      readonly tool_call_id?: string;
      /**
       * MCP Apps (KOBE-438): the tool opens a pinned, approved `ui://` template, so the proxy
       * reports the upstream's full result with this signed ticket (`capture-ticket.ts`). Absent
       * for every other tool, and from a server without a capture key.
       */
      readonly app_capture?: { readonly ticket: string };
    }
  | {
      readonly decision: "deny";
      readonly code: PolicyReasonCode;
      readonly message: string;
      readonly approval_failure?: McpApprovalFailure;
    };

export interface McpDecideDeps {
  readonly db: KaijuDb;
  /** The engine's inputs; each call decides with its own memoising engine (fan-out.ts). */
  readonly policy: PolicySources;
  readonly runContext: RunPolicyContextSource;
  readonly approvals: McpApprovalVerifier;
  readonly now?: () => Date;
  /** Whether a denied call of this sandbox may be audited now (per-sandbox throttle). */
  readonly mayAuditDenied?: (sandboxId: string) => boolean;
  /** Signs MCP Apps capture tickets (KOBE-438); unset: results are never captured. */
  readonly captureKey?: Buffer;
  /**
   * The connector as enabled in the team (default `loadTeamConnector`, catalog.ts). The built-in Kaiju
   * connector (KOBE-619) supplies its catalog here instead of a pinned snapshot.
   */
  readonly loadConnector?: (
    teamId: string,
    connectorId: string,
  ) => Promise<EnabledConnector | undefined>;
  /**
   * A refusal decided before any run is looked at (KOBE-619: the person's permission, the Kaiju
   * switches, the admin limits); audited like every deny.
   */
  readonly refuse?: (
    tool: PinnedTool,
    descriptor: ToolDescriptor,
  ) => Promise<{ readonly code: PolicyReasonCode; readonly message: string } | undefined>;
  /**
   * Applied to each run's engine decision before they are combined (KOBE-619: the Kaiju admin
   * guard, which asks for writes in every mode and denies where nobody can be asked).
   */
  readonly guard?: (
    decision: PolicyDecision,
    input: PolicyInput,
    run: ActiveRunContext,
  ) => PolicyDecision;
}
