import { repoCommitWiring } from "./git/repo-commit/wiring.js";
import type { GitHostNet } from "./git-hosts/http.js";
import { NO_APP_CALLER, type AppCaller } from "./apps/app-caller.js";
import { createNotebookFiles, type NotebookFiles } from "./notebooks/files.js";
import type { ForwardDestination } from "./audit/forward/types.js";
import { configureTagFingerprintKey } from "./memory/items/tag-fingerprint.js";
import { configureUsageKey } from "./skills/usage-snapshot.js";
import { REFRESH_TIMEOUT_MS } from "./connectors/grant-refresh.js";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  PROVIDER_KEY_PURPOSE,
  SecretBox,
  headerBox,
  type Envelope,
  accounts,
  createDb,
  siteRoles,
  users,
  type KaijuDatabase,
} from "@kaiju/db";
import { ApprovalService, type ApprovalKeyring } from "./approvals/index.js";
import { AuditAnchorLogger } from "./audit/anchor.js";
import { AuthAttemptAudit } from "./audit/attempts.js";
import { recordAudit } from "./audit/record.js";
import { BackgroundTasks } from "./background.js";
import { createAuth, type KaijuAuth } from "./auth/auth.js";
import { createClientIpWatch, type ClientIpWatch } from "./auth/client-ip-watch.js";
import { createSignInThrottle, type SignInThrottle } from "./auth/sign-in-throttle.js";
import { createRunEventHub, type RunEventHub } from "./event-stream/hub.js";
import { notifyWorkspaceAccess } from "./event-stream/access.js";
import { createStreamReader, type StreamReader } from "./event-stream/read.js";
import { STREAM_DEFAULTS, type StreamTimings } from "./event-stream/stream.js";
import { DEFAULT_VERSION_LIMITS } from "./agents/versions.js";
import type { Mailer } from "./mail/mailer.js";
import type { RateLimitRule } from "./rate-limit.js";
import type { ModelDiscovery } from "./models/discovery.js";
import { MODEL_TOKEN_DEFAULTS, type ModelTokenDefaults } from "./models/token-limits.js";
import {
  createDbRunContextSource,
  createSandboxWire,
  type SandboxWire,
} from "./sandbox-wire/index.js";
import {
  DbRunOrchestrator,
  PINNED_AGENTS,
  createRunWorkspace,
  withDraftTests,
  withSkillEvals,
  type RunWorkspaceSlot,
  type ServerRunOrchestrator,
} from "./runs/index.js";
import type { RunAgentResolver } from "./runs/seams.js";
import { createOffboarding, type Offboarding } from "./offboarding/index.js";
import { createWorkspaceRebuild, type WorkspaceRebuild } from "./sandbox-lifecycle/rebuild.js";
import { stopUserSchedules } from "./schedules/offboard.js";
import { endUserShares } from "./threads/share-scope.js";
import { UserLifecycle } from "./users/lifecycle.js";
import { approvalVerifierForMcp } from "./mcp/approvals.js";
import { createDbMcpCatalog } from "./mcp/catalog.js";
import {
  DEFAULT_ALLOWED_PORTS,
  resolveAll,
  type ConnectorUrlPolicy,
} from "./connectors/url-policy.js";
import {
  deleteDeactivatedUserGrants,
  deleteReactivatedUserGrants,
} from "./connectors/grant-departures.js";
import { NO_PROBE, type ConnectorProbe } from "./connectors/probe.js";
import type { AppResultsDeps } from "./apps/results.js";
import { captureKey } from "./apps/capture-ticket.js";
import { createMcpService, DENIED_AUDIT_RATE, type McpService } from "./mcp/service.js";
import { createKaijuMcpService, type KaijuMcpService } from "./kaiju-mcp/service.js";
import { createGitMcpService, type GitMcpService } from "./git-tools/mcp-service.js";
import { createRateLimiter } from "./sandbox/rate-limit.js";
import { createPolicyEngine } from "./policy/engine.js";
import { createToolRegistry } from "./policy/registry.js";
import { createDbRuleSource, createDbSettingsSource } from "./policy/rule-store.js";
import { logger } from "./logger.js";
import { BudgetMonitor } from "./budgets/monitor.js";
import { DB_RUN_BUDGET_GATE } from "./budgets/run-gate.js";
import type { BlobStore } from "./retention/blobs.js";
import { createProjectMounts, type ProjectMounts } from "./projects/mounts.js";
import { endUserProjects } from "./projects/offboard.js";
import { createSkillDraftTool, type SkillDraftTool } from "./skills/drafts/tool.js";
import {
  markMaintainedAgain,
  markUnmaintained,
  notifyUnmaintained,
} from "./skills/registry/maintainers.js";
import { createServerCallClient } from "./models/gateway-client.js";
import { createEmbeddingClient } from "./models/embedding-client.js";
import { MEMORY_VECTOR_BUILD_LOCK, VectorBackfill } from "./memory/embeddings/backfill.js";
import { createPgReconcileLock } from "./sandbox/reconcile-lock.js";
import { MemoryEmbeddings } from "./memory/embeddings/service.js";
import {
  createSkillManifestGenerator,
  type SkillManifestGenerator,
} from "./skills/manifest/index.js";
import { NO_SERVER_CALLS, createServerCalls } from "./server-calls/service.js";
import { createLearningPasses, type LearningPasses } from "./memory/learn/run.js";
import { createSkillEvalJudge, type SkillEvalJudge } from "./skills/evals/judge.js";
import { DEFAULT_UPLOAD_SETTINGS, type UploadSettings } from "./uploads/settings.js";
import { FeedbackScores } from "./feedback/scores.js";
import type { BrandingDefaults } from "./branding/defaults-config.js";
import type { SsoNet } from "./sso/net.js";
import type { ProviderStore } from "./sso/providers.js";
import { SSO_OFF, ssoNet, type SsoSettings } from "./sso/settings.js";
import { createListenClient, type ListenClient } from "./pg-listen.js";
import { registerSaveEmbedder } from "./memory/embeddings/save-hook.js";
import type { ServerDepsOptions } from "./deps-options.js";

