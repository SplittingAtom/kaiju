import {
  APP_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  APP_STATEMENT_TIMEOUT_MS,
  DEFAULT_POOL_MAX,
} from "@kobe/db";
import { STREAM_POOL_MAX } from "./event-stream/read.js";
import { z } from "zod";
import { loadAuditForwardingConfig, type AuditForwardingConfig } from "./audit/forward/config.js";
import { brandingDefaultsSchema, type BrandingDefaults } from "./branding/defaults-config.js";
import { smtpSchema, type SmtpConfig } from "./mail/config.js";
import { parseModelTokenDefaults, type ModelTokenDefaults } from "./models/token-limits.js";
import {
  DEFAULT_TABLE_SWEEPS,
  SWEEP_LIMITS,
  type TableSweepSettings,
} from "./retention/table-sweeps.js";

/** A table sweep's period (KOBE-741): a whole number within `limits`, or 0 for off (null). */
function sweepPeriod(
  name: string,
  fallback: number | null,
  limits: { readonly min: number; readonly max: number },
) {
  const range = `${name} must be 0 (off) or between ${limits.min} and ${limits.max}`;
  // Unset or empty means the default; only an explicit 0 turns the sweep off.
  return z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.coerce
      .number({ error: `${name} must be a number` })
      .int(`${name} must be an integer`)
      .refine((v) => v === 0 || (v >= limits.min && v <= limits.max), range)
      .default(fallback ?? 0)
      .transform((v) => (v === 0 ? null : v)),
  );
}

