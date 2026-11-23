import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SYSTEM_ACTOR,
  openGitCredential,
  readGitConnection,
  readGitConnectionSealedCredential,
  readGitSiteSettings,
  sql,
  withTeam,
  type Envelope,
  type GitConnectionRecord,
  type KobeDb,
} from "@kobe/db";
import type { HttpClient } from "isomorphic-git";
import type { Logger } from "pino";
import { recordAudit } from "../../audit/record.js";
import { GitHostError, type GitHostAdapter, type GitRepository } from "../../git-hosts/adapter.js";
import { gitHostAdapter, type GitAdapterInput } from "../../git-hosts/factory.js";
import { gitWireClient } from "../../git-hosts/git-wire.js";
import type { GitHostNet } from "../../git-hosts/http.js";
import { gitHostTarget, type GitHostTarget } from "../../git-hosts/target.js";
import type { Mailer } from "../../mail/mailer.js";
import type { BlobStore } from "../../retention/blobs.js";
import {
  GIT_CONVERSION_BATCH_BYTES,
  GIT_CONVERSION_DIR_NAME,
  GIT_CONVERSION_DISK_MARGIN_BYTES,
  GIT_CONVERSION_HEARTBEAT_MS,
  GIT_CONVERSION_SLOTS,
  GIT_CONVERSION_MAX_REQUEST_BYTES,
  GIT_CONVERSION_STEP_DEADLINE_MS,
  GIT_CONVERSION_WORK_PREFIX,
  conversionMarker,
} from "./limits.js";
import { notifyConversion } from "./notify.js";
import { buildHistory, ConversionStepError, initRepository, type BuiltHistory } from "./objects.js";
import { parsePlan, type ConversionPlan } from "./plan.js";
import { pushFailure, pushHistory, readRemote, resumeIndex } from "./push.js";
import { historySource } from "./source.js";
import {
  LeaseLost,
  claimConversion,
  renewLease,
  updateHeld,
  writeHeld,
  type ConversionRow,
  type Lease,
} from "./store.js";

/**
 * The Convert to repo job (KOBE-765, spec workspace-git G16, G17). One attempt runs on the replica
 * that claimed it (a lease in `git_conversions`, renewed every
 * {@link GIT_CONVERSION_HEARTBEAT_MS}); a restarted or crashed replica's attempt is claimed again
 * by the resume sweep once its lease lapses, and continues at its recorded `step`:
 *
 *   create ── repository on the host (or the chosen empty one); its id recorded at once ──▶
 *   push   ── history built locally (same hashes every time), pushed in fast-forward batches,
 *             each batch's progress recorded; a resumed push continues after the host's head ──▶
 *   finish ── the host's branch is our head and its default branch ours, then ONE transaction:
 *             project kind `repo`, the repository row linked, the attempt `completed`, audit ──▶
 *   done.
 *
 * No transaction is open during a host call. Any failure leaves the project an ordinary project,
 * the attempt `failed` with a code (and the file or commit to blame), audited and emailed to the
 * requester; a person retries (resumes at the step) or abandons it. Kobe never deletes a
 * repository on the host: an abandoned attempt's repository stays, listed in the Git section.
 */
export interface ConversionDeps {
  readonly db: KobeDb;
  readonly envelope: Envelope | undefined;
  readonly net: GitHostNet;
  readonly blobs: BlobStore | undefined;
  readonly mailer: Mailer;
  readonly publicUrl: string;
  readonly log: Pick<Logger, "info" | "warn" | "error">;
  /** Tests: a fake adapter. */
  readonly adapterFor?: (input: GitAdapterInput) => GitHostAdapter;
  readonly batchBytes?: number;
  /** Conversions this replica runs at once (default {@link GIT_CONVERSION_SLOTS}). */
  readonly slots?: number;
  readonly heartbeatMs?: number;
  /** Tests: called before each step (a crash between steps). */
  readonly beforeStep?: (row: ConversionRow) => Promise<void> | void;
}

interface Context {
  readonly deps: ConversionDeps;
  readonly lease: Lease;
  readonly connection: GitConnectionRecord;
  readonly target: GitHostTarget;
  readonly adapter: GitHostAdapter;
  readonly plan: ConversionPlan;
  readonly workDir: string;
}

