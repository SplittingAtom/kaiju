import { createHash } from "node:crypto";
import { canonicalJson } from "@kobe/protocol";
import {
  gitRepositories,
  openGitCredential,
  readGitConnectionSealedCredential,
  sql,
  withTeam,
  type Envelope,
  type GitConnectionRecord,
  type GitCredentialSecret,
  type GitSiteSettings,
  type KobeDb,
} from "@kobe/db";
import { gitAdapterFor } from "../git/adapters.js";
import { repoProjectRoles, repoRefusal } from "../git/transport.js";
import { GitHostError, type GitHostAdapter } from "../git-hosts/adapter.js";
import type { InstallationTokenCache } from "../git-hosts/github/app-auth.js";
import type { GitHostNet } from "../git-hosts/http.js";
import { withAdvisoryLockRetry } from "../kobe-mcp/limits.js";
import { logger } from "../logger.js";
import { hitRateLimit } from "../rate-limit.js";
import {
  decideGitAccess,
  loadGitToolFacts,
  usableConnections,
  type GitToolFacts,
  type GitToolPrincipal,
} from "./access.js";
import type { GitToolDef, GitToolInput } from "./catalog.js";
import { hostError, toolError, type GitToolError } from "./errors.js";
import {
  auditAttempt,
  auditFailed,
  auditWrite,
  findPrior,
  gitWriteAction,
  type GitWriteRecord,
} from "./ledger.js";
import { footerLine, memberName, postedBody } from "./posted.js";
import { connectionView, readResult, writeResult } from "./results.js";

/**
 * Runs one git host tool call after the server decided it `allow` for exactly this run, tool call
 * and input (spec workspace-git G9-G13, §9; KOBE-762). Everything the decision rests on is read
 * again here, just before the host is called (an approval may have waited an hour): the
 * connection, its level and agents, the member's role, the Site's host decision, and for a write
 * to a Kobe Repo the member's project role. The credential is opened for this call only and never
 * leaves the server; the adapter keeps every request on the connected organization.
 *
 * Writes run under the member's git write lock: the idempotency check (a repeat of the same call in
 * the same run returns the first result instead of acting twice), the host call and the audit row.
 */

/** Per-member limits (durable `kobe_rate_limits`, every replica): reads per 10 min, writes per hour. */
export const GIT_TOOL_READS_PER_10_MIN = 300;
export const GIT_TOOL_WRITES_PER_HOUR = 30;
const READ_RULE = { windowMs: 10 * 60_000, max: GIT_TOOL_READS_PER_10_MIN } as const;
const WRITE_RULE = { windowMs: 60 * 60_000, max: GIT_TOOL_WRITES_PER_HOUR } as const;
/**
 * Per-connection budgets (M2, review g103; the coordinator's numbers): the host's API quota is
 * shared by the whole Workspace (and by git transport and health checks), so all members' tool
 * calls on one connection stay well under GitHub's 5,000 requests an hour for a token.
 */
export const GIT_CONNECTION_READS_PER_HOUR = 3_000;
export const GIT_CONNECTION_WRITES_PER_HOUR = 300;
const CONNECTION_READ_RULE = { windowMs: 60 * 60_000, max: GIT_CONNECTION_READS_PER_HOUR } as const;
const CONNECTION_WRITE_RULE = {
  windowMs: 60 * 60_000,
  max: GIT_CONNECTION_WRITES_PER_HOUR,
} as const;

/** When the window of a refused limit `key` ends (falls back to a whole window from now). */
async function windowEnd(db: KobeDb, key: string, windowMs: number): Promise<Date> {
  const res = await db.execute<{ window_start: string | number }>(
    sql`SELECT window_start FROM kobe_rate_limits WHERE key = ${`kobe:${key}`}`,
  );
  const start = Number(res.rows[0]?.window_start ?? Number.NaN);
  return new Date(Number.isFinite(start) ? start + windowMs : Date.now() + windowMs);
}

