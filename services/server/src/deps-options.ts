import type { GitHostNet } from "./git-hosts/http.js";
import type { SessionSigningKey } from "@kaiju/session-token";
import type { Envelope } from "@kaiju/db";
import type { ScoreSink } from "@kaiju/telemetry";
import type { AppCaller } from "./apps/app-caller.js";
import type { ApprovalKeyring, ApprovalServiceOptions } from "./approvals/index.js";
import type { ForwardDestination } from "./audit/forward/types.js";
import type { AgentLimits } from "./deps.js";
import type { BackgroundTasks } from "./background.js";
import type { BrandingDefaults } from "./branding/defaults-config.js";
import type { DbTimeouts } from "./config.js";
import type { ConnectorProbe } from "./connectors/probe.js";
import type { ConnectorUrlPolicy } from "./connectors/url-policy.js";
import type { HubOptions } from "./event-stream/hub.js";
import type { StreamTimings } from "./event-stream/stream.js";
import type { Mailer } from "./mail/mailer.js";
import type { ModelDiscovery } from "./models/discovery.js";
import type { ModelTokenDefaults } from "./models/token-limits.js";
import type { ListenTuning } from "./pg-listen.js";
import type { BlobStore } from "./retention/blobs.js";
import type { RunOrchestratorOptions } from "./runs/index.js";
import type { IsolationProbe } from "./runs/seams.js";
import type { SandboxWireOptions } from "./sandbox-wire/index.js";
import type { SsoNet } from "./sso/net.js";
import type { SsoSettings } from "./sso/settings.js";
import type { UploadSettings } from "./uploads/settings.js";