const configSchema = z.object({
  PORT: z.coerce
    .number({ error: "PORT must be a number" })
    .int("PORT must be an integer")
    .min(1, "PORT must be between 1 and 65535")
    .max(65535, "PORT must be between 1 and 65535")
    .default(8080),
  // One image, two processes: the API server and the Postgres-leased scheduler (spec D32).
  KOBE_PROCESS: z
    .enum(["server", "scheduler"], { error: "KOBE_PROCESS must be server or scheduler" })
    .default("server"),
  // App-role connection (never the owner); team data is reachable only through withTeam().
  KOBE_DATABASE_URL: z.url({
    protocol: /^postgres(ql)?$/,
    error: "KOBE_DATABASE_URL must be a postgres:// URL",
  }),
  // RuntimeClass sandboxes run under; the isolation gate verifies its handler (spec D4). Unset
  // keeps the server up with agents disabled, so the admin console can show the fix.
  KOBE_RUNTIME_CLASS: z
    .string()
    .trim()
    .transform((v) => (v === "" ? undefined : v))
    .pipe(
      z
        .string()
        .max(253)
        .regex(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/, "KOBE_RUNTIME_CLASS must be a RuntimeClass name")
        .optional(),
    )
    .optional(),
  // Published versions per agent (KOBE-46): versions are immutable and never deleted by the app.
  KOBE_AGENT_MAX_VERSIONS: z.coerce
    .number({ error: "KOBE_AGENT_MAX_VERSIONS must be a number" })
    .int("KOBE_AGENT_MAX_VERSIONS must be an integer")
    .min(1, "KOBE_AGENT_MAX_VERSIONS must be between 1 and 100000")
    .max(100_000, "KOBE_AGENT_MAX_VERSIONS must be between 1 and 100000")
    .default(1000),
  // Internal listener (KOBE-58): the MCP proxy's policy re-check. Only with the proxy's key.
  KOBE_INTERNAL_PORT: z.coerce
    .number({ error: "KOBE_INTERNAL_PORT must be a number" })
    .int("KOBE_INTERNAL_PORT must be an integer")
    .min(1, "KOBE_INTERNAL_PORT must be between 1 and 65535")
    .max(65535, "KOBE_INTERNAL_PORT must be between 1 and 65535")
    .default(8082),
  KOBE_MCP_PROXY_INTERNAL_KEY: z
    .string()
    .min(32, "KOBE_MCP_PROXY_INTERNAL_KEY must be at least 32 characters")
    .optional(),
  // The key the egress proxy presents for git decisions (KOBE-763) on the internal listener.
  // Unset: git smart-HTTP from sandboxes gets no credential.
  KOBE_EGRESS_PROXY_INTERNAL_KEY: z
    .string()
    .transform((v) => (v === "" ? undefined : v))
    .pipe(
      z
        .string()
        .min(32, "KOBE_EGRESS_PROXY_INTERNAL_KEY must be at least 32 characters")
        .optional(),
    )
    .optional(),
  // What the server presents to the MCP proxy's internal routes (probe, app calls; KOBE-693),
  // separate from the key above, which the proxy presents here. Empty or unset (an operator's
  // Secret without the second key): the key above serves both ways.
  KOBE_MCP_PROXY_ROUTES_KEY: z
    .string()
    .transform((v) => (v === "" ? undefined : v))
    .pipe(z.string().min(32, "KOBE_MCP_PROXY_ROUTES_KEY must be at least 32 characters").optional())
    .optional(),
  // The MCP proxy's internal routes (KOBE-101 probe, KOBE-436 app calls; their own port since
  // KOBE-693), with the routes key. Unset: no pinning.
  KOBE_MCP_PROXY_URL: z
    .url({ protocol: /^https?$/, error: "KOBE_MCP_PROXY_URL must be an http(s) URL" })
    .optional(),
  // The model gateway's in-cluster address for the server's own calls (KOBE-219 auto-titles).
  // Unset: no server calls. A plain origin: the server-call token must not go anywhere else.
  KOBE_MODEL_GATEWAY_URL: z
    .url({ protocol: /^https?$/, error: "KOBE_MODEL_GATEWAY_URL must be an http(s) URL" })
    .refine((u) => {
      const url = new URL(u);
      return url.username === "" && url.password === "" && url.search === "" && url.hash === "";
    }, "KOBE_MODEL_GATEWAY_URL must be a plain origin without credentials")
    .optional(),
  // UTC hour the nightly retention pass runs in (KOBE-18, D18).
  KOBE_RETENTION_HOUR_UTC: z.coerce
    .number({ error: "KOBE_RETENTION_HOUR_UTC must be a number" })
    .int("KOBE_RETENTION_HOUR_UTC must be an integer")
    .min(0, "KOBE_RETENTION_HOUR_UTC must be between 0 and 23")
    .max(23, "KOBE_RETENTION_HOUR_UTC must be between 0 and 23")
    .default(3),
  // Pauses the nightly retention pass (KOBE-243); set after restoring the database from an older
  // backup, until the bucket is reconciled (docs/backup-restore.md).
  KOBE_RETENTION_PAUSED: z
    .enum(["true", "false"], { error: "KOBE_RETENTION_PAUSED must be true or false" })
    .default("false")
    .transform((v) => v === "true"),
  // Table sweeps of the nightly retention pass (KOBE-741): how long each table keeps its rows;
  // 0 turns that sweep off. Chart `retention.sweeps`.
  KOBE_RETENTION_EVENTS_DAYS: sweepPeriod(
    "KOBE_RETENTION_EVENTS_DAYS",
    DEFAULT_TABLE_SWEEPS.eventsDays,
    SWEEP_LIMITS.eventsDays,
  ),
  KOBE_RETENTION_READ_NOTIFICATIONS_DAYS: sweepPeriod(
    "KOBE_RETENTION_READ_NOTIFICATIONS_DAYS",
    DEFAULT_TABLE_SWEEPS.readNotificationsDays,
    SWEEP_LIMITS.readNotificationsDays,
  ),
  KOBE_RETENTION_RUN_USAGE_MONTHS: sweepPeriod(
    "KOBE_RETENTION_RUN_USAGE_MONTHS",
    DEFAULT_TABLE_SWEEPS.runUsageMonths,
    SWEEP_LIMITS.runUsageMonths,
  ),
  KOBE_RETENTION_EVAL_HISTORY_MONTHS: sweepPeriod(
    "KOBE_RETENTION_EVAL_HISTORY_MONTHS",
    DEFAULT_TABLE_SWEEPS.evalHistoryMonths,
    SWEEP_LIMITS.evalHistoryMonths,
  ),
  // App-role connection timeouts (KOBE-732); 0 turns one off. Defaults in @kobe/db (client.ts).
  KOBE_DB_STATEMENT_TIMEOUT_MS: z.coerce
    .number({ error: "KOBE_DB_STATEMENT_TIMEOUT_MS must be a number" })
    .int("KOBE_DB_STATEMENT_TIMEOUT_MS must be an integer")
    .min(0, "KOBE_DB_STATEMENT_TIMEOUT_MS must be 0 or more")
    .default(APP_STATEMENT_TIMEOUT_MS),
  KOBE_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: z.coerce
    .number({ error: "KOBE_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS must be a number" })
    .int("KOBE_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS must be an integer")
    .min(0, "KOBE_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS must be 0 or more")
    .default(APP_IDLE_IN_TRANSACTION_TIMEOUT_MS),
  // Connection budget (KOBE-736): pool sizes per pod and, for the start-up check, the replica
  // count and the other components' connections the chart computes.
  KOBE_DB_POOL_MAX: poolSize("KOBE_DB_POOL_MAX", 200, DEFAULT_POOL_MAX),
  KOBE_DB_STREAM_POOL_MAX: poolSize("KOBE_DB_STREAM_POOL_MAX", 100, STREAM_POOL_MAX),
  KOBE_DB_BUDGET_SERVER_REPLICAS: z.coerce
    .number({ error: "KOBE_DB_BUDGET_SERVER_REPLICAS must be a number" })
    .int("KOBE_DB_BUDGET_SERVER_REPLICAS must be an integer")
    .min(1, "KOBE_DB_BUDGET_SERVER_REPLICAS must be 1 or more")
    .optional(),
  KOBE_DB_BUDGET_PEER_CONNECTIONS: z.coerce
    .number({ error: "KOBE_DB_BUDGET_PEER_CONNECTIONS must be a number" })
    .int("KOBE_DB_BUDGET_PEER_CONNECTIONS must be an integer")
    .min(0, "KOBE_DB_BUDGET_PEER_CONNECTIONS must be 0 or more")
    .optional(),
  // Seconds between reconciles of every team namespace's managed objects (KOBE-115); 0 turns the
  // interval off (the run at server start stays).
  KOBE_TEAM_RECONCILE_SECONDS: z.coerce
    .number({ error: "KOBE_TEAM_RECONCILE_SECONDS must be a number" })
    .int("KOBE_TEAM_RECONCILE_SECONDS must be an integer")
    .refine(
      (n) => n === 0 || (n >= 30 && n <= 86_400),
      "KOBE_TEAM_RECONCILE_SECONDS must be 0 or between 30 and 86400",
    )
    .default(300),
  // Hours a skill version's rescan under a new scanner rule set may keep not finishing before the
  // version is suspended (review g79); 0 = never.
  KOBE_SKILL_RESCAN_INCOMPLETE_SUSPEND_HOURS: z.coerce
    .number({ error: "KOBE_SKILL_RESCAN_INCOMPLETE_SUSPEND_HOURS must be a number" })
    .int("KOBE_SKILL_RESCAN_INCOMPLETE_SUSPEND_HOURS must be an integer")
    .min(0, "KOBE_SKILL_RESCAN_INCOMPLETE_SUSPEND_HOURS must be 0 or more")
    .max(8760, "KOBE_SKILL_RESCAN_INCOMPLETE_SUSPEND_HOURS must be at most 8760")
    .default(24),
  // Seconds between re-probes of every pinned connector for tool drift (KOBE-102); 0 = never.
  KOBE_CONNECTOR_REFRESH_SECONDS: z.coerce
    .number({ error: "KOBE_CONNECTOR_REFRESH_SECONDS must be a number" })
    .int("KOBE_CONNECTOR_REFRESH_SECONDS must be an integer")
    .refine(
      (n) => n === 0 || (n >= 60 && n <= 86_400),
      "KOBE_CONNECTOR_REFRESH_SECONDS must be 0 or between 60 and 86400",
    )
    .default(3600),
  // Scheduler runner (KOBE-174): seconds between scans for due schedules.
  KOBE_SCHEDULER_TICK_SECONDS: z.coerce
    .number({ error: "KOBE_SCHEDULER_TICK_SECONDS must be a number" })
    .int("KOBE_SCHEDULER_TICK_SECONDS must be an integer")
    .min(5, "KOBE_SCHEDULER_TICK_SECONDS must be between 5 and 3600")
    .max(3600, "KOBE_SCHEDULER_TICK_SECONDS must be between 5 and 3600")
    .default(15),
  // Scheduler runner: how late an occurrence may still fire after downtime (older ones are skipped).
  KOBE_SCHEDULER_GRACE_MINUTES: z.coerce
    .number({ error: "KOBE_SCHEDULER_GRACE_MINUTES must be a number" })
    .int("KOBE_SCHEDULER_GRACE_MINUTES must be an integer")
    .min(1, "KOBE_SCHEDULER_GRACE_MINUTES must be between 1 and 1440")
    .max(1440, "KOBE_SCHEDULER_GRACE_MINUTES must be between 1 and 1440")
    .default(60),
  // Lifetime of sandbox session tokens (15 min, packages/session-token). Shorter only so the e2e
  // can run a real Pi past a token rotation (KOBE-241); the MCP proxy's expired-token cap stays
  // at twice the default.
  KOBE_SESSION_TOKEN_TTL_SECONDS: z.coerce
    .number({ error: "KOBE_SESSION_TOKEN_TTL_SECONDS must be a number" })
    .int("KOBE_SESSION_TOKEN_TTL_SECONDS must be an integer")
    .min(10, "KOBE_SESSION_TOKEN_TTL_SECONDS must be between 10 and 900")
    .max(900, "KOBE_SESSION_TOKEN_TTL_SECONDS must be between 10 and 900")
    .default(900),
});