export interface GitToolsDeps {
  readonly db: KobeDb;
  /** Opens sealed credentials; unset (no envelope key): every host call is refused. */
  readonly envelope: Envelope | undefined;
  readonly net: GitHostNet;
  /** The deployment's public origin: the conversation link in posted footers (G13). */
  readonly publicUrl: string;
  readonly tokenCache?: InstallationTokenCache;
  /** Tests: a fake adapter. */
  readonly adapterFor?: (
    settings: GitSiteSettings,
    connection: GitConnectionRecord,
    secret: GitCredentialSecret,
  ) => GitHostAdapter;
}

export interface GitCallContext {
  readonly principal: GitToolPrincipal;
  readonly runId: string;
  readonly threadId: string;
  readonly toolCallId: string;
  /** The named run's agent (audit only; access was decided across every run of the sandbox). */
  readonly agentId: string | null;
}

export type GitExecution = { readonly ok: true; readonly text: string } | GitToolError;

/** The idempotency key of a write: the same tool and canonical input in the same run (and team). */
export function gitIdempotencyKey(
  teamId: string,
  runId: string,
  tool: string,
  input: unknown,
): string {
  return createHash("sha256")
    .update(`kobe.git-tools|${teamId}|${runId}|${tool}|${canonicalJson(input ?? {})}`)
    .digest("hex")
    .slice(0, 32);
}

export async function runGitTool(
  deps: GitToolsDeps,
  ctx: GitCallContext,
  tool: GitToolDef,
  rawInput: unknown,
): Promise<GitExecution> {
  try {
    const parsed = tool.input.safeParse(rawInput ?? {});
    if (!parsed.success)
      return toolError("invalid_input", `The input of ${tool.name} is not valid.`);
    const input = parsed.data as GitToolInput;
    const { principal } = ctx;
    const rule = tool.access === "write" ? WRITE_RULE : READ_RULE;
    const key = `git-tools:${tool.access}:${principal.teamId}:${principal.userId}`;
    if (!(await hitRateLimit(deps.db, key, rule))) {
      return toolError(
        "git_rate_limited",
        tool.access === "write"
          ? `Too many git changes in the last hour (at most ${GIT_TOOL_WRITES_PER_HOUR} per member).`
          : `Too many git reads in the last 10 minutes (at most ${GIT_TOOL_READS_PER_10_MIN} per member).`,
        await windowEnd(deps.db, key, rule.windowMs),
      );
    }
    const facts = await loadGitToolFacts(deps.db, principal);
    if (tool.name === "git_list_connections") return listConnections(facts);
    const decided = decideGitAccess(tool, input.connection, facts);
    if (!decided.ok) return toolError(decided.code, decided.message);
    const budget = tool.access === "write" ? CONNECTION_WRITE_RULE : CONNECTION_READ_RULE;
    const budgetKey = `git-tools:connection:${tool.access}:${decided.connection.id}`;
    if (!(await hitRateLimit(deps.db, budgetKey, budget))) {
      return toolError(
        "git_connection_budget",
        `The Workspace's agents used this connection's hourly budget for git ${tool.access === "write" ? "changes" : "reads"} (${budget.max} an hour, shared by every member).`,
        await windowEnd(deps.db, budgetKey, budget.windowMs),
      );
    }
    const adapter = await openAdapter(deps, principal, facts.settings, decided.connection);
    if (!adapter.ok) return adapter;
    if (tool.access === "read") {
      return await readTool(tool, input, decided.connection, adapter.adapter);
    }
    const locked = await withAdvisoryLockRetry(
      deps.db,
      `git_tools.write:${principal.teamId}:${principal.userId}`,
      () => writeTool(deps, ctx, tool, rawInput, input, facts, decided.connection, adapter.adapter),
    );
    return locked.ok
      ? locked.value
      : toolError("busy", "Kobe is busy with your other git changes; try again shortly.");
  } catch (err) {
    logger.error({ err, tool: tool.name, runId: ctx.runId }, "git-tools: tool failed");
    return toolError("failed", "Kobe could not run this git tool. Try again.");
  }
}

