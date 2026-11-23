import { createProxyAppCaller } from "../apps/app-caller.js";
import {
  createLangfuseScoreSink,
  loadTelemetryConfig,
  type TelemetryConfig,
} from "@kobe/telemetry";
import {
  PROVIDER_KEY_PURPOSE,
  SecretBox,
  VIRTUAL_KEY_PURPOSE,
  headerBox,
  loadEnvelope,
  type Envelope,
} from "@kobe/db";
import type { Logger } from "pino";
import { approvalKeyring } from "../approvals/index.js";
import { destinationsOf } from "../audit/forward/index.js";
import { forwardingSecrets } from "../audit/forward/redact.js";
import type { Config } from "../config.js";
import { loadConnectorUrlPolicy } from "../connectors/config.js";
import { createProxyProbe, PROBE_TIMEOUT_MS } from "../connectors/probe.js";
import { createServerDeps, type ServerDeps } from "../deps.js";
import { loadEgressHeaderSecrets } from "../egress/config.js";
import { createSmtpMailer } from "../mail/mailer.js";
import { createHttpBifrostAdmin, type BifrostAdmin } from "../models/bifrost-admin.js";
import { loadModelsConfig, type ModelsConfig } from "../models/config.js";
import { serverCallKeyFromEnv } from "../models/gateway-client.js";
import { localEmbeddingGatewayModel } from "../models/local-embedding.js";
import type { IsolationProbe } from "../runs/seams.js";
import type { SandboxWaker } from "../sandbox-wire/types.js";
import { runTokenKeyFromEnv, traceSpanKeyFromEnv } from "../sandbox-wire/run-token.js";
import { schedulerAuthStandIn } from "../scheduler/process-deps.js";
import { loadSsoSettings } from "../sso/settings.js";
import { loadUploadSettings, type UploadSettings } from "../uploads/settings.js";
import {
  checkBucketLifecycle,
  createS3ObjectStore,
  loadS3Settings,
  plainHttpEndpointWarning,
} from "../workspace-sync/index.js";
import { checkSealedKeys, sealedFamilies } from "./sealed-keys.js";

export type ProcessEnv = Readonly<Record<string, string | undefined>>;

/** What the process reads from its environment besides `Config` (each loader validates). */
export interface ProcessSettings {
  readonly telemetry: TelemetryConfig;
  readonly s3: ReturnType<typeof loadS3Settings>;
  readonly objectStore: ReturnType<typeof createS3ObjectStore> | undefined;
  readonly uploads: UploadSettings;
  readonly models: ModelsConfig | undefined;
  readonly egressHeaderSecrets: readonly string[] | undefined;
  readonly envelope: Envelope | undefined;
  readonly bifrostAdmin: BifrostAdmin | undefined;
  readonly runTokenKey: ReturnType<typeof runTokenKeyFromEnv>;
  readonly traceSpanKey: ReturnType<typeof traceSpanKeyFromEnv>;
  readonly serverCallKey: ReturnType<typeof serverCallKeyFromEnv>;
}

export function loadProcessSettings(config: Config, env: ProcessEnv, log: Logger): ProcessSettings {
  const isServer = config.process === "server";
  // Object storage (s3.*): workspace sync (KOBE-27), thread export and retention (KOBE-18).
  const s3 = loadS3Settings(env);
  // Model gateway (KOBE-40): undefined without the chart's Bifrost settings (models off).
  const models = isServer ? loadModelsConfig(env) : undefined;
  return {
    telemetry: loadTelemetryConfig(env, config.process),
    s3,
    objectStore: s3 ? createS3ObjectStore(s3) : undefined,
    // Upload limits and the default team storage quota (KOBE-143); invalid values fail the start.
    uploads: loadUploadSettings(env),
    models,
    // Header injection (KOBE-39): undefined without the chart's header secret (off).
    egressHeaderSecrets: isServer ? loadEgressHeaderSecrets(env) : undefined,
    // Site envelope key (KOBE-107): seals per-record secrets (connector credentials, KOBE-108).
    // Fails fast when malformed; the key itself is never logged.
    envelope: isServer ? loadEnvelope(env, log) : undefined,
    // One admin client for the config sync and the catalog editor's model listing (KOBE-44).
    bifrostAdmin: models
      ? createHttpBifrostAdmin({
          baseUrl: models.bifrostUrl,
          username: models.adminUsername,
          password: models.adminPassword,
        })
      : undefined,
    // Run-bound model-gateway tokens (KOBE-118): signed with the model-gateway Ed25519 key (KOBE-521).
    runTokenKey: runTokenKeyFromEnv(env),
    // Relayed sandbox spans (KOBE-274): `k_trace` from KOBE_TRACE_SPAN_KEY; unset: no span relay.
    traceSpanKey: traceSpanKeyFromEnv(env, (message) => log.warn(message)),
    // The server's own model calls (KOBE-219 auto-titles): the gateway's address and the same
    // Ed25519 signing key (KOBE-521). Either unset: no titles (logged at start).
    serverCallKey: serverCallKeyFromEnv(env),
  };
}