/** Who limits requests per client at the ingress (KOBE-811). */
export const INGRESS_RATE_LIMIT_SOURCES = ["chart", "external", "none", "unknown"] as const;
export type IngressRateLimitSource = (typeof INGRESS_RATE_LIMIT_SOURCES)[number];

/** Auth settings: required by the API server only (the scheduler never sees these secrets). */
const authSchema = z.object({
  // Public origin of the install: cookie scope and the WebAuthn relying party.
  KOBE_PUBLIC_URL: z
    .url({ protocol: /^https?$/, error: "KOBE_PUBLIC_URL must be an http(s) URL" })
    .refine(
      (u) => URL.canParse(u) && new URL(u).pathname === "/",
      "KOBE_PUBLIC_URL must be an origin without a path",
    )
    .transform((u) => new URL(u).origin),
  KOBE_AUTH_SECRET: z.string().min(32, "KOBE_AUTH_SECRET must be at least 32 characters"),
  KOBE_SETUP_TOKEN: z.string().min(24, "KOBE_SETUP_TOKEN must be at least 24 characters"),
  // Comma-separated CIDRs of the proxies in front of the server (Traefik / load balancer).
  KOBE_TRUSTED_PROXIES: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    )
    .pipe(z.array(z.cidrv4().or(z.cidrv6()), { error: "KOBE_TRUSTED_PROXIES must be CIDRs" })),
  // Approval HMAC key (D29, KOBE-37): the server signs approvals and verifies them itself on the
  // MCP proxy's policy re-check; no proxy holds it (KOBE-520). Unset keeps the server up, but every
  // tool call that needs approval is denied (fail closed).
  KOBE_APPROVAL_KEY: z
    .string()
    .transform((v) => (v === "" ? undefined : v))
    .pipe(z.string().min(32, "KOBE_APPROVAL_KEY must be at least 32 characters").optional())
    .optional(),
  // HSTS includeSubDomains (KOBE-695, chart `ingress.hsts.includeSubDomains`); HSTS itself is sent
  // whenever KOBE_PUBLIC_URL is https.
  KOBE_HSTS_INCLUDE_SUBDOMAINS: z
    .enum(["true", "false"], { error: "KOBE_HSTS_INCLUDE_SUBDOMAINS must be true or false" })
    .default("false")
    .transform((v) => v === "true"),
  // Who limits requests per client at the ingress (KOBE-811, chart `ingress.rateLimit`): the
  // chart's Traefik middleware, the operator's own edge, nobody, or unknown (no chart-managed
  // Ingress). Only shown in the Site console's health view.
  KOBE_INGRESS_RATE_LIMIT: z
    .enum(INGRESS_RATE_LIMIT_SOURCES, {
      error: "KOBE_INGRESS_RATE_LIMIT must be chart, external, none or unknown",
    })
    .default("unknown"),
});