function listConnections(facts: GitToolFacts): GitExecution {
  const readable = usableConnections(facts, "read");
  const writable = new Set(usableConnections(facts, "write").map((c) => c.id));
  return {
    ok: true,
    text: JSON.stringify({
      connections: readable.map((c) => ({ ...connectionView(c), can_write: writable.has(c.id) })),
    }),
  };
}

async function openAdapter(
  deps: GitToolsDeps,
  principal: GitToolPrincipal,
  settings: GitSiteSettings,
  connection: GitConnectionRecord,
): Promise<{ readonly ok: true; readonly adapter: GitHostAdapter } | GitToolError> {
  if (!deps.envelope) {
    return toolError("credential_unavailable", "Git credentials cannot be opened on this server.");
  }
  const sealed = await withTeam(deps.db, principal.teamId, (tx) =>
    readGitConnectionSealedCredential(tx, principal.teamId, connection.id),
  );
  if (!sealed) return toolError("connection_not_found", "That git connection was removed.");
  let secret: GitCredentialSecret;
  try {
    secret = openGitCredential(
      deps.envelope,
      { teamId: principal.teamId, connectionId: connection.id },
      sealed.credentialSealed,
      sealed.credentialKind,
    );
  } catch {
    return toolError(
      "credential_unavailable",
      "The Workspace's git credential could not be opened; a Workspace admin should replace it.",
    );
  }
  try {
    const adapter = deps.adapterFor
      ? deps.adapterFor(settings, connection, secret)
      : gitAdapterFor(settings, deps.net, connection, secret, {
          ...(deps.tokenCache ? { tokenCache: deps.tokenCache } : {}),
        });
    return { ok: true, adapter };
  } catch (err) {
    return hostError(err);
  }
}

async function readTool(
  tool: GitToolDef,
  input: GitToolInput,
  connection: GitConnectionRecord,
  adapter: GitHostAdapter,
): Promise<GitExecution> {
  const repo = input.repository ?? "";
  const page = {
    cursor: input.cursor ?? null,
    ...(input.per_page ? { perPage: input.per_page } : {}),
  };
  try {
    switch (tool.name) {
      case "git_list_repositories":
        return readResult(connection, {
          kind: "repositories",
          page: await adapter.listRepositories(page),
        });
      case "git_get_repository":
        return readResult(connection, {
          kind: "repository",
          repository: await adapter.getRepository({ name: repo }),
        });
      case "git_list_branches":
        return readResult(connection, {
          kind: "branches",
          repository: repo,
          page: await adapter.listBranches(repo, page),
        });
      case "git_read_file":
        return readResult(connection, {
          kind: "file",
          repository: repo,
          ref: input.ref ?? null,
          file: await adapter.readFile(repo, input.path ?? "", input.ref),
        });
      case "git_list_pull_requests":
        return readResult(connection, {
          kind: "pull_requests",
          repository: repo,
          page: await adapter.listPullRequests(repo, { ...page, state: input.state ?? "open" }),
        });
      case "git_get_pull_request":
        return readResult(connection, {
          kind: "pull_request",
          repository: repo,
          pullRequest: await adapter.getPullRequest(repo, input.number ?? 0),
        });
      case "git_list_issues":
        return readResult(connection, {
          kind: "issues",
          repository: repo,
          page: await adapter.listIssues(repo, { ...page, state: input.state ?? "open" }),
        });
      case "git_get_issue":
        return readResult(connection, {
          kind: "issue",
          repository: repo,
          issue: await adapter.getIssue(repo, input.number ?? 0),
        });
      default:
        return toolError("unknown_tool", "Unknown git tool.");
    }
  } catch (err) {
    return hostError(err);
  }
}

/** The repository a write acts on, checked for G12's Repo rule (editor or owner of its project). */
async function repoAllowed(
  deps: GitToolsDeps,
  principal: GitToolPrincipal,
  facts: GitToolFacts,
  connection: GitConnectionRecord,
  adapter: GitHostAdapter,
  repository: string,
): Promise<{ readonly ok: true; readonly hostId: string } | GitToolError> {
  const resolved = await adapter.getRepository({ name: repository });
  const repos = await repoProjectRoles(
    deps.db,
    principal,
    connection.baseUrl,
    resolved.id,
    `${connection.organization}/${resolved.name}`,
  );
  const refused = facts.role === null ? undefined : repoRefusal(facts.role, repos);
  if (refused && refused.decision === "deny") return toolError(refused.code, refused.message);
  return { ok: true, hostId: resolved.id };
}