export interface ProcessDepsInput {
  readonly config: Config;
  readonly env: ProcessEnv;
  readonly settings: ProcessSettings;
  readonly log: Logger;
  /** D4: the isolation gate's answer; required by the run orchestrator (KOBE-708). */
  readonly isolation: IsolationProbe;
  /** The wire is built before the sandbox provider exists: its waker is set once the provider is. */
  readonly waker: SandboxWaker;
}

/**
 * KOBE-817: the scheduler holds no approval key (the chart gives it only to the server) because it
 * never decides one: it serves health endpoints only and attaches no sandbox wire, and a scheduled
 * run does not wait for approvals. It must not log the missing key as an error.
 */
export const SCHEDULER_APPROVALS = { decides: false } as const;

/** The scheduler's dependencies (KOBE-174): it fires runs through the same orchestrator and wire. */
function schedulerDeps(i: ProcessDepsInput): ServerDeps {
  const { config } = i;
  return createServerDeps({
    databaseUrl: config.databaseUrl,
    dbTimeouts: config.dbTimeouts,
    isolation: i.isolation,
    // KOBE-736: the scheduler serves no event streams, so its stream pool never opens.
    dbPool: { max: config.dbPools.max, applicationName: "kobe-scheduler" },
    listen: { applicationName: "kobe-scheduler-listen" },
    ...schedulerAuthStandIn(),
    // No run-token key: the wire host that delivers run.start mints run tokens, not the scheduler.
    sandboxWire: { waker: i.waker },
    approvals: SCHEDULER_APPROVALS,
    connectors: loadConnectorUrlPolicy(i.env),
    agents: { maxVersions: config.agentMaxVersions },
    modelTokenDefaults: config.modelTokenDefaults,
    uploads: i.settings.uploads,
  });
}

/** Answer ratings as Langfuse scores (KOBE-275): only with a Langfuse tracing endpoint. */
function feedbackScoresOf(telemetry: TelemetryConfig) {
  const sink = createLangfuseScoreSink(telemetry);
  return sink ? { feedbackScores: { sink, captureContent: telemetry.captureContent } } : {};
}

/** The API server's dependencies; needs the auth and SMTP settings. */
function apiServerDeps(
  i: ProcessDepsInput,
  auth: NonNullable<Config["auth"]>,
  smtp: NonNullable<Config["smtp"]>,
): ServerDeps {
  const { config, env, settings: s } = i;
  const { approvalKey, ...authSettings } = auth;
  const { runTokenKey, traceSpanKey, serverCallKey } = s;
  if (!config.modelGatewayUrl || !serverCallKey) {
    i.log.info("model gateway or its signing key not configured: threads are not auto-titled");
  }
  const proxy =
    config.mcpProxyUrl && config.mcpProxyRoutesKey
      ? { baseUrl: config.mcpProxyUrl, internalKey: config.mcpProxyRoutesKey }
      : undefined;
  return createServerDeps({
    databaseUrl: config.databaseUrl,
    dbTimeouts: config.dbTimeouts,
    isolation: i.isolation,
    dbPool: { max: config.dbPools.max, applicationName: "kobe-server" },
    listen: { applicationName: "kobe-server-listen" },
    eventStream: { poolMax: config.dbPools.streamMax },
    retentionPaused: config.retentionPaused,
    usageRetentionMonths: config.retentionSweeps.runUsageMonths,
    brandingDefaults: config.branding ?? {},
    ...authSettings,
    ...(approvalKey ? { approvalKeys: approvalKeyring(approvalKey) } : {}),
    mailer: createSmtpMailer(smtp),
    sandboxWire: {
      waker: i.waker,
      ...(runTokenKey ? { runTokenKey } : {}),
      ...(traceSpanKey ? { traceSpanKey } : {}),
    },
    ...(config.modelGatewayUrl && serverCallKey
      ? { serverCalls: { gatewayUrl: config.modelGatewayUrl, key: serverCallKey } }
      : {}),
    connectors: loadConnectorUrlPolicy(env),
    // Single sign-on (KOBE-626): kill switch, SSRF exceptions, Helm providers and their secrets.
    sso: { settings: loadSsoSettings(env) },
    auditForwardingDestinations: destinationsOf(config.auditForwarding),
    auditForwardingSecrets: forwardingSecrets(config.auditForwarding),
    // The proxy's internal routes, with the routes key (KOBE-693).
    ...(proxy
      ? {
          connectorProbe: createProxyProbe({ ...proxy, timeoutMs: PROBE_TIMEOUT_MS }),
          appCaller: createProxyAppCaller({ ...proxy, timeoutMs: PROBE_TIMEOUT_MS }),
        }
      : {}),
    agents: { maxVersions: config.agentMaxVersions },
    modelTokenDefaults: config.modelTokenDefaults,
    ...(s.egressHeaderSecrets ? { egressHeaderSecrets: s.egressHeaderSecrets } : {}),
    ...(s.envelope ? { envelope: s.envelope } : {}),
    ...feedbackScoresOf(s.telemetry),
    ...(s.s3 && s.objectStore ? { blobs: { objects: s.objectStore, prefix: s.s3.prefix } } : {}),
    uploads: s.uploads,
    // KOBE-409: the in-cluster embedding model (KOBE-659) as the gateway names it.
    ...(s.models?.localEmbedding
      ? { embeddings: { localModel: localEmbeddingGatewayModel(s.models.localEmbedding) } }
      : {}),
    ...(s.models
      ? {
          models: {
            providerKeySecrets: s.models.providerKeySecrets,
            allowUnsafeEndpoints: s.models.allowUnsafeEndpoints,
            ...(s.bifrostAdmin ? { discovery: s.bifrostAdmin } : {}),
          },
        }
      : {}),
  });
}