export interface AuthConfig {
  readonly publicUrl: string;
  readonly authSecret: string;
  readonly setupToken: string;
  readonly trustedProxies: readonly string[];
  /** Approval HMAC key; undefined denies every approval request. */
  readonly approvalKey?: string;
  /** Add `includeSubDomains` to the HSTS header (KOBE-695). */
  readonly hstsIncludeSubDomains: boolean;
  /** Who limits requests at the ingress (KOBE-811), for the Site console's health view. */
  readonly ingressRateLimit: IngressRateLimitSource;
}

/** A connection pool size, 1..`max` (KOBE-736). */
function poolSize(name: string, max: number, fallback: number) {
  return z.coerce
    .number({ error: `${name} must be a number` })
    .int(`${name} must be an integer`)
    .min(1, `${name} must be between 1 and ${max}`)
    .max(max, `${name} must be between 1 and ${max}`)
    .default(fallback);
}

/** Pool sizes of this process (KOBE-736). */
export interface DbPools {
  /** Query pool (`KOBE_DB_POOL_MAX`). */
  readonly max: number;
  /** Event-stream read pool (`KOBE_DB_STREAM_POOL_MAX`; the scheduler opens none). */
  readonly streamMax: number;
}

export interface DbTimeouts {
  readonly statementTimeoutMs: number;
  readonly idleInTransactionTimeoutMs: number;
}