export type { ServerDepsOptions } from "./deps-options.js";

/** Limits on publishing agent versions (KOBE-46 review M3). */
export interface AgentLimits {
  /** Versions per agent (config `KOBE_AGENT_MAX_VERSIONS`). */
  readonly maxVersions: number;
  /** Publishes + rollbacks per user, across agents. */
  readonly publishRate: RateLimitRule;
}

export const AGENT_LIMIT_DEFAULTS: AgentLimits = {
  maxVersions: DEFAULT_VERSION_LIMITS.maxVersions,
  publishRate: { windowMs: 10 * 60_000, max: 30 },
};

export interface NewUser {
  readonly email: string;
  readonly name: string;
  readonly password: string;
}

export interface ServerDeps {
  readonly database: KaijuDatabase;
  readonly auth: KaijuAuth;
  readonly publicUrl: string;
  /** The nightly retention pass, offboarding purges and workspace GC are paused (KOBE-243). */
  readonly retentionPaused: boolean;
  /** Months per-call usage is kept (KOBE-741); null: for ever. */
  readonly usageRetentionMonths: number | null;
  /** Chart-seeded branding defaults (KOBE-503); empty when none is configured. */
  readonly brandingDefaults: BrandingDefaults;
  /**
   * The process's one LISTEN connection (KOBE-704): the event hub, the sandbox bus, budgets, skill
   * eval progress, the egress relay and the gateway sync subscribe to their channels on it.
   */
  readonly listen: ListenClient;
  /** Kaiju Event Stream fan-out (on the shared LISTEN connection) and SSE timings (KOBE-31). */
  readonly eventStream: {
    readonly hub: RunEventHub;
    readonly reader: StreamReader;
    readonly timings: StreamTimings;
  };
  readonly mailer: Mailer;
  readonly agentLimits: AgentLimits;
  /** Off-request-path work (emails, attempt audit); drained by close(). */
  readonly background: BackgroundTasks;
  /** Logs and attests the audit chain head (started by startup/server.ts, not in tests). */
  readonly auditAnchor: AuditAnchorLogger;
  /** Destinations audit events are forwarded to (empty: forwarding off). */
  readonly auditForwardingDestinations: readonly ForwardDestination[];
  /** Configured forwarding credentials redacted from errors on read (KOBE-182). */
  readonly auditForwardingSecrets: readonly string[];
  /** Aggregated audit of unauthenticated auth attempts (flushed on close). */
  readonly authAttempts: AuthAttemptAudit;
  /** Per-account throttle of failed password and second-factor attempts (KOBE-812). */
  readonly signInThrottle: SignInThrottle;
  /** Reports requests without a resolvable client IP (KOBE-812). */
  readonly clientIps: ClientIpWatch;
  /** Downstream steps of deactivation/reactivation (sandboxes, grants, schedules, audit). */
  readonly lifecycle: UserLifecycle;
  /**
   * Offboarding (KOBE-28, D12): destroys a departed member's sandbox, retains the volume 30 days,
   * exports it for team admins and deletes it afterwards. The sandbox provider is set later.
   */
  readonly offboarding: Offboarding;
  /**
   * Rebuilding a workspace whose volume was lost with its node (KOBE-739): member-confirmed, from
   * the last sync. The sandbox provider is set later (index.ts), like offboarding's.
   */
  readonly workspaceRebuild: WorkspaceRebuild;
  /**
   * Sandbox connection registry and routing (KOBE-24): `router` sends commands to any (user, team)
   * sandbox from any replica; `attach` serves the WebSocket on the sandbox listener only.
   */
  readonly sandboxWire: SandboxWire;
  /**
   * Run orchestrator (KOBE-30): messages, queue, steer, stop, retry. Reaches sandboxes through
   * `sandboxWire.router`; the wire calls back when it ends a run.
   */
  readonly runs: ServerRunOrchestrator;
  /** The run orchestrator's agent resolver (KOBE-44: the thread API asks it for the agent's model pin). */
  readonly runAgents: RunAgentResolver;
  /**
   * The skill eval judge (KOBE-326): server calls through the model gateway; undefined when server
   * calls are not configured (a `judge` check then fails `judge_failed`).
   */
  readonly skillEvalJudge: SkillEvalJudge | undefined;
  /**
   * Create kobe.skill.yaml with a model (KOBE-564): a run-less server call through the model
   * gateway; undefined when server calls are not configured (the routes answer 503).
   */
  readonly skillManifests: SkillManifestGenerator | undefined;
  /** Learn from this chat (KOBE-393): starts learning passes; refuses without a gateway. */
  readonly learningPasses: LearningPasses;
  /** Memory embeddings (KOBE-409): embed on save, query vectors, the Site console's state. */
  readonly memoryEmbeddings: MemoryEmbeddings;
  /** Build vectors / re-embed, started by a Site admin (KOBE-409). */
  readonly memoryVectors: VectorBackfill;
  /** Model gateway admin (KOBE-40): seals provider API keys; undefined when not configured. */
  readonly models:
    | {
        readonly providerKeys: SecretBox;
        readonly allowUnsafeEndpoints: boolean;
        readonly discovery: ModelDiscovery | undefined;
      }
    | undefined;
  /**
   * The MCP proxy's policy re-check (KOBE-58): exposed tools and a decision per call, served on
   * the internal listener only (`routes/internal.ts`).
   */
  readonly mcp: McpService;
  /**
   * The built-in Kaiju MCP server (KOBE-619): its tools listed and decided-and-executed on the
   * internal listener; `createApp` binds the public API router it dispatches admin tools to.
   */
  readonly kaijuMcp: KaijuMcpService;
  readonly gitMcp: GitMcpService;
  /** The address policy registered connector URLs must pass (KOBE-100). */
  readonly connectorUrlPolicy: ConnectorUrlPolicy;
  /** Outbound requests to Workspace git hosts (KOBE-760): the connector policy, every call. */
  readonly gitHostNet: GitHostNet;
  /** Fetches a connector's live `tools/list` through the MCP proxy, to pin it (KOBE-101). */
  readonly connectorProbe: ConnectorProbe;
  /** Sends MCP Apps' decided calls to the MCP proxy (KOBE-436). */
  readonly appCaller: AppCaller;
  /**
   * Approvals (KOBE-37, D29): the wire's broker, `POST /v1/approvals/{id}`, the TTL sweep, and the
   * signed-approval verifier the MCP proxy (KOBE-58) calls.
   */
  readonly approvals: ApprovalService;
  /** The site's approval key (KOBE-37); To review signs project Notes changes with a derived key (KOBE-398). */
  readonly approvalKeys: ApprovalKeyring | undefined;
  /** Seals team-injected egress header values (KOBE-39); undefined when not configured. */
  readonly egressHeaders: SecretBox | undefined;
  /** Envelope encryption for connector credentials and other per-record secrets (KOBE-107). */
  readonly envelope: Envelope | undefined;
  /**
   * Single sign-on (KOBE-626): `settings.enabled` is the kill switch (`auth.sso.enabled`); `net`
   * is the SSRF-guarded outbound policy; `providers` the provider store.
   */
  readonly sso: {
    readonly settings: SsoSettings;
    readonly net: SsoNet;
    readonly providers: ProviderStore;
  };
  /**
   * Budgets (KOBE-42, D30): watches spend, records and emails warnings, budget-stops runs.
   * `startup/server.ts` starts it (LISTEN + sweep); tests call `evaluate()` / `sweep()` directly.
   */
  readonly budgets: BudgetMonitor;
  /** Object storage for thread blobs (KOBE-18 export and retention); undefined when not set. */
  readonly blobs: BlobStore | undefined;
  /** Upload limits (KOBE-143); undefined: the contract defaults. */
  readonly uploads: UploadSettings | undefined;
  /** MCP Apps results captured by mcp-proxy (KOBE-438): ticket key and storage. */
  readonly appResults: AppResultsDeps;
  /** Output limit and context window of models without their own (KOBE-259). */
  readonly modelTokenDefaults: ModelTokenDefaults;
  /** Keeps members' `projects/` workspace area equal to their projects' files (KOBE-162). */
  readonly projectMounts: ProjectMounts;
  /** `save_skill_draft` (KOBE-442); `startup/server.ts` binds the workspace store later. */
  readonly skillDraftTool: SkillDraftTool;
  /** Notebook cells and outputs in members' workspaces (KOBE-464); bound like `skillDraftTool`. */
  readonly notebookFiles: NotebookFiles;
  /** A run's attachments and viewed file (KOBE-144, KOBE-462); bound like `skillDraftTool`. */
  readonly runWorkspace: RunWorkspaceSlot;
  /** Exports answer ratings as Langfuse scores (KOBE-275); undefined when tracing has no scores. */
  readonly feedbackScores: FeedbackScores | undefined;
  /** Creates an email+password user (and optional site role) atomically, without sign-up. */
  createUserWithPassword(
    input: NewUser,
    options?: { siteRole?: "owner" | "admin"; recordSetup?: boolean },
  ): Promise<{ id: string }>;
  /** Deletes every session of a user; the next request with any of their cookies is rejected. */
  revokeAllSessions(userId: string): Promise<void>;
  /** Constant-time comparison against the site's setup token. */
  isSetupToken(candidate: unknown): boolean;
  close(): Promise<void>;
}

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