/** What `createServerDeps` is built from (deps.ts; split out by KOBE-709 to keep it short). */
export interface ServerDepsOptions {
  readonly databaseUrl: string;
  /** App-role connection timeouts (KOBE-732); the @kaiju/db defaults when absent. */
  readonly dbTimeouts?: DbTimeouts;
  /**
   * The query pool (KOBE-736): its size (default 10) and `application_name` (default
   * `kaiju-server`; the scheduler passes `kaiju-scheduler`).
   */
  readonly dbPool?: { readonly max?: number; readonly applicationName?: string };
  readonly publicUrl: string;
  /** KAIJU_RETENTION_PAUSED (KOBE-243): shown to site admins; the deleting jobs honour it. */
  readonly retentionPaused?: boolean;
  /** Months per-call usage is kept (KOBE-741 sweep); null: kept for ever. Shown on usage pages. */
  readonly usageRetentionMonths?: number | null;
  /** Chart-seeded branding defaults (KOBE-503): seeded at start and after a reset while unset. */
  readonly brandingDefaults?: BrandingDefaults;
  readonly authSecret: string;
  /** One-time secret proving possession of the install for first-run setup. */
  readonly setupToken: string;
  readonly trustedProxies: readonly string[];
  /**
   * The process's one LISTEN connection (KOBE-704): its `application_name` (default
   * `kaiju-server-listen`) and tuning (tests shorten the timers).
   */
  readonly listen?: Partial<ListenTuning> & { readonly applicationName?: string };
  /** Kaiju Event Stream tuning (tests shorten the timers). */
  readonly eventStream?: {
    readonly hub?: Omit<
      HubOptions,
      | "connectionString"
      | "listen"
      | "reconnectMinMs"
      | "reconnectMaxMs"
      | "pingMs"
      | "pingTimeoutMs"
    >;
    readonly timings?: Partial<StreamTimings>;
    /** Connections of the stream read pool (default STREAM_POOL_MAX). */
    readonly poolMax?: number;
  };
  /** SIEM destinations configured by Helm values (KOBE-19); the admin health view lists them. */
  readonly auditForwardingDestinations?: readonly ForwardDestination[];
  /** Configured forwarding credentials the health view must never show (`forwardingSecrets`). */
  readonly auditForwardingSecrets?: readonly string[];
  /** Outgoing email (invitations, password resets, notifications). */
  readonly mailer: Mailer;
  /** Agent version limits (KOBE-46); defaults in `AGENT_LIMIT_DEFAULTS`. */
  readonly agents?: Partial<AgentLimits>;
  /** Off-request-path work; tests pass their own to wait on it (default: a new tracker). */
  readonly background?: BackgroundTasks;
  /** Sandbox wire seams and tuning (KOBE-24): approvals, UI, run hooks, wake, policy context. */
  readonly sandboxWire?: Partial<Omit<SandboxWireOptions, "db" | "databaseUrl">>;
  /**
   * D4: the process's isolation check (`IsolationGate.status()`, startup/server.ts). Required, no
   * default (KOBE-708): new runs start only while it answers `available`. Tests pass a fake from
   * `testing/isolation.ts`.
   */
  readonly isolation: IsolationProbe;
  /** Run orchestrator seams and tuning (KOBE-30): agent resolution, budgets, timings. */
  readonly runs?: Partial<
    Omit<RunOrchestratorOptions, "db" | "router" | "isolation" | "notebooks" | "workspace">
  >;
  /** Where registered connectors may point (KOBE-100); default: https, port 443, public addresses. */
  readonly connectors?: Partial<ConnectorUrlPolicy>;
  /**
   * Workspace git (KOBE-760): the pinned request git host adapters send through, after the
   * address policy passed (default the connectors' guarded client). Tests answer from a fake host.
   */
  readonly gitHostRequest?: GitHostNet["request"];
  /** Convert to repo (KOBE-765): git smart-HTTP after the checks (tests answer from a git server). */
  readonly gitWireSend?: GitHostNet["wire"];
  /** Probes a registered connector's tools through the MCP proxy (KOBE-101); unset = cannot pin. */
  readonly connectorProbe?: ConnectorProbe;
  /** MCP Apps' own calls through the MCP proxy (KOBE-436); unset = every app call fails. */
  readonly appCaller?: AppCaller;
  /** MCP proxy re-check seams (KOBE-58). */
  readonly mcp?: { readonly now?: () => Date };
  /**
   * Model gateway (KOBE-40): the secrets sealing provider API keys (current first) and the
   * operator's unsafe-endpoints switch; unset = not configured.
   */
  readonly models?: {
    readonly providerKeySecrets: readonly string[];
    readonly allowUnsafeEndpoints?: boolean;
    /** Bifrost's model listing for the catalog editor (KOBE-44); unset: no model picker. */
    readonly discovery?: ModelDiscovery;
  };
  /**
   * The site's approval HMAC key (KOBE-37, config `KAIJU_APPROVAL_KEY`); without it, tool calls
   * that need approval are denied.
   */
  readonly approvalKeys?: ApprovalKeyring;
  /** Approval tuning (tests shorten the TTL and the poll). */
  readonly approvals?: Partial<Omit<ApprovalServiceOptions, "db" | "keys">>;
  /**
   * Header injection (KOBE-39, config `KAIJU_EGRESS_HEADER_SECRET`): the secrets sealing injected
   * header values (current first); unset = header injection off.
   */
  readonly egressHeaderSecrets?: readonly string[];
  /** Site envelope (KOBE-107, `KAIJU_ENVELOPE_KEY`) for per-record secrets; unset = off. */
  readonly envelope?: Envelope;
  /**
   * Single sign-on (`auth.sso`, KOBE-626): the kill switch, the SSRF exceptions and the Helm
   * providers; unset = off. `net` overrides the outbound address policy (tests only).
   */
  readonly sso?: {
    readonly settings: SsoSettings;
    readonly net?: Partial<ConnectorUrlPolicy>;
    readonly request?: SsoNet["request"];
  };
  /**
   * Object storage (`s3.*`, KOBE-27) for thread blobs: export reads offloaded entries, retention
   * deletes released keys (KOBE-18). Unset: nothing is read or deleted from a bucket.
   */
  readonly blobs?: BlobStore;
  /** Upload limits and the default team storage quota (KOBE-143); unset: the contract defaults. */
  readonly uploads?: UploadSettings;
  /** Limits of models without their own (KOBE-259, chart values); unset: `MODEL_TOKEN_DEFAULTS`. */
  readonly modelTokenDefaults?: ModelTokenDefaults;
  /**
   * The server's own model calls (KOBE-234/219: auto-titles) through the model gateway: its
   * in-cluster URL (`KAIJU_MODEL_GATEWAY_URL`) and the server-call token key (the model-gateway
   * Ed25519 signing key, KOBE-521). Unset: no run announces an epilogue and nothing is called.
   */
  readonly serverCalls?: {
    readonly gatewayUrl: string;
    readonly key: SessionSigningKey;
    readonly fetch?: typeof fetch;
  };
  /**
   * Memory embeddings (KOBE-409): the chart's in-cluster embedding model as the gateway names it
   * (`kobe-local/<model>`, KOBE-659), offered in the Site console; unset: none runs. Tests may
   * shorten the selector's query-embedding deadline.
   */
  readonly embeddings?: {
    readonly localModel?: string;
    readonly queryDeadlineMs?: number;
    /** Build vectors' first wait for the gateway sync (tests: 0). */
    readonly gatewaySyncWaitMs?: number;
  };
  /**
   * Answer ratings as trace scores (KOBE-275): the tracing backend's score sink (Langfuse only,
   * `@kaiju/telemetry` createLangfuseScoreSink) and whether scores may carry the comment
   * (`telemetry.captureContent`). Unset: ratings are not exported.
   */
  readonly feedbackScores?: { readonly sink: ScoreSink; readonly captureContent: boolean };
}