export interface Config {
  readonly port: number;
  readonly process: "server" | "scheduler";
  readonly databaseUrl: string;
  /** App-role connection timeouts (KOBE-732). */
  readonly dbTimeouts: DbTimeouts;
  /** Pool sizes (KOBE-736). */
  readonly dbPools: DbPools;
  /** Start-up budget check inputs from the chart (KOBE-736); undefined: no check. */
  readonly dbBudget:
    { readonly serverReplicas: number; readonly peerConnections: number } | undefined;
  /** Sandbox RuntimeClass; undefined means agents stay disabled. */
  readonly runtimeClassName: string | undefined;
  /** Published versions per agent (KOBE-46). */
  readonly agentMaxVersions: number;
  /** Internal listener port (MCP proxy re-check, KOBE-58). */
  readonly internalPort: number;
  /** Shared with the MCP proxy; without it the internal listener is not started. */
  readonly mcpProxyInternalKey: string | undefined;
  /** The egress proxy's key for git decisions on the internal listener (KOBE-763). */
  readonly egressProxyInternalKey: string | undefined;
  /** What the server presents to the proxy's internal routes (KOBE-693); falls back to the above. */
  readonly mcpProxyRoutesKey: string | undefined;
  /** The MCP proxy's internal routes base URL, for the pinning probe (KOBE-101). */
  readonly mcpProxyUrl: string | undefined;
  /** The model gateway's origin for the server's own calls (KOBE-219); unset: none. */
  readonly modelGatewayUrl: string | undefined;
  /** UTC hour of the nightly retention pass (KOBE-18). */
  readonly retentionHourUtc: number;
  /** The nightly retention pass is paused (KOBE-243). */
  readonly retentionPaused: boolean;
  /** Periods of the retention pass's table sweeps (KOBE-741); null: that sweep is off. */
  readonly retentionSweeps: TableSweepSettings;
  /** Seconds between team-namespace reconciles; 0 = only at start (KOBE-115). */
  readonly teamReconcileSeconds: number;
  /** Seconds between connector drift refreshes; 0 = off (KOBE-102). */
  readonly connectorRefreshSeconds: number;
  /** Hours of unfinished rescans before a skill version is suspended; 0 = never (review g79). */
  readonly skillRescanIncompleteSuspendHours: number;
  /** Sandbox session token lifetime in seconds (900 unless an e2e install shortens it). */
  readonly sessionTokenTtlSeconds: number;
  /** Output limit and context window of models without their own (KOBE-259, chart values). */
  readonly modelTokenDefaults: ModelTokenDefaults;
  /** Scheduler runner settings (KOBE-174); read by the scheduler process only. */
  readonly scheduler: { readonly tickSeconds: number; readonly graceMinutes: number };
  /** SIEM forwarding of audit events (KOBE-19); empty when not configured. */
  readonly auditForwarding: AuditForwardingConfig;
  /** Present for the API server only. */
  readonly auth?: AuthConfig;
  /** Present for the API server only (invites, password resets, notifications). */
  readonly smtp?: SmtpConfig;
  /** Chart-seeded branding defaults (KOBE-503); API server only, empty when none is set. */
  readonly branding?: BrandingDefaults;
}