export function createServerDeps(options: ServerDepsOptions): ServerDeps {
  // Catalog usage member keys are an HMAC under this secret (KOBE-339, review-341 L1).
  configureUsageKey(options.authSecret);
  // Tag fingerprints in the held Site item audit (KOBE-647, review P2-L3).
  configureTagFingerprintKey(options.authSecret);
  // App-role sessions: timeouts and lost-connection logging (KOBE-732), for both pools below.
  const session = {
    ...options.dbTimeouts,
    onConnectionError: (err: unknown, sqlstate: string | undefined) =>
      logger.warn({ err, sqlstate }, "database connection lost"),
  };
  const database = createDb(options.databaseUrl, {
    ...session,
    ...(options.dbPool?.max === undefined ? {} : { max: options.dbPool.max }),
    applicationName: options.dbPool?.applicationName ?? "kobe-server",
  });
  const authAttempts = new AuthAttemptAudit(database.db);
  authAttempts.start();
  const background = options.background ?? new BackgroundTasks();
  const ssoSettings = options.sso?.settings ?? SSO_OFF;
  const sso: ServerDeps["sso"] = {
    settings: ssoSettings,
    net: ssoNet(ssoSettings, options.sso?.net, options.sso?.request),
    providers: {
      db: database.db,
      publicUrl: options.publicUrl,
      settings: ssoSettings,
      envelope: options.envelope,
    },
  };
  // SSO sign-in applies access mappings, whose side effects need the finished deps (bound below).
  const lateDeps: { deps?: ServerDeps } = {};
  const signInThrottle = createSignInThrottle({ db: database.db });
  const clientIps = createClientIpWatch({ db: database.db, log: logger, background });
  const auth = createAuth({
    attempts: authAttempts,
    background,
    signInThrottle,
    clientIps,
    db: database.db,
    publicUrl: options.publicUrl,
    secret: options.authSecret,
    trustedProxies: options.trustedProxies,
    mailer: options.mailer,
    sso: {
      ...sso,
      afterChange: () => {
        if (!lateDeps.deps) throw new Error("server deps not ready");
        return lateDeps.deps;
      },
    },
  });
  const setupDigest = digest(options.setupToken);
  const { applicationName = "kaiju-server-listen", ...listenTuning } = options.listen ?? {};
  const listen = createListenClient({
    ...listenTuning,
    connectionString: options.databaseUrl,
    applicationName,
  });
  const hub = createRunEventHub({ ...options.eventStream?.hub, listen });
  const reader = createStreamReader({
    connectionString: options.databaseUrl,
    session,
    ...(options.eventStream?.poolMax ? { max: options.eventStream.poolMax } : {}),
  });

  // One policy engine for both enforcement points (D29): the sandbox's policy.check and the MCP
  // proxy's re-check. MCP tools resolve from the pinned connector snapshots (KOBE-58 catalog).
  // Approvals judge remember choices by the same registry (KOBE-289).
  const mcpCatalog = createDbMcpCatalog(database.db);
  const toolRegistry = createToolRegistry(mcpCatalog);
  const approvals = new ApprovalService({
    registry: toolRegistry,
    publicUrl: new URL(options.publicUrl).origin,
    ...(options.sandboxWire?.tuning?.runMaxEvents === undefined
      ? {}
      : { runMaxEvents: options.sandboxWire.tuning.runMaxEvents }),
    ...options.approvals,
    db: database.db,
    ...(options.approvalKeys ? { keys: options.approvalKeys } : {}),
  });
  // The wire is created first (the orchestrator needs its router); its run-ended hook reaches the
  // orchestrator through this late binding.
  const late: { runs?: ServerRunOrchestrator } = {};
  const extraHooks = options.sandboxWire?.hooks;
  const policySources = {
    rules: createDbRuleSource(database.db),
    settings: createDbSettingsSource(database.db),
    registry: toolRegistry,
    connectors: mcpCatalog,
    onError: (err: unknown) => logger.error({ err }, "policy engine error (denied)"),
  };
  const policyEngine = createPolicyEngine(policySources);
  const runContext = options.sandboxWire?.runContext ?? createDbRunContextSource();
  // Workbench test chats (KOBE-323) run their draft alone, whatever resolver runs the rest.
  const runAgents = withSkillEvals(
    withDraftTests(options.runs?.agents ?? PINNED_AGENTS, options.blobs),
  );
  // Titles (KOBE-219) and follow-ups (KOBE-222) after a completed run, off its path.
  const serverCallClient = options.serverCalls
    ? createServerCallClient({
        url: options.serverCalls.gatewayUrl,
        key: options.serverCalls.key,
        ...(options.serverCalls.fetch ? { fetch: options.serverCalls.fetch } : {}),
      })
    : undefined;
  const serverCalls = serverCallClient
    ? createServerCalls({
        db: database.db,
        client: serverCallClient,
        agents: runAgents,
        background,
        log: logger.child({ component: "server-calls" }),
      })
    : NO_SERVER_CALLS;
  // The skill eval judge (KOBE-326): a server call too, purpose eval_judge.
  const skillEvalJudge = serverCallClient
    ? createSkillEvalJudge({
        db: database.db,
        client: serverCallClient,
        log: logger.child({ component: "skill-eval-judge" }),
      })
    : undefined;
  // Create kobe.skill.yaml with the member's chosen model (KOBE-564): a server call too.
  const skillManifests = serverCallClient
    ? createSkillManifestGenerator({
        db: database.db,
        client: serverCallClient,
        log: logger.child({ component: "skill-manifests" }),
      })
    : undefined;
  // Learning passes (KOBE-393): a server call too, purpose memory_learn, on BackgroundTasks.
  const learningPasses = createLearningPasses({
    db: database.db,
    client: serverCallClient,
    background,
    log: logger.child({ component: "memory-learn" }),
  });
  // Memory embeddings (KOBE-409): a server call too, purpose memory_embed, on POST /v1/embeddings.
  const memoryEmbeddings = new MemoryEmbeddings({
    db: database.db,
    client: options.serverCalls
      ? createEmbeddingClient({
          url: options.serverCalls.gatewayUrl,
          key: options.serverCalls.key,
          ...(options.serverCalls.fetch ? { fetch: options.serverCalls.fetch } : {}),
        })
      : undefined,
    background,
    log: logger.child({ component: "memory-embeddings" }),
    localModel: options.embeddings?.localModel,
    listen,
    ...(options.embeddings?.queryDeadlineMs === undefined
      ? {}
      : { queryDeadlineMs: options.embeddings.queryDeadlineMs }),
  });
  // KOBE-779: every item-store write path embeds through this, after its commit.
  registerSaveEmbedder(database.db, (who, scope, ids) =>
    memoryEmbeddings.afterSave(who, scope, ids),
  );
  const memoryVectors = new VectorBackfill({
    db: database.db,
    embeddings: memoryEmbeddings,
    background,
    log: logger.child({ component: "memory-vectors" }),
    lock: createPgReconcileLock(
      database.pool,
      (err) => logger.warn({ err }, "memory vector build lock connection problem"),
      MEMORY_VECTOR_BUILD_LOCK,
    ),
    ...(options.embeddings?.gatewaySyncWaitMs === undefined
      ? {}
      : { gatewaySyncWaitMs: options.embeddings.gatewaySyncWaitMs }),
  });
  // Project files in members' workspaces (KOBE-162); `startup/server.ts` binds the workspace store later.
  const projectMounts = createProjectMounts(database.db, logger);
  const skillDraftTool = createSkillDraftTool(database.db, {
    ...(options.sandboxWire?.tuning?.runMaxEvents === undefined
      ? {}
      : { runMaxEvents: options.sandboxWire.tuning.runMaxEvents }),
  });
  // Notebooks (KOBE-464): `run_python` and the member's runs read cells and save outputs here.
  const notebookFiles = createNotebookFiles(database.db, {
    teamQuotaDefaultBytes: (options.uploads ?? DEFAULT_UPLOAD_SETTINGS).defaultQuotaBytes,
  });
  const sandboxWire = createSandboxWire({
    tools: toolRegistry,
    engine: policyEngine,
    ...options.sandboxWire,
    serverCalls: serverCalls.purposes,
    memoryEmbeddings,
    approvals: options.sandboxWire?.approvals ?? approvals.broker,
    approvalVerifier: options.sandboxWire?.approvalVerifier ?? approvals.verifier,
    background,
    runContext,
    ...(options.blobs ? { blobs: options.blobs } : {}),
    ...(options.uploads ? { uploads: options.uploads } : {}),
    projectMounts,
    skillDrafts: skillDraftTool,
    notebooks: notebookFiles,
    gitSiteHost: new URL(options.publicUrl).hostname,
    // KOBE-767: read on use; the git host net is built further down.
    repoCommit: () =>
      repoCommitWiring({
        database,
        envelope: options.envelope,
        gitHostNet,
        publicUrl: options.publicUrl,
        blobs: options.blobs,
        log: logger,
      }),
    hooks: {
      async onRunEnded(event) {
        if (event.status === "completed") serverCalls.afterRunCompleted(event);
        try {
          await extraHooks?.onRunEnded?.(event);
        } finally {
          await late.runs?.onRunEnded(event);
        }
      },
    },
    db: database.db,
    databaseUrl: options.databaseUrl,
    listen,
  });
  const modelTokenDefaults = options.modelTokenDefaults ?? MODEL_TOKEN_DEFAULTS;
  // Attachments and the viewed file (KOBE-144, KOBE-462); `startup/server.ts` binds the workspace store.
  const runWorkspace = createRunWorkspace();
  const runs: ServerRunOrchestrator = new DbRunOrchestrator({
    ...options.runs,
    isolation: options.isolation,
    notebooks: notebookFiles,
    workspace: runWorkspace,
    modelTokenDefaults,
    agents: runAgents,
    budget: options.runs?.budget ?? DB_RUN_BUDGET_GATE,
    db: database.db,
    router: sandboxWire.router,
    // KOBE-409 review M1: the query embedding starts as the run's start is sent.
    prefetchQuery: (query) => memoryEmbeddings.prefetchQuery(query),
  });
  late.runs = runs;
  approvals.bind({
    router: sandboxWire.router,
    onRunEnded: (event) => runs.onRunEnded(event),
  });
  const connectorUrlPolicy: ConnectorUrlPolicy = {
    allowHttp: false,
    allowedPorts: DEFAULT_ALLOWED_PORTS,
    allowedInternalCidrs: [],
    deniedCidrs: [],
    resolve: resolveAll,
    ...options.connectors,
  };
  const mcp = createMcpService({
    // Refreshes only: a shorter deadline than the connect flow's, so the proxy's grant call
    // outlasts a refresh (KOBE-778, P2-29).
    oauthIo: { policy: connectorUrlPolicy, timeoutMs: REFRESH_TIMEOUT_MS },
    db: database.db,
    policy: policySources,
    runContext,
    // Gate 2: KOBE-37's verifier (finds, verifies and consumes the signed approval).
    approvals: approvalVerifierForMcp(database.db, approvals.verifier),
    ...(options.envelope ? { envelope: options.envelope } : {}),
    ...(options.mcp?.now ? { now: options.mcp.now } : {}),
    captureKey: captureKey(options.authSecret),
  });
  // One git host net for the connection routes, the egress transport and the git tools (KOBE-762).
  const gitHostNet: GitHostNet = {
    policy: connectorUrlPolicy,
    ...(options.gitHostRequest ? { request: options.gitHostRequest } : {}),
    ...(options.gitWireSend ? { wire: options.gitWireSend } : {}),
  };
  const kaijuMcp = createKaijuMcpService({
    db: database.db,
    publicUrl: new URL(options.publicUrl).origin,
    policy: policySources,
    runContext,
    approvals: approvalVerifierForMcp(database.db, approvals.verifier),
    mayAuditDenied: (() => {
      const limiter = createRateLimiter(DENIED_AUDIT_RATE);
      return (sandboxId: string) => limiter.take(sandboxId) === 0;
    })(),
    ...(options.mcp?.now ? { now: options.mcp.now } : {}),
  });
  // KOBE-762: the built-in git connector, on the same decision path as the Kaiju connector.
  const gitMcp = createGitMcpService({
    db: database.db,
    publicUrl: new URL(options.publicUrl).origin,
    envelope: options.envelope,
    net: gitHostNet,
    policy: policySources,
    runContext,
    approvals: approvalVerifierForMcp(database.db, approvals.verifier),
    mayAuditDenied: (() => {
      const limiter = createRateLimiter(DENIED_AUDIT_RATE);
      return (sandboxId: string) => limiter.take(sandboxId) === 0;
    })(),
    ...(options.mcp?.now ? { now: options.mcp.now } : {}),
  });
  const budgets = new BudgetMonitor({
    db: database.db,
    listen,
    runs,
    mailer: options.mailer,
    publicUrl: new URL(options.publicUrl).origin,
    logger: logger.child({ component: "budgets" }),
  });
  const lifecycle = new UserLifecycle();
  // First, while the sandbox still answers: pause the user's schedules, cancel scheduled runs (KOBE-180).
  lifecycle.on("deactivated", {
    name: "schedules",
    run: (userId) => stopUserSchedules(database.db, runs, userId),
  });
  // Their shared threads go private in every team (KOBE-221); reactivation does not share again.
  lifecycle.on("deactivated", {
    name: "thread-shares",
    run: (userId) => endUserShares(database.db, userId),
  });
  // Their checkouts and project rows end and their mounts go (Workspaces MT4, KOBE-578).
  lifecycle.on("deactivated", {
    name: "projects",
    run: (userId) => endUserProjects(database.db, projectMounts, userId),
  });
  // A deactivated user's sandboxes lose their connections on every replica at once (KOBE-13).
  lifecycle.on("deactivated", {
    name: "sandbox-wire",
    run: (userId) => sandboxWire.revalidateUser(userId),
  });
  // Their open file change streams recheck at once (KOBE-496; sessions are gone by now).
  lifecycle.on("deactivated", {
    name: "workspace-changes",
    run: (userId) => notifyWorkspaceAccess(database.db, userId),
  });
  // Their connector keys and OAuth tokens in every team are deleted (KOBE-696); the offboarding
  // sweep finishes the job if this fails.
  lifecycle.on("deactivated", {
    name: "connector-grants",
    run: async (userId) => {
      await deleteDeactivatedUserGrants(database.db, userId);
    },
  });
  // The last active maintainer of a catalog skill leaves: Unmaintained, Site admins emailed (KOBE-332).
  lifecycle.on("deactivated", {
    name: "catalog-maintainers",
    run: async (userId) => {
      const skills = await markUnmaintained(database.db, userId);
      await notifyUnmaintained(
        { db: database.db, mailer: options.mailer, publicUrl: new URL(options.publicUrl).origin },
        skills,
      );
    },
  });
  // Grants a failed "connector-grants" deactivation step left behind never work again (KOBE-696).
  lifecycle.on("reactivated", {
    name: "connector-grants",
    run: async (userId) => {
      await deleteReactivatedUserGrants(database.db, userId);
    },
  });
  lifecycle.on("reactivated", {
    name: "catalog-maintainers",
    run: (userId) => markMaintainedAgain(database.db, userId),
  });
  const offboarding = createOffboarding({
    db: database.db,
    blobs: options.blobs,
    paused: options.retentionPaused ?? false,
    log: logger.child({ component: "offboarding" }),
  });
  const workspaceRebuild = createWorkspaceRebuild({
    db: database.db,
    log: logger.child({ component: "workspace-rebuild" }),
  });
  // Deactivation destroys the user's sandboxes in every team now; volumes stay 30 days (D12).
  lifecycle.on("deactivated", {
    name: "sandbox-offboarding",
    run: (userId) => offboarding.offboardUser(userId, "deactivated"),
  });
  // A reactivated member's 30-day records reopen, so a later departure starts afresh (KOBE-386).
  lifecycle.on("reactivated", {
    name: "sandbox-offboarding-reopen",
    run: (userId) => offboarding.reopen(userId),
  });

  const feedbackScores = options.feedbackScores
    ? new FeedbackScores({ db: database.db, ...options.feedbackScores })
    : undefined;
  const deps: ServerDeps = {
    database,
    models: options.models
      ? {
          providerKeys: new SecretBox(options.models.providerKeySecrets, PROVIDER_KEY_PURPOSE),
          allowUnsafeEndpoints: options.models.allowUnsafeEndpoints ?? false,
          discovery: options.models.discovery,
        }
      : undefined,
    auth,
    publicUrl: new URL(options.publicUrl).origin,
    retentionPaused: options.retentionPaused ?? false,
    usageRetentionMonths: options.usageRetentionMonths ?? null,
    brandingDefaults: options.brandingDefaults ?? {},
    listen,
    eventStream: { hub, reader, timings: { ...STREAM_DEFAULTS, ...options.eventStream?.timings } },
    mailer: options.mailer,
    agentLimits: { ...AGENT_LIMIT_DEFAULTS, ...options.agents },
    background,
    authAttempts,
    signInThrottle,
    clientIps,
    auditAnchor: new AuditAnchorLogger(database.db, options.authSecret),
    auditForwardingDestinations: options.auditForwardingDestinations ?? [],
    auditForwardingSecrets: options.auditForwardingSecrets ?? [],
    lifecycle,
    offboarding,
    workspaceRebuild,
    sandboxWire,
    runs,
    runAgents,
    skillEvalJudge,
    skillManifests,
    learningPasses,
    memoryEmbeddings,
    memoryVectors,
    mcp,
    kaijuMcp,
    gitMcp,
    connectorUrlPolicy,
    gitHostNet,
    connectorProbe: options.connectorProbe ?? NO_PROBE,
    appCaller: options.appCaller ?? NO_APP_CALLER,
    approvals,
    approvalKeys: options.approvalKeys,
    envelope: options.envelope,
    sso,
    egressHeaders: options.egressHeaderSecrets ? headerBox(options.egressHeaderSecrets) : undefined,
    budgets,
    blobs: options.blobs,
    uploads: options.uploads,
    appResults: {
      key: captureKey(options.authSecret),
      store: {
        db: database.db,
        blobs: options.blobs,
        defaultQuotaBytes: (options.uploads ?? DEFAULT_UPLOAD_SETTINGS).defaultQuotaBytes,
      },
    },
    modelTokenDefaults,
    projectMounts,
    skillDraftTool,
    notebookFiles,
    runWorkspace,
    feedbackScores,
    async createUserWithPassword({ email, name, password }, { siteRole, recordSetup } = {}) {
      const ctx = await auth.$context;
      const hash = await ctx.password.hash(password);
      // One transaction: a failure can't leave a half-created user (e.g. an Owner without a role).
      return database.db.transaction(async (tx) => {
        const [user] = await tx
          .insert(users)
          // The setup Owner is the permanent break-glass identity (SSO10): a durable flag.
          .values({
            email: email.toLowerCase(),
            name,
            emailVerified: true,
            setupOwner: recordSetup === true,
          })
          .returning({ id: users.id });
        if (!user) throw new Error("user insert returned no row");
        await tx.insert(accounts).values({
          userId: user.id,
          accountId: user.id,
          providerId: "credential",
          password: hash,
        });
        if (siteRole) await tx.insert(siteRoles).values({ userId: user.id, role: siteRole });
        if (recordSetup) {
          await recordAudit(tx, {
            action: "identity.setup.completed",
            actor: { kind: "user", id: user.id },
            target: { ownerUserId: user.id },
          });
        }
        return { id: user.id };
      });
    },
    async revokeAllSessions(userId) {
      const ctx = await auth.$context;
      await ctx.internalAdapter.deleteUserSessions(userId);
    },
    isSetupToken(candidate) {
      return typeof candidate === "string" && timingSafeEqual(digest(candidate), setupDigest);
    },
    async close() {
      await approvals.stop();
      await budgets.close();
      runs.close();
      await sandboxWire.close();
      await approvals.broker.close();
      // In-flight emails and audit writes finish before the mailer and database go away.
      await background.idle();
      await feedbackScores?.idle();
      await hub.close();
      await listen.close();
      await reader.close();
      options.mailer.close();
      await authAttempts.stop();
      await database.close();
    },
  };
  lateDeps.deps = deps;
  return deps;
}