async function writeTool(
  deps: GitToolsDeps,
  ctx: GitCallContext,
  tool: GitToolDef,
  rawInput: unknown,
  input: GitToolInput,
  facts: GitToolFacts,
  connection: GitConnectionRecord,
  adapter: GitHostAdapter,
): Promise<GitExecution> {
  const { principal } = ctx;
  const action = gitWriteAction(tool.name);
  if (action === undefined) return toolError("unknown_tool", "Unknown git tool.");
  const idempotencyKey = gitIdempotencyKey(principal.teamId, ctx.runId, tool.name, rawInput);
  const prior = await findPrior(deps.db, principal, action, idempotencyKey);
  if (prior?.state === "done") return writeResult(connection, prior.record, true);
  const repository = (tool.name === "git_create_repository" ? input.name : input.repository) ?? "";
  if (prior?.state === "unknown") {
    return toolError(
      "outcome_unknown",
      `An earlier attempt of exactly this ${tool.name} call in this run was sent to the git host, but Kobe has no record of how it ended, so it was not sent again. Check ${connection.organization}/${repository} on the host (its newest branches, pull requests, issues or comments) and tell the user what you find; if it is not there, ask again with a changed input.`,
    );
  }
  let attempted = false;
  // M1: the attempt is committed before the host is asked to act; a failure here stops the call.
  const attempt = async () => {
    await auditAttempt(deps.db, ctx, connection, tool.name, repository, idempotencyKey);
    attempted = true;
  };
  try {
    const record = await act(deps, ctx, tool, input, facts, connection, adapter, attempt);
    if ("ok" in record) return record;
    const full: GitWriteRecord = { ...record, idempotencyKey };
    await auditWrite(deps.db, ctx, connection, action, full).catch((err: unknown) => {
      // The host acted and the attempt row stands: a repeat answers outcome_unknown, never acts.
      logger.error({ err, action, runId: ctx.runId }, "git-tools: write could not be audited");
    });
    return writeResult(connection, full, false);
  } catch (err) {
    // Refused for certain (nothing created): recorded, so a repeat may try again. A timeout or a
    // 5xx leaves the attempt open: the host may have acted.
    if (attempted && err instanceof GitHostError && !AMBIGUOUS.has(err.code)) {
      await auditFailed(
        deps.db,
        ctx,
        connection,
        tool.name,
        repository,
        idempotencyKey,
        err.code,
      ).catch((e: unknown) =>
        logger.error({ err: e, runId: ctx.runId }, "git-tools: failure not audited"),
      );
    }
    return hostError(err);
  }
}

/** Host errors after which the host may still have acted. */
const AMBIGUOUS: ReadonlySet<string> = new Set(["host_unreachable", "unexpected"]);

type Acted = Omit<GitWriteRecord, "idempotencyKey">;