function fail(error: z.ZodError): never {
  // Messages only (never input values), so secrets can't leak into logs.
  const issues = error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  throw new Error(`Invalid configuration: ${issues}`);
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): Config {
  const base = configSchema.safeParse(env);
  if (!base.success) fail(base.error);
  const tokenDefaults = parseModelTokenDefaults(env);
  if (!tokenDefaults.success) fail(tokenDefaults.error);
  const config = {
    port: base.data.PORT,
    process: base.data.KOBE_PROCESS,
    databaseUrl: base.data.KOBE_DATABASE_URL,
    dbTimeouts: {
      statementTimeoutMs: base.data.KOBE_DB_STATEMENT_TIMEOUT_MS,
      idleInTransactionTimeoutMs: base.data.KOBE_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    },
    dbPools: { max: base.data.KOBE_DB_POOL_MAX, streamMax: base.data.KOBE_DB_STREAM_POOL_MAX },
    dbBudget:
      base.data.KOBE_DB_BUDGET_SERVER_REPLICAS === undefined
        ? undefined
        : {
            serverReplicas: base.data.KOBE_DB_BUDGET_SERVER_REPLICAS,
            peerConnections: base.data.KOBE_DB_BUDGET_PEER_CONNECTIONS ?? 0,
          },
    runtimeClassName: base.data.KOBE_RUNTIME_CLASS,
    agentMaxVersions: base.data.KOBE_AGENT_MAX_VERSIONS,
    internalPort: base.data.KOBE_INTERNAL_PORT,
    mcpProxyInternalKey: base.data.KOBE_MCP_PROXY_INTERNAL_KEY,
    egressProxyInternalKey: base.data.KOBE_EGRESS_PROXY_INTERNAL_KEY,
    mcpProxyRoutesKey: base.data.KOBE_MCP_PROXY_ROUTES_KEY ?? base.data.KOBE_MCP_PROXY_INTERNAL_KEY,
    mcpProxyUrl: base.data.KOBE_MCP_PROXY_URL,
    modelGatewayUrl:
      base.data.KOBE_MODEL_GATEWAY_URL === undefined
        ? undefined
        : new URL(base.data.KOBE_MODEL_GATEWAY_URL).origin,
    retentionHourUtc: base.data.KOBE_RETENTION_HOUR_UTC,
    retentionPaused: base.data.KOBE_RETENTION_PAUSED,
    retentionSweeps: {
      eventsDays: base.data.KOBE_RETENTION_EVENTS_DAYS,
      readNotificationsDays: base.data.KOBE_RETENTION_READ_NOTIFICATIONS_DAYS,
      runUsageMonths: base.data.KOBE_RETENTION_RUN_USAGE_MONTHS,
      evalHistoryMonths: base.data.KOBE_RETENTION_EVAL_HISTORY_MONTHS,
    },
    teamReconcileSeconds: base.data.KOBE_TEAM_RECONCILE_SECONDS,
    connectorRefreshSeconds: base.data.KOBE_CONNECTOR_REFRESH_SECONDS,
    skillRescanIncompleteSuspendHours: base.data.KOBE_SKILL_RESCAN_INCOMPLETE_SUSPEND_HOURS,
    sessionTokenTtlSeconds: base.data.KOBE_SESSION_TOKEN_TTL_SECONDS,
    modelTokenDefaults: tokenDefaults.data,
    scheduler: {
      tickSeconds: base.data.KOBE_SCHEDULER_TICK_SECONDS,
      graceMinutes: base.data.KOBE_SCHEDULER_GRACE_MINUTES,
    },
    auditForwarding: loadAuditForwardingConfig(env),
  };
  if (config.process !== "server") return config;
  const auth = authSchema.safeParse(env);
  if (!auth.success) fail(auth.error);
  const smtp = smtpSchema.safeParse(env);
  if (!smtp.success) fail(smtp.error);
  const branding = brandingDefaultsSchema.safeParse(env);
  if (!branding.success) fail(branding.error);
  return {
    ...config,
    auth: {
      publicUrl: auth.data.KOBE_PUBLIC_URL,
      authSecret: auth.data.KOBE_AUTH_SECRET,
      setupToken: auth.data.KOBE_SETUP_TOKEN,
      trustedProxies: auth.data.KOBE_TRUSTED_PROXIES,
      hstsIncludeSubDomains: auth.data.KOBE_HSTS_INCLUDE_SUBDOMAINS,
      ingressRateLimit: auth.data.KOBE_INGRESS_RATE_LIMIT,
      ...(auth.data.KOBE_APPROVAL_KEY ? { approvalKey: auth.data.KOBE_APPROVAL_KEY } : {}),
    },
    smtp: smtp.data,
    branding: branding.data,
  };
}