/** Runs one attempt until it finishes, fails or another replica holds it. */
export async function runConversion(
  deps: ConversionDeps,
  teamId: string,
  id: string,
): Promise<"completed" | "failed" | "busy" | "lost"> {
  // Review M3: a replica runs at most GIT_CONVERSION_SLOTS conversions; the rest stay unclaimed
  // for the resume sweep (of this or another replica).
  if (running >= (deps.slots ?? GIT_CONVERSION_SLOTS)) return "busy";
  running += 1;
  try {
    return await claimAndRun(deps, teamId, id);
  } finally {
    running -= 1;
  }
}

let running = 0;

/** Conversions this process runs now (tests). */
export const runningConversions = (): number => running;

async function claimAndRun(
  deps: ConversionDeps,
  teamId: string,
  id: string,
): Promise<"completed" | "failed" | "busy" | "lost"> {
  const owner = randomUUID();
  const claim = await claimConversion(deps.db, teamId, id, owner);
  if (claim.kind === "busy") return "busy";
  if (claim.kind === "gave_up") {
    deps.log.error({ conversion_id: id }, "git conversion stopped after interrupted runs");
    await notifyConversion(deps, claim.row).catch((err: unknown) =>
      deps.log.warn({ err, conversion_id: id }, "git conversion email not sent"),
    );
    return "failed";
  }
  let row = claim.row;
  const lease: Lease = { teamId, id, owner };
  let lost = false;
  const beat = setInterval(() => {
    renewLease(deps.db, lease).catch((err: unknown) => {
      if (err instanceof LeaseLost) lost = true;
      else deps.log.warn({ err, conversion_id: id }, "git conversion lease not renewed");
    });
  }, deps.heartbeatMs ?? GIT_CONVERSION_HEARTBEAT_MS);
  beat.unref();
  let workDir: string | undefined;
  try {
    const root = conversionWorkRoot();
    await mkdir(root, { recursive: true, mode: 0o700 });
    workDir = await mkdtemp(path.join(root, GIT_CONVERSION_WORK_PREFIX));
    const ctx = await context(deps, lease, row, workDir);
    let built: { built: BuiltHistory; http: HttpClient; repo: GitRepository } | undefined;
    const local =
      row.step === "create" || row.step === "push" ? await buildLocal(ctx, row) : undefined;
    while (row.step !== "done") {
      if (lost) throw new LeaseLost();
      await deps.beforeStep?.(row);
      if (row.step === "create") row = await createStep(ctx, row);
      else if (row.step === "push") {
        if (!local) throw new ConversionStepError("internal_error", "no local history");
        ({ row, built } = await pushStep(ctx, row, local));
      } else row = await finishStep(ctx, row, built);
    }
    await notifyConversion(deps, row).catch((err: unknown) =>
      deps.log.warn({ err, conversion_id: id }, "git conversion email not sent"),
    );
    return "completed";
  } catch (err) {
    if (err instanceof LeaseLost) return "lost";
    const failed = await recordFailure(deps, lease, row, err);
    if (!failed) return "lost";
    await notifyConversion(deps, failed).catch((e: unknown) =>
      deps.log.warn({ err: e, conversion_id: id }, "git conversion email not sent"),
    );
    return "failed";
  } finally {
    clearInterval(beat);
    if (workDir !== undefined) {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** The connection, the Site's decision, the opened credential and the adapter for this attempt. */
async function context(
  deps: ConversionDeps,
  lease: Lease,
  row: ConversionRow,
  workDir: string,
): Promise<Context> {
  const plan = parsePlan(row.plan);
  if (!deps.envelope || row.connectionId === null) {
    throw new ConversionStepError("connection_unavailable");
  }
  const connectionId = row.connectionId;
  const found = await withTeam(deps.db, lease.teamId, async (tx) => ({
    connection: await readGitConnection(tx, lease.teamId, connectionId),
    sealed: await readGitConnectionSealedCredential(tx, lease.teamId, connectionId),
  }));
  const { connection, sealed } = found;
  if (
    !connection ||
    !sealed ||
    connection.accessLevel !== "read_write" ||
    connection.baseUrl !== row.baseUrl ||
    connection.organization.toLowerCase() !== row.organization.toLowerCase()
  ) {
    throw new ConversionStepError("connection_unavailable");
  }
  let target: GitHostTarget;
  try {
    target = gitHostTarget(await readGitSiteSettings(deps.db), connection.baseUrl, {
      allowHttp: deps.net.policy.allowHttp,
    });
  } catch {
    throw new ConversionStepError("connection_unavailable");
  }
  let secret;
  try {
    secret = openGitCredential(
      deps.envelope,
      { teamId: lease.teamId, connectionId },
      sealed.credentialSealed,
      sealed.credentialKind,
    );
  } catch {
    throw new ConversionStepError("credential_rejected");
  }
  const adapter = (deps.adapterFor ?? gitHostAdapter)({
    connection,
    secret,
    target,
    net: deps.net,
  });
  return { deps, lease, connection, target, adapter, plan, workDir };
}

const isMine = (repo: GitRepository, row: ConversionRow) =>
  (repo.description ?? "").includes(conversionMarker(row.id));

/**
 * Review H1: private project history never goes to a repository more visible than the attempt
 * asked for. Private always passes; internal only when the attempt asked for internal and the
 * connection still allows it; anything else (public) stops the attempt with `repository_public`.
 * Checked on the repository the host created, on one adopted or chosen, in every read of the
 * recorded repository, before every push batch and before the finish.
 */
export function assertVisibility(
  repo: Pick<GitRepository, "visibility" | "fullName">,
  asked: "private" | "internal",
  connectionAllows: "private" | "internal",
): void {
  if (repo.visibility === "private") return;
  if (repo.visibility === "internal" && asked === "internal" && connectionAllows === "internal") {
    return;
  }
  throw new ConversionStepError("repository_public", repo.fullName);
}

const checkVisible = (ctx: Context, row: ConversionRow, repo: GitRepository): GitRepository => {
  assertVisibility(repo, row.visibility, ctx.connection.repoVisibility);
  return repo;
};

/**
 * A smart-HTTP client for the repository with a fresh credential and a fresh Site decision (review
 * L2: the Site switch and host list are read again for every client, i.e. before every batch).
 */
async function wireFor(ctx: Context, repo: GitRepository): Promise<HttpClient> {
  let target: GitHostTarget;
  try {
    target = gitHostTarget(await readGitSiteSettings(ctx.deps.db), ctx.connection.baseUrl, {
      allowHttp: ctx.deps.net.policy.allowHttp,
    });
  } catch {
    throw new ConversionStepError("connection_unavailable");
  }
  const credential = await ctx.adapter.repositoryCredential(repo.name, "write");
  return gitWireClient({
    net: ctx.deps.net,
    target,
    repositoryUrl: repo.cloneUrl,
    credential: { username: credential.username, password: credential.password },
    maxRequestBytes: GIT_CONVERSION_MAX_REQUEST_BYTES,
    deadlineAt: Date.now() + GIT_CONVERSION_STEP_DEADLINE_MS,
  });
}

async function isEmpty(ctx: Context, repo: GitRepository): Promise<boolean> {
  const remote = await readRemote(await wireFor(ctx, repo), repo.cloneUrl, ctx.plan.branch);
  return remote.refs === 0;
}

async function lookup(ctx: Context, name: string): Promise<GitRepository | undefined> {
  try {
    return await ctx.adapter.getRepository({ name });
  } catch (err) {
    if (err instanceof GitHostError && err.code === "not_found") return undefined;
    throw err;
  }
}

/**
 * Step 1: the repository. A new one carries the attempt's marker in its description, so an
 * attempt interrupted between the host's answer and the record adopts exactly the repository it
 * created (empty, with its marker), never another; a chosen existing one must be empty and private.
 */
async function createStep(ctx: Context, row: ConversionRow): Promise<ConversionRow> {
  const name = row.repositoryName;
  let repo: GitRepository | undefined;
  if (row.useExisting) {
    // The adapter confines lookups to the connection's organization (a repository elsewhere is
    // "not found").
    repo = await lookup(ctx, name);
    if (!repo) throw new ConversionStepError("repository_gone", name);
    checkVisible(ctx, row, repo);
    // Review M2: another Workspace's Repo is invisible under RLS; a repository with any Kobe
    // conversion mark may be one, so it is refused.
    if ((repo.description ?? "").includes(conversionMarker(""))) {
      throw new ConversionStepError("repository_in_use", name);
    }
    if (repo.archived || !(await isEmpty(ctx, repo))) {
      throw new ConversionStepError("repository_not_empty", name);
    }
    // Review L6: a chosen repository's default branch must be the one Kobe pushes.
    if (repo.defaultBranch !== null && repo.defaultBranch !== ctx.plan.branch) {
      throw new ConversionStepError("default_branch_mismatch", repo.defaultBranch);
    }
  } else {
    if (row.createAttemptedAt !== null) {
      // An earlier attempt asked the host and stopped before recording the answer.
      const found = await lookup(ctx, name);
      if (found) {
        if (!isMine(found, row)) throw new ConversionStepError("repository_exists", name);
        checkVisible(ctx, row, found);
        if (!(await isEmpty(ctx, found)))
          throw new ConversionStepError("repository_not_empty", name);
        repo = found;
      }
    }
    if (!repo) {
      row = await writeHeld(ctx.deps.db, ctx.lease, { createAttemptedAt: new Date() });
      try {
        repo = await ctx.adapter.createRepository({
          name,
          visibility: row.visibility,
          description: `Converted from a Kobe project. ${conversionMarker(row.id)}`,
        });
      } catch (err) {
        if (!(err instanceof GitHostError) || err.code !== "conflict") throw err;
        const found = await lookup(ctx, name);
        if (!found || !isMine(found, row)) throw new ConversionStepError("repository_exists", name);
        repo = found;
      }
    }
  }
  // Recorded first (the host made it), then checked: a public one is never pushed to.
  const recorded = await recordRepository(ctx, row, repo);
  checkVisible(ctx, recorded, repo);
  return recorded;
}

/** Records the host's id and the repository row, and moves on to the push, in one transaction. */
async function recordRepository(
  ctx: Context,
  row: ConversionRow,
  repo: GitRepository,
): Promise<ConversionRow> {
  const { teamId } = ctx.lease;
  return withTeam(ctx.deps.db, teamId, async (tx) => {
    const res = await tx.execute<{ id: string; project_id: string | null }>(sql`
      INSERT INTO git_repositories
        (team_id, connection_id, base_url, host_repo_id, full_name, default_branch, origin,
         is_private, created_by)
      VALUES (${teamId}, ${ctx.connection.id}, ${ctx.connection.baseUrl}, ${repo.id},
              ${repo.fullName}, ${ctx.plan.branch}, 'conversion', ${repo.visibility !== "public"},
              ${row.requestedBy})
      ON CONFLICT (team_id, base_url, host_repo_id) DO UPDATE
        SET full_name = EXCLUDED.full_name, connection_id = EXCLUDED.connection_id,
            host_state = 'active', updated_at = now()
      RETURNING id, project_id`);
    const record = res.rows[0];
    if (!record) throw new Error("git_repositories upsert returned no row");
    if (record.project_id !== null && record.project_id !== row.projectId) {
      throw new ConversionStepError("repository_exists", repo.fullName);
    }
    return updateHeld(tx, ctx.lease, {
      hostRepoId: repo.id,
      repositoryId: record.id,
      step: "push",
    });
  });
}

/** The repository this attempt recorded, by the host's id (G20: followed through a rename). */
async function recordedRepository(ctx: Context, row: ConversionRow): Promise<GitRepository> {
  if (row.hostRepoId === null) throw new ConversionStepError("internal_error");
  let repo: GitRepository;
  try {
    repo = await ctx.adapter.getRepository({ id: row.hostRepoId });
  } catch (err) {
    if (err instanceof GitHostError && err.code === "not_found") {
      throw new ConversionStepError("repository_gone", row.repositoryName);
    }
    throw err;
  }
  if (repo.archived) throw new ConversionStepError("push_rejected", repo.fullName);
  return checkVisible(ctx, row, repo);
}

/** Step 2: build the history and push what the host does not have yet. */
async function pushStep(
  ctx: Context,
  row: ConversionRow,
  local: LocalHistory,
): Promise<{
  row: ConversionRow;
  built: { built: BuiltHistory; http: HttpClient; repo: GitRepository };
}> {
  const { deps, lease, plan } = ctx;
  const { gitdir, built } = local;
  const repo = await recordedRepository(ctx, row);
  const head = built.commits.at(-1) as string;
  if (row.headSha !== null && row.headSha !== head) {
    // The plan is frozen and objects are deterministic: a different head means something changed.
    throw new ConversionStepError("internal_error", "head");
  }
  await writeHeld(deps.db, lease, { headSha: head, commitsTotal: built.commits.length });
  let http = await wireFor(ctx, repo);
  const from = resumeIndex(
    built,
    await readRemote(http, repo.cloneUrl, plan.branch).catch(rethrow),
  );
  await pushHistory({
    gitdir,
    http: async () => {
      // Before every batch (review H1): the repository is still the one recorded and no more
      // visible than asked. Then a fresh credential (an installation token lives an hour; cached
      // by the adapter) and a fresh Site decision.
      await recordedRepository(ctx, row);
      http = await wireFor(ctx, repo);
      return http;
    },
    url: repo.cloneUrl,
    branch: plan.branch,
    built,
    from,
    batchBytes: deps.batchBytes ?? GIT_CONVERSION_BATCH_BYTES,
    onPushed: async (pushed) => {
      await writeHeld(deps.db, lease, { commitsPushed: pushed });
    },
  });
  const current = await writeHeld(deps.db, lease, {
    step: "finish",
    commitsPushed: built.commits.length,
  });
  return { row: current, built: { built, http, repo } };
}

/** The dedicated folder conversions work in (review M3). */
export function conversionWorkRoot(): string {
  return path.join(tmpdir(), GIT_CONVERSION_DIR_NAME);
}

/** Distinct content the project's carried trees hold, in bytes (what the work folder needs). */
async function projectBytes(db: KobeDb, teamId: string, projectId: string): Promise<number> {
  const res = await withTeam(db, teamId, (tx) =>
    tx.execute<{ bytes: string | null }>(sql`
      SELECT sum(size_bytes) AS bytes FROM (
        SELECT DISTINCT ON (e.sha256) e.sha256, e.size_bytes FROM project_tree_entries e
          JOIN project_commits c ON c.team_id = e.team_id AND c.id = e.commit_id
         WHERE e.team_id = ${teamId} AND c.project_id = ${projectId}
         ORDER BY e.sha256) f`),
  );
  return Number(res.rows[0]?.bytes ?? 0);
}

/** Refuses to start building when the folder's file system has no room (`server_capacity`). */
async function assertRoom(dir: string, bytes: number): Promise<void> {
  const fsStats = await statfs(dir).catch(() => undefined);
  if (!fsStats) return;
  const free = Number(fsStats.bavail) * Number(fsStats.bsize);
  if (free < bytes + GIT_CONVERSION_DISK_MARGIN_BYTES) {
    throw new ConversionStepError("server_capacity", `${Math.ceil(bytes / 1048576)} MiB needed`);
  }
}

interface LocalHistory {
  readonly gitdir: string;
  readonly built: BuiltHistory;
}

/**
 * Builds the whole history locally before anything is created or pushed (review M1): a file the
 * host refuses, or one Kobe's storage cannot give back, stops the attempt while the host has
 * nothing. Needs room on disk for the project's content (review M3).
 */
async function buildLocal(ctx: Context, row: ConversionRow): Promise<LocalHistory> {
  const { deps, lease, plan } = ctx;
  if (!deps.blobs) throw new ConversionStepError("content_missing");
  await assertRoom(ctx.workDir, await projectBytes(deps.db, lease.teamId, row.projectId));
  const gitdir = path.join(ctx.workDir, "repo.git");
  await rm(gitdir, { recursive: true, force: true });
  await initRepository(gitdir, plan.branch);
  const built = await buildHistory(
    gitdir,
    plan,
    historySource(deps.db, deps.blobs, lease.teamId, row.projectId),
  );
  return { gitdir, built };
}

const rethrow = (err: unknown): never => {
  throw pushFailure(err);
};

/**
 * Step 3: the host's branch is our head and its default branch ours, then the project becomes a
 * Repo in one transaction (under the project row lock, the same lock every Kobe write takes).
 */
async function finishStep(
  ctx: Context,
  row: ConversionRow,
  pushed: { http: HttpClient; repo: GitRepository } | undefined,
): Promise<ConversionRow> {
  const { deps, lease, plan } = ctx;
  const repo = pushed?.repo ?? (await recordedRepository(ctx, row));
  const http = pushed?.http ?? (await wireFor(ctx, repo));
  const remote = await readRemote(http, repo.cloneUrl, plan.branch).catch(rethrow);
  const headSha = row.headSha;
  const repositoryId = row.repositoryId;
  if (headSha === null || repositoryId === null || remote.head !== headSha) {
    throw new ConversionStepError("repository_changed", repo.fullName);
  }
  // The host's view after the push (GitHub makes the first pushed branch the default).
  const fresh = checkVisible(ctx, row, await ctx.adapter.getRepository({ id: repo.id }));
  if (fresh.defaultBranch !== null && fresh.defaultBranch !== plan.branch) {
    throw new ConversionStepError("default_branch_mismatch", fresh.defaultBranch);
  }
  return withTeam(deps.db, lease.teamId, async (tx) => {
    const project = await tx.execute<{
      kind: string;
      head_commit_id: string | null;
      archived_at: Date | null;
    }>(sql`
      SELECT kind, head_commit_id, archived_at FROM projects
       WHERE team_id = ${lease.teamId} AND id = ${row.projectId} FOR UPDATE`);
    const p = project.rows[0];
    if (!p) throw new LeaseLost();
    if (p.kind !== "project" || p.head_commit_id !== plan.headCommitId || p.archived_at !== null) {
      throw new ConversionStepError("project_changed");
    }
    await tx.execute(sql`
      UPDATE projects SET kind = 'repo', updated_at = now()
       WHERE team_id = ${lease.teamId} AND id = ${row.projectId}`);
    await tx.execute(sql`
      UPDATE git_repositories
         SET project_id = ${row.projectId}, default_branch = ${plan.branch},
             full_name = ${fresh.fullName}, is_private = ${fresh.visibility !== "public"},
             mirror_head_sha = ${headSha}, mirror_refreshed_at = now(), host_state = 'active',
             updated_at = now()
       WHERE team_id = ${lease.teamId} AND id = ${repositoryId}`);
    const done = await updateHeld(tx, lease, {
      status: "completed",
      step: "done",
      finishedAt: new Date(),
      leaseOwner: null,
      leaseUntil: null,
      lastError: null,
      lastErrorDetail: null,
    });
    await recordAudit(tx, {
      action: "git.project.converted",
      actor: SYSTEM_ACTOR,
      teamId: lease.teamId,
      target: {
        conversionId: row.id,
        projectId: row.projectId,
        ...(row.connectionId === null ? {} : { connectionId: row.connectionId }),
        repositoryId,
        hostRepoId: repo.id,
        commits: plan.commits.length,
        headSha,
        attempts: done.attempts,
      },
    });
    return done;
  });
}

/** A failure as the attempt stores it: a code from the protocol list and a short detail. */
export function failureOf(err: unknown): { code: string; detail: string | null } {
  const mapped = pushFailure(err);
  if (mapped instanceof ConversionStepError) {
    return { code: mapped.code, detail: mapped.detail?.slice(0, 1100) ?? null };
  }
  if (mapped instanceof GitHostError) {
    switch (mapped.code) {
      case "auth_failed":
        return { code: "credential_rejected", detail: mapped.reason ?? null };
      case "forbidden":
        return { code: "credential_forbidden", detail: mapped.missingPermission ?? null };
      case "rate_limited":
        return { code: "host_rate_limited", detail: mapped.resetAt?.toISOString() ?? null };
      case "host_unreachable":
        return { code: "host_unreachable", detail: null };
      case "not_found":
        return { code: "repository_gone", detail: null };
      case "conflict":
        return { code: "repository_exists", detail: null };
      case "host_refused":
      case "unsupported_host":
        return { code: "connection_unavailable", detail: mapped.reason ?? null };
      case "invalid_request":
        return { code: "push_rejected", detail: null };
      default:
        return { code: "internal_error", detail: null };
    }
  }
  return { code: "internal_error", detail: null };
}

/** Marks the attempt failed (audited); undefined when the lease was lost meanwhile. */
async function recordFailure(
  deps: ConversionDeps,
  lease: Lease,
  row: ConversionRow,
  err: unknown,
): Promise<ConversionRow | undefined> {
  const { code, detail } = failureOf(err);
  const log = code === "internal_error" ? deps.log.error : deps.log.warn;
  log.call(
    deps.log,
    { err, conversion_id: lease.id, step: row.step, failure: code },
    "git conversion failed",
  );
  try {
    return await withTeam(deps.db, lease.teamId, async (tx) => {
      const failed = await updateHeld(tx, lease, {
        status: "failed",
        lastError: code,
        lastErrorDetail: detail,
        leaseOwner: null,
        leaseUntil: null,
      });
      await recordAudit(tx, {
        action: "git.project.conversion_failed",
        actor: SYSTEM_ACTOR,
        teamId: lease.teamId,
        target: {
          conversionId: lease.id,
          projectId: failed.projectId,
          step: failed.step,
          failure: code,
          attempts: failed.attempts,
          repositoryCreated: failed.hostRepoId !== null && !failed.useExisting,
        },
      });
      return failed;
    });
  } catch (e) {
    if (e instanceof LeaseLost) return undefined;
    throw e;
  }
}