/** Configuration warnings of the API server, logged once at start. */
function warnApiServerSettings(i: ProcessDepsInput, smtp: NonNullable<Config["smtp"]>): void {
  const { config, settings, log } = i;
  if (smtp.security === "none") {
    log.warn({ smtpHost: smtp.host }, "KOBE_SMTP_SECURITY=none: email is sent unencrypted");
  }
  const publicUrl = config.auth?.publicUrl ?? "";
  const publicHost = publicUrl ? new URL(publicUrl).hostname : "";
  if (
    publicUrl.startsWith("http:") &&
    !/^(localhost|127\.0\.0\.1)$|\.localtest\.me$/.test(publicHost)
  ) {
    log.warn(
      { publicUrl },
      "KOBE_PUBLIC_URL is plain http: session cookies are not Secure and passkeys need https",
    );
  }
  const s3 = settings.s3;
  const s3HttpWarning = s3 ? plainHttpEndpointWarning(s3) : undefined;
  if (s3HttpWarning) log.warn(s3HttpWarning);
  // KOBE-738: a versioned bucket without noncurrent-version expiry keeps deleted data for ever.
  // Advisory and in the background: never delays or stops the start.
  if (s3) {
    void checkBucketLifecycle(s3).then((warning) => {
      if (warning) log.warn({ bucket: s3.bucket }, warning);
    });
  }
}

/**
 * The process's dependencies: the scheduler's, the API server's (with auth and SMTP), or none
 * (an API server without them serves health endpoints only).
 */
export function createProcessDeps(i: ProcessDepsInput): ServerDeps | undefined {
  const { config } = i;
  if (config.process === "scheduler") return schedulerDeps(i);
  if (!config.auth || !config.smtp) return undefined;
  const deps = apiServerDeps(i, config.auth, config.smtp);
  warnApiServerSettings(i, config.smtp);
  return deps;
}

/**
 * KOBE-425: sealed values whose key this server does not hold (a restore with other Secrets) are
 * named at start, with the Secret to put back. Reads key ids only; never stops the start.
 */
export async function checkSealedKeysAtStart(
  deps: ServerDeps,
  settings: ProcessSettings,
  log: Logger,
): Promise<void> {
  const { models, envelope, egressHeaderSecrets } = settings;
  const families = sealedFamilies({
    ...(models
      ? {
          providerKeyIds: new SecretBox(models.providerKeySecrets, PROVIDER_KEY_PURPOSE).keyIds,
          virtualKeyIds: new SecretBox(models.virtualKeySecrets, VIRTUAL_KEY_PURPOSE).keyIds,
        }
      : {}),
    ...(envelope ? { envelopeKeyIds: envelope.keyIds } : {}),
    ...(egressHeaderSecrets ? { egressHeaderKeyIds: headerBox(egressHeaderSecrets).keyIds } : {}),
  });
  await checkSealedKeys(deps.database.db, families, log).catch((err: unknown) =>
    log.error({ err }, "the sealed key check failed"),
  );
}

/** Settings a server replica runs degraded without, logged once at start. */
export function warnMissingServerSettings(settings: ProcessSettings, log: Logger): void {
  if (!settings.egressHeaderSecrets) {
    log.warn("KOBE_EGRESS_HEADER_SECRET is not set: egress header injection is off");
  }
  if (!settings.envelope) {
    log.warn("KOBE_ENVELOPE_KEY is not set: connector credentials cannot be stored");
  }
  if (!settings.models)
    log.warn("KOBE_BIFROST_URL is not set: the model gateway is not configured");
}