async function act(
  deps: GitToolsDeps,
  ctx: GitCallContext,
  tool: GitToolDef,
  input: GitToolInput,
  facts: GitToolFacts,
  connection: GitConnectionRecord,
  adapter: GitHostAdapter,
  attempt: () => Promise<void>,
): Promise<Acted | GitToolError> {
  const { principal } = ctx;
  if (tool.name === "git_create_repository")
    return createRepository(deps, ctx, input, connection, adapter, attempt);
  const repository = input.repository ?? "";
  const allowed = await repoAllowed(deps, principal, facts, connection, adapter, repository);
  if (!allowed.ok) return allowed;
  const base = { repository, hostRepoId: allowed.hostId };
  switch (tool.name) {
    case "git_create_branch": {
      await attempt();
      await adapter.createBranch({ repository, name: input.name ?? "", from: input.from ?? "" });
      return { ...base, kind: "branch" };
    }
    case "git_open_pull_request": {
      const body = await posted(deps, ctx, "opened", input.body ?? "");
      await attempt();
      const pr = await adapter.openPullRequest({
        repository,
        title: input.title ?? "",
        body,
        head: input.head ?? "",
        base: input.base ?? "",
        ...(input.draft === undefined ? {} : { draft: input.draft }),
      });
      return { ...base, kind: "pull_request", hostId: pr.id, number: pr.number, url: pr.webUrl };
    }
    case "git_comment": {
      const body = await posted(deps, ctx, "posted", input.body ?? "");
      await attempt();
      const c = await adapter.comment({
        repository,
        number: input.number ?? 0,
        on: input.on ?? "issue",
        body,
      });
      return {
        ...base,
        kind: "comment",
        on: input.on ?? "issue",
        hostId: c.id,
        number: input.number ?? null,
        url: c.webUrl,
      };
    }
    case "git_create_issue": {
      const body = await posted(deps, ctx, "opened", input.body ?? "");
      await attempt();
      const issue = await adapter.createIssue({ repository, title: input.title ?? "", body });
      return { ...base, kind: "issue", hostId: issue.id, number: issue.number, url: issue.webUrl };
    }
    default:
      return toolError("unknown_tool", "Unknown git tool.");
  }
}

async function posted(
  deps: GitToolsDeps,
  ctx: GitCallContext,
  kind: "opened" | "posted",
  body: string,
): Promise<string> {
  const name = await withTeam(deps.db, ctx.principal.teamId, (tx) =>
    memberName(tx, ctx.principal.userId),
  );
  return postedBody(body, footerLine(kind, name, deps.publicUrl, ctx.threadId));
}

async function createRepository(
  deps: GitToolsDeps,
  ctx: GitCallContext,
  input: GitToolInput,
  connection: GitConnectionRecord,
  adapter: GitHostAdapter,
  attempt: () => Promise<void>,
): Promise<Acted | GitToolError> {
  const name = input.name ?? "";
  const prefix = connection.repoNamePrefix;
  if (prefix !== "" && !name.startsWith(prefix)) {
    return toolError(
      "name_prefix",
      `Repositories created through "${connection.displayName}" start with "${prefix}": ask again with a name that does.`,
    );
  }
  const visibility = input.visibility ?? "private";
  if (visibility === "internal" && connection.repoVisibility !== "internal") {
    return toolError(
      "visibility_not_allowed",
      "The Workspace admin allows private repositories only on this connection.",
    );
  }
  await attempt();
  const repo = await adapter.createRepository({
    name,
    visibility,
    ...(input.description === undefined ? {} : { description: input.description }),
  });
  if (repo.visibility === "public") {
    logger.warn(
      { connectionId: connection.id, runId: ctx.runId },
      "git-tools: the host created a public repository",
    );
  }
  // The Workspace's record of a repository its agents created (§7 Repositories, G20).
  await withTeam(deps.db, ctx.principal.teamId, (tx) =>
    tx
      .insert(gitRepositories)
      .values({
        teamId: ctx.principal.teamId,
        connectionId: connection.id,
        baseUrl: connection.baseUrl,
        hostRepoId: repo.id,
        fullName: repo.fullName.slice(0, 201),
        defaultBranch: repo.defaultBranch ?? connection.defaultBranch,
        origin: "tool",
        hostState: "active",
        isPrivate: repo.visibility !== "public",
        createdBy: ctx.principal.userId,
      })
      .onConflictDoNothing(),
  ).catch((err: unknown) => {
    logger.error({ err, runId: ctx.runId }, "git-tools: repository record not written");
  });
  return {
    kind: "repository",
    repository: repo.name,
    hostRepoId: repo.id,
    hostId: repo.id,
    number: null,
    url: repo.webUrl,
    // L7: the host's real visibility, public included (no tool can create one, but say so).
    visibility: repo.visibility,
    cloneUrl: repo.cloneUrl,
  };
}
