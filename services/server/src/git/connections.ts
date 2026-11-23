import { randomUUID } from "node:crypto";
import {
  GIT_DEFAULT_BASE_URL,
  decideGitHost,
  gitCredentialHint,
  openGitCredential,
  readGitConnection,
  readGitConnectionSealedCredential,
  readGitSiteSettings,
  sealGitCredential,
  withTeam,
  type Envelope,
  type GitAccessLevel,
  type GitConnectionRecord,
  type GitCredentialSecret,
  type GitProvider,
  type GitSealedCredentialRow,
  type GitSiteSettings,
  type KobeDb,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import type { ServerDeps } from "../deps.js";
import { GitHostError, type GitHostProbe } from "../git-hosts/adapter.js";
import type { InstallationTokenCache } from "../git-hosts/github/app-auth.js";
import type { GitHostNet } from "../git-hosts/http.js";
import { logger } from "../logger.js";
import { hitRateLimit, type RateLimitRule } from "../rate-limit.js";
import { gitHostTarget } from "../git-hosts/target.js";
import { forgetGitCredential, gitAdapterFor, type GitConnectionSubject } from "./adapters.js";
import {
  appIdsOf,
  credentialSecretOf,
  type GitConnectionCreateBody,
  type GitCredentialInput,
} from "./connection-schemas.js";
import {
  auditHost,
  insertGitConnection,
  precheckCreate,
  removeGitConnection,
  replaceGitCredential,
  storeGitHealth,
} from "./connection-store.js";
import {
  assessProbe,
  healthErrorCode,
  isSiteRefusal,
  shownError,
  safeReason,
  testFailure,
  testReport,
  type GitTestFailure,
  type GitTestReport,
} from "./connection-test.js";
import { adminConnectionView } from "./connection-view.js";

/**
 * The connection routes' work (KOBE-760, spec G2-G8): test, connect, replace the credential,
 * check now and disconnect. Each answers `{ status, body }` for the route to send. The host is
 * called only outside a transaction; the credential is opened for one call and dropped; nothing
 * here logs or audits credential material, and every message is fixed text.
 */
export interface GitConnectionDeps {
  readonly db: KobeDb;
  readonly envelope: Envelope | undefined;
  readonly net: GitHostNet;
  readonly tokenCache?: InstallationTokenCache;
}

/**
 * Read lazily: building the router touches no deps, so an app that serves other routes (thread
 * reads from Postgres alone, `threads.db.test.ts`) never reaches the envelope or the host client.
 */
export function gitConnectionDeps(deps: ServerDeps): GitConnectionDeps {
  return {
    get db() {
      return deps.database.db;
    },
    get envelope() {
      return deps.envelope;
    },
    get net() {
      return deps.gitHostNet;
    },
  };
}

/** Calls that reach an admin-chosen host (test, connect, replace, check), per member. */
export const GIT_HOST_CALL_RATE: RateLimitRule = { windowMs: 10 * 60_000, max: 30 };

export interface Answer {
  readonly status: 200 | 201 | 400 | 403 | 404 | 409 | 422 | 429 | 502 | 503;
  readonly body: Record<string, unknown>;
}

const answer = (status: Answer["status"], body: Record<string, unknown>): Answer => ({
  status,
  body,
});
const refuse = (status: Answer["status"], code: string, message: string) =>
  answer(status, { code, message });

const UNAVAILABLE = refuse(
  503,
  "git_unavailable",
  "Git connections need the site's envelope key (KOBE_ENVELOPE_KEY), which is not configured.",
);
const NOT_FOUND = refuse(404, "connection_not_found", "That git connection does not exist.");
const RATE_LIMITED = refuse(
  429,
  "rate_limited",
  "Too many git host tests in the last few minutes. Try again shortly.",
);
const BAD_KEY = refuse(
  400,
  "invalid_request",
  "Paste the GitHub App's private key as GitHub hands it out (PEM; an encrypted key cannot be used).",
);
const INTERNAL_NOT_OFFERED = refuse(
  422,
  "internal_not_offered",
  "Gitea and Forgejo have no internal repositories: choose private.",
);

const PROVIDER_LABEL: Readonly<Record<GitProvider, string>> = {
  github: "GitHub",
  gitea: "Gitea",
  forgejo: "Forgejo",
};

interface Decided {
  readonly settings: GitSiteSettings;
  readonly baseUrl: string;
}

/** The Site's decision for a new connection's host (G3), before anything is sent. */
async function decide(d: GitConnectionDeps, rawBaseUrl: string): Promise<Decided | Answer> {
  const settings = await readGitSiteSettings(d.db);
  // https only, even with the connector policy's development flag: the table stores https base
  // URLs (its CHECK), and the egress proxy will forward over verified HTTPS (G11).
  const decision = decideGitHost(settings, rawBaseUrl);
  if (decision.ok) return { settings, baseUrl: decision.baseUrl };
  if (decision.code === "git_disabled") return refuse(403, "git_disabled", decision.message);
  if (decision.code === "host_not_allowed")
    return refuse(403, "host_not_allowed", decision.message);
  return refuse(422, "invalid_base_url", decision.message);
}

const isAnswer = (v: unknown): v is Answer =>
  typeof v === "object" && v !== null && "status" in v && "body" in v;

type ProbeOutcome =
  | { readonly ok: true; readonly probe: GitHostProbe }
  | {
      readonly ok: false;
      /** The adapter's own error: for back-off and the server log only. */
      readonly error: GitHostError;
      /** What the Workspace admin is shown, audited and stored (review L2). */
      readonly shown: GitHostError;
      readonly failure: GitTestFailure;
    };

async function probe(
  d: GitConnectionDeps,
  settings: GitSiteSettings,
  subject: GitConnectionSubject,
  secret: GitCredentialSecret,
): Promise<ProbeOutcome> {
  try {
    const adapter = gitAdapterFor(settings, d.net, subject, secret, {
      ...(d.tokenCache ? { tokenCache: d.tokenCache } : {}),
    });
    return { ok: true, probe: await adapter.probe() };
  } catch (error) {
    if (!(error instanceof GitHostError)) throw error;
    const shown = shownError(error, settings.allowedHosts.length === 0);
    if (shown !== error) {
      logger.info(
        { code: error.code, reason: safeReason(error) ?? null, host: auditHost(subject.baseUrl) },
        "git host not reachable or its address refused",
      );
    }
    return { ok: false, error, shown, failure: testFailure(shown) };
  }
}

type Stage = "test" | "create" | "replace" | "check";

/** Audits a failed test (codes only); best effort, never fails the answer. */
async function auditFailure(
  d: GitConnectionDeps,
  teamId: string,
  stage: Stage,
  subject: GitConnectionSubject,
  code: string,
  reason: string | undefined,
  connectionId?: string,
): Promise<void> {
  try {
    await withTeam(d.db, teamId, (tx) =>
      recordAudit(tx, {
        action: "git.connection.test_failed",
        teamId,
        target: {
          ...(connectionId === undefined ? {} : { connectionId }),
          stage,
          provider: subject.provider,
          host: auditHost(subject.baseUrl),
          organization: subject.organization,
          failure: code,
          ...(reason === undefined ? {} : { reason }),
        },
      }),
    );
  } catch (err) {
    logger.error({ err, team_id: teamId, stage }, "git connection test failure not audited");
  }
}

/** Gitea and Forgejo report which product they are (G7): the label follows the host. */
function detectedProvider(chosen: GitProvider, probed: GitProvider): GitProvider {
  return chosen !== "github" && probed !== "github" ? probed : chosen;
}

/** The host's spelling of the organization when it is the one the admin named. */
function hostOrganization(typed: string, probed: GitHostProbe): string {
  const login = probed.organization.login;
  return login.toLowerCase() === typed.toLowerCase() && login.length <= 100 ? login : typed;
}

interface TestInput {
  readonly provider: GitProvider;
  readonly base_url?: string | undefined;
  readonly organization: string;
  readonly credential: GitCredentialInput;
  readonly access_level?: GitAccessLevel | undefined;
}

interface Tested {
  readonly subject: GitConnectionSubject;
  readonly settings: GitSiteSettings;
  readonly secret: GitCredentialSecret;
  readonly probe: GitHostProbe;
  readonly report: GitTestReport;
}

/** Shared by test and connect: decide, rate limit, probe, judge. */
async function testNew(
  d: GitConnectionDeps,
  teamId: string,
  userId: string,
  input: TestInput,
  stage: "test" | "create",
  beforeProbe?: (baseUrl: string) => Promise<Answer | undefined>,
): Promise<Tested | Answer> {
  const decided = await decide(d, input.base_url ?? GIT_DEFAULT_BASE_URL);
  if (isAnswer(decided)) return decided;
  const secret = credentialSecretOf(input.credential);
  if (!secret) return BAD_KEY;
  const early = await beforeProbe?.(decided.baseUrl);
  if (early) return early;
  if (!(await hitRateLimit(d.db, `git-host-calls:${userId}`, GIT_HOST_CALL_RATE))) {
    return RATE_LIMITED;
  }
  const subject: GitConnectionSubject = {
    provider: input.provider,
    baseUrl: decided.baseUrl,
    organization: input.organization,
    ...appIdsOf(input.credential),
  };
  const outcome = await probe(d, decided.settings, subject, secret);
  if (!outcome.ok) {
    await auditFailure(d, teamId, stage, subject, outcome.shown.code, safeReason(outcome.shown));
    return answer(outcome.failure.status, outcome.failure.body);
  }
  const report = testReport(
    outcome.probe,
    assessProbe(outcome.probe, input.access_level ?? "read"),
  );
  return { subject, settings: decided.settings, secret, probe: outcome.probe, report };
}

const insufficient = (report: GitTestReport) =>
  answer(422, {
    code: "credential_insufficient",
    message: report.missing.includes("read")
      ? "The credential cannot read the organization's repositories."
      : "The credential cannot write in the organization; choose Read, or a credential that can write.",
    test: report,
  });

/** POST /test: the test without saving (G4); `report.ok` false when it falls short. */
export async function testGitConnection(
  d: GitConnectionDeps,
  teamId: string,
  userId: string,
  input: TestInput,
): Promise<Answer> {
  const tested = await testNew(d, teamId, userId, input, "test");
  if (isAnswer(tested)) return tested;
  if (!tested.report.ok) {
    await auditFailure(d, teamId, "test", tested.subject, "credential_insufficient", undefined);
  }
  return answer(200, { test: tested.report });
}

const BLOCKS = {
  already_connected: refuse(
    409,
    "already_connected",
    "This Workspace is already connected to that organization on that host.",
  ),
  connection_limit: refuse(
    409,
    "connection_limit",
    "A Workspace can have at most 5 git connections. Disconnect one first.",
  ),
  unknown_agent: refuse(
    422,
    "unknown_agent",
    "An agent in agent_ids is not one of this Workspace's.",
  ),
} as const;

/** POST /: connect after a passing test (G2, G4, G8). */
export async function createGitConnection(
  d: GitConnectionDeps,
  teamId: string,
  userId: string,
  body: GitConnectionCreateBody,
): Promise<Answer> {
  const envelope = d.envelope;
  if (!envelope) return UNAVAILABLE;
  if (body.repo_visibility === "internal" && body.provider !== "github")
    return INTERNAL_NOT_OFFERED;
  const tested = await testNew(d, teamId, userId, body, "create", async (baseUrl) => {
    const block = await precheckCreate(d.db, teamId, baseUrl, body.organization, body.agent_ids);
    return block ? BLOCKS[block] : undefined;
  });
  if (isAnswer(tested)) return tested;
  const { subject, report } = tested;
  if (!report.ok) {
    await auditFailure(d, teamId, "create", subject, "credential_insufficient", undefined);
    return insufficient(report);
  }
  const id = randomUUID();
  const provider = detectedProvider(body.provider, tested.probe.provider);
  const organization = hostOrganization(body.organization, tested.probe);
  const inserted = await insertGitConnection(d.db, {
    teamId,
    id,
    userId,
    provider,
    baseUrl: subject.baseUrl,
    organization,
    displayName: body.display_name ?? `${organization} on ${PROVIDER_LABEL[provider]}`,
    credentialKind: tested.secret.kind,
    sealed: sealGitCredential(envelope, { teamId, connectionId: id }, tested.secret),
    credentialHint: gitCredentialHint(tested.secret),
    githubAppId: subject.githubAppId,
    githubInstallationId: subject.githubInstallationId,
    settings: {
      accessLevel: body.access_level,
      repoVisibility: body.repo_visibility,
      repoNamePrefix: body.repo_name_prefix,
      defaultBranch: body.default_branch,
      pushLimitBytes: body.push_limit_bytes,
      directCommits: body.direct_commits,
      agentIds: body.agent_ids,
    },
    probe: {
      capabilities: tested.probe.capabilities,
      excessPermissions: tested.probe.excess,
      credentialExpiresAt: tested.probe.credentialExpiresAt,
    },
  });
  if (!inserted.ok) return BLOCKS[inserted.code];
  return answer(201, { connection: adminConnectionView(inserted.connection), test: report });
}

/** Opens a stored credential once; undefined when it does not open (wrong key, bad shape). */
function openStored(
  envelope: Envelope,
  teamId: string,
  connectionId: string,
  sealed: GitSealedCredentialRow,
): GitCredentialSecret | undefined {
  try {
    return openGitCredential(
      envelope,
      { teamId, connectionId },
      sealed.credentialSealed,
      sealed.credentialKind,
    );
  } catch {
    return undefined;
  }
}

/** Drops a credential's cached installation tokens after it was removed or replaced. */
function forgetStored(
  d: GitConnectionDeps,
  envelope: Envelope,
  connection: GitConnectionRecord,
  sealed: GitSealedCredentialRow,
  appIds: Pick<GitConnectionSubject, "githubAppId" | "githubInstallationId">,
): void {
  const secret = openStored(envelope, connection.teamId, connection.id, sealed);
  if (!secret) return;
  forgetGitCredential({ ...subjectOf(connection), ...appIds }, secret, d.tokenCache);
}

export function subjectOf(c: GitConnectionRecord): GitConnectionSubject {
  return {
    provider: c.provider,
    baseUrl: c.baseUrl,
    organization: c.organization,
    githubAppId: c.githubAppId,
    githubInstallationId: c.githubInstallationId,
  };
}

const readOne = (d: GitConnectionDeps, teamId: string, id: string) =>
  withTeam(d.db, teamId, (tx) => readGitConnection(tx, teamId, id));

/** PUT /{id}/credential: replace after a passing test (G8); the old credential is discarded. */
export async function replaceGitConnectionCredential(
  d: GitConnectionDeps,
  teamId: string,
  userId: string,
  connectionId: string,
  input: GitCredentialInput,
): Promise<Answer> {
  const envelope = d.envelope;
  if (!envelope) return UNAVAILABLE;
  const current = await readOne(d, teamId, connectionId);
  if (!current) return NOT_FOUND;
  if (current.provider !== "github" && input.kind !== "access_token") {
    return refuse(400, "invalid_request", "Gitea and Forgejo connect with an access token.");
  }
  const secret = credentialSecretOf(input);
  if (!secret) return BAD_KEY;
  if (!(await hitRateLimit(d.db, `git-host-calls:${userId}`, GIT_HOST_CALL_RATE))) {
    return RATE_LIMITED;
  }
  const settings = await readGitSiteSettings(d.db);
  const subject = { ...subjectOf(current), ...appIdsOf(input) };
  const outcome = await probe(d, settings, subject, secret);
  if (!outcome.ok) {
    await auditFailure(
      d,
      teamId,
      "replace",
      subject,
      outcome.shown.code,
      safeReason(outcome.shown),
      connectionId,
    );
    return answer(outcome.failure.status, outcome.failure.body);
  }
  const report = testReport(outcome.probe, assessProbe(outcome.probe, current.accessLevel));
  if (!report.ok) {
    await auditFailure(
      d,
      teamId,
      "replace",
      subject,
      "credential_insufficient",
      undefined,
      connectionId,
    );
    return insufficient(report);
  }
  const replaced = await replaceGitCredential(d.db, {
    teamId,
    connectionId,
    userId,
    credentialKind: secret.kind,
    sealed: sealGitCredential(envelope, { teamId, connectionId }, secret),
    credentialHint: gitCredentialHint(secret),
    githubAppId: subject.githubAppId,
    githubInstallationId: subject.githubInstallationId,
    probe: {
      capabilities: outcome.probe.capabilities,
      excessPermissions: outcome.probe.excess,
      credentialExpiresAt: outcome.probe.credentialExpiresAt,
    },
  });
  if (!replaced.ok) return NOT_FOUND;
  forgetStored(d, envelope, current, replaced.previous, current);
  return answer(200, { connection: adminConnectionView(replaced.connection), test: report });
}

/** DELETE /{id}: disconnect (G8, G20); nothing on the host is touched. */
export async function removeGitConnectionNow(
  d: GitConnectionDeps,
  teamId: string,
  connectionId: string,
): Promise<Answer> {
  const removed = await removeGitConnection(d.db, teamId, connectionId);
  if (!removed.ok) return NOT_FOUND;
  if (d.envelope)
    forgetStored(d, d.envelope, removed.connection, removed.previous, removed.connection);
  return answer(200, { id: connectionId, repositories_kept: removed.repositories });
}

export type CheckOutcome =
  | {
      readonly kind: "checked";
      readonly connection: GitConnectionRecord;
      readonly report: GitTestReport;
    }
  | {
      readonly kind: "failed";
      readonly connection: GitConnectionRecord;
      readonly error: GitHostError | undefined;
      readonly code: string;
      readonly failure: GitTestFailure | undefined;
    }
  | { readonly kind: "refused"; readonly failure: GitTestFailure }
  | { readonly kind: "gone" };

/**
 * One health check (§7, G6): open the credential, probe, store the outcome. Shared by Check now
 * and the periodic job. A Site refusal (G3) is not stored as a health failure.
 */
export async function checkGitConnection(
  d: GitConnectionDeps & { readonly envelope: Envelope },
  settings: GitSiteSettings,
  connection: GitConnectionRecord,
): Promise<CheckOutcome> {
  const { teamId, id } = connection;
  // The Site's decision first, with nothing sent and no credential opened (G3, review L3): a
  // refusal is stored, so the console and members see why the connection does nothing.
  try {
    gitHostTarget(settings, connection.baseUrl);
  } catch (error) {
    if (!(error instanceof GitHostError) || !isSiteRefusal(error)) throw error;
    await storeGitHealth(d.db, teamId, id, connection.credentialUpdatedAt, {
      ok: false,
      error: healthErrorCode(error),
    });
    return { kind: "refused", failure: testFailure(error) };
  }
  const sealed = await withTeam(d.db, teamId, (tx) =>
    readGitConnectionSealedCredential(tx, teamId, id),
  );
  if (!sealed) return { kind: "gone" };
  const secret = openStored(d.envelope, teamId, id, sealed);
  if (!secret) {
    const stored = await storeGitHealth(d.db, teamId, id, connection.credentialUpdatedAt, {
      ok: false,
      error: "credential_unreadable",
    });
    return stored
      ? {
          kind: "failed",
          connection: stored,
          error: undefined,
          code: "credential_unreadable",
          failure: undefined,
        }
      : { kind: "gone" };
  }
  const outcome = await probe(d, settings, subjectOf(connection), secret);
  if (!outcome.ok && isSiteRefusal(outcome.shown)) {
    await storeGitHealth(d.db, teamId, id, connection.credentialUpdatedAt, {
      ok: false,
      error: healthErrorCode(outcome.shown),
    });
    return { kind: "refused", failure: outcome.failure };
  }
  const stored = await storeGitHealth(
    d.db,
    teamId,
    id,
    connection.credentialUpdatedAt,
    outcome.ok
      ? {
          ok: true,
          probe: {
            capabilities: outcome.probe.capabilities,
            excessPermissions: outcome.probe.excess,
            credentialExpiresAt: outcome.probe.credentialExpiresAt,
          },
        }
      : { ok: false, error: healthErrorCode(outcome.shown) },
  );
  if (!stored) return { kind: "gone" };
  if (outcome.ok) {
    return {
      kind: "checked",
      connection: stored,
      report: testReport(outcome.probe, assessProbe(outcome.probe, stored.accessLevel)),
    };
  }
  return {
    kind: "failed",
    connection: stored,
    /** The adapter's own error and code: the health job backs off on these. */
    error: outcome.error,
    code: outcome.error.code,
    failure: outcome.failure,
  };
}

/** POST /{id}/check: Check now. 200 with the stored health either way, unless the Site refuses. */
export async function checkGitConnectionNow(
  d: GitConnectionDeps,
  teamId: string,
  userId: string,
  connectionId: string,
): Promise<Answer> {
  const envelope = d.envelope;
  if (!envelope) return UNAVAILABLE;
  const current = await readOne(d, teamId, connectionId);
  if (!current) return NOT_FOUND;
  if (!(await hitRateLimit(d.db, `git-host-calls:${userId}`, GIT_HOST_CALL_RATE))) {
    return RATE_LIMITED;
  }
  const settings = await readGitSiteSettings(d.db);
  const out = await checkGitConnection({ ...d, envelope }, settings, current);
  if (out.kind === "gone") return NOT_FOUND;
  if (out.kind === "refused") return answer(out.failure.status, out.failure.body);
  if (out.kind === "checked") {
    return answer(200, {
      connection: adminConnectionView(out.connection),
      test: out.report,
      error: null,
    });
  }
  await auditFailure(
    d,
    teamId,
    "check",
    subjectOf(current),
    out.failure?.body.test.code ?? out.code,
    out.failure?.body.test.reason,
    connectionId,
  );
  return answer(200, {
    connection: adminConnectionView(out.connection),
    test: null,
    error: out.failure?.body ?? {
      code: out.code,
      message: "The stored credential cannot be opened with the site's envelope key.",
    },
  });
}
