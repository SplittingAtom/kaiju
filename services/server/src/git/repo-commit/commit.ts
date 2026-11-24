import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  openGitCredential,
  readGitSiteSettings,
  withTeam,
  type Envelope,
  type GitConnectionRecord,
  type KobeDb,
} from "@kobe/db";
import type { AuditVia } from "@kobe/db";
import { recordAudit } from "../../audit/record.js";
import type { BlobStore } from "../../retention/blobs.js";
import {
  assertBranch,
  GitHostError,
  type GitHostAdapter,
  type GitRepository,
} from "../../git-hosts/adapter.js";
import { gitHostAdapter, type GitAdapterInput } from "../../git-hosts/factory.js";
import { gitWireSession } from "../../git-hosts/git-wire.js";
import type { GitHostNet } from "../../git-hosts/http.js";
import { gitHostTarget, type GitHostTarget } from "../../git-hosts/target.js";
import {
  commitWorkingCopy,
  planCommit,
  type CommitDeps,
  type CommitRefusal,
  type CommitRequest,
  type CommitResult,
  type Plan,
} from "../../projects/commits.js";
import { loadTree, type Tree } from "../../projects/tree.js";
import { checkRateLimit, type RateLimitRule } from "../../rate-limit.js";
import { hostReason, readRemote } from "../conversion/push.js";
import { parseReportStatus, writeReceivePack } from "../conversion/pack.js";
import { gitattributesRefusal, isGitattributes, pathRefusal } from "../conversion/paths.js";
import { buildRunGitContext, gitCommitEmailMode } from "../sandbox-git.js";
import { commitContent, gitObjectId, writeLoose } from "./objects.js";
import { pullRequestBody, pullRequestBranch, pullRequestTitle } from "./naming.js";
import { loadRepoCommitFacts, saveBranch, type BranchRow, type RepoCommitFacts } from "./store.js";
import { editTree, TreeMismatch, type FileEdit } from "./tree-edit.js";

/**
 * Committing to a Repo from Kaiju's commit flow (KOBE-767, spec workspace-git G18, GQ11, G12, G13).
 * The Commit dialog and the agent's `commit_project` call this for a project of kind `repo`. The
 * member's working copy is planned as for any project (edit rights, checkout, base = Kaiju's head,
 * the diff, limits); then, with no transaction open:
 *
 *  1. the rights of G12: the connection at Read and write, the Contributor role or above, edit
 *     rights on the project (planned), the Site's decision for the host, the repository private
 *     (or internal where the connection allows it), not archived, still the recorded one (by id);
 *  2. a git commit: the changed files' blobs (read from Kaiju's storage, checked against their
 *     SHA-256), the folders on their paths read from the host's tree of the default branch's head
 *     now (or of the open pull request's base) and written again, each changed path checked
 *     three-way against Kaiju's base (review H1: the host's version must still be the base's, so
 *     another person's change to the same file is refused as `repo_moved`, never overwritten), and
 *     a commit authored as the member (their Kaiju email or the Workspace's no-reply form, GQ10)
 *     with "<name> via Kaiju" as committer;
 *  3. a push, always a compare-and-swap, never forced, over the guarded smart-HTTP client with a
 *     credential minted for this repository (G8: it never leaves the server):
 *     - by default (GQ11) to a branch of its own, and a pull request into the default branch is
 *       opened; while that pull request is open and the working copy has the same base, the next
 *       commit is added to the same branch (`git_commit_branches`);
 *     - when the connection allows direct commits, to the default branch from its head. If the
 *       branch moved between the read and the push, the push is refused and the member is told
 *       to Update (`repo_moved`; Kaiju's copy is refreshed, KOBE-766); if the host refuses it
 *       otherwise (a protected branch), a pull request is opened instead (`fallback`). When Kaiju's
 *       copy stood exactly on that head, it takes the same commit (`repoMirror`), so the member's
 *       checkout moves on as with any commit; otherwise the mirror refresh brings it in.
 *
 * `git.repo.commit_attempted` is written before the push and `git.repo.committed` right after it,
 * before anything else (review M3): a push that landed is answered as a success even when a later
 * Kaiju write fails. Refusals are `git.repo.commit_failed`. Nothing here logs or returns the
 * credential; host text reaches the member only as receive-pack's short reason (`hostReason`).
 */
export interface RepoCommitDeps {
  readonly commit: CommitDeps;
  readonly envelope: Envelope | undefined;
  readonly net: GitHostNet;
  readonly publicUrl: string;
  /** Tests: a fake adapter. */
  readonly adapterFor?: (input: GitAdapterInput) => GitHostAdapter;
  /**
   * Refreshes Kaiju's copy of the Repo from the host now (KOBE-766 `kickMirrorRefresh`; never
   * throws, runs in the background), so `repo_moved` and Update do not wait for the timer.
   */
  readonly refreshMirror?: (teamId: string, repositoryId: string) => void;
  /** Asks the mirror job for a refresh soon (after a pull request push: the commit list). */
  readonly requestMirror?: (teamId: string, repositoryId: string) => Promise<unknown>;
  readonly now?: () => Date;
  /** Tests: between the plan and the first read of the host (review H1's race). */
  readonly afterPlan?: () => Promise<void>;
  /** Tests: after a successful push, before Kaiju's records are written (review M3). */
  readonly afterPush?: () => Promise<void>;
}

export interface RepoCommitRequest extends Omit<CommitRequest, "repoMirror"> {
  /** An agent's commit: the conversation (named in the pull request) and the audit's `viaAgent`. */
  readonly via?: AuditVia;
  /**
   * An agent's commit: the subject its approval (or rule) was for. A push to a git host needs
   * `commit_repo` (review R2-L1: a project that became a Repo after the call was decided is
   * refused rather than pushed under a `commit_project` approval).
   */
  readonly approvedAs?: "commit_project" | "commit_repo";
}

/** Commits to Repos per member per hour (`git-repo-commits:<user>`; shared limiter). */
export const GIT_REPO_COMMIT_RATE: RateLimitRule = { windowMs: 60 * 60_000, max: 60 };
/**
 * Attempts that may reach the host per member per hour (`git-repo-commit-attempts:<user>`, review
 * N1): taken before the first host call, so no member can turn refused or repeated attempts into
 * unbounded traffic on the Workspace's shared credential. Larger than the commit limit, because
 * attempts that end without a push (nothing new, a conflict) count here only.
 */
export const GIT_REPO_COMMIT_ATTEMPT_RATE: RateLimitRule = { windowMs: 60 * 60_000, max: 300 };
/** One push's request cap: the changed files of one commit (Kaiju's file cap is 50 MiB each). */
export const GIT_REPO_COMMIT_MAX_REQUEST_BYTES = 2 * 1024 * 1024 * 1024;
/** One commit's deadline for all its exchanges with the host. */
export const GIT_REPO_COMMIT_DEADLINE_MS = 10 * 60_000;
export const GIT_REPO_COMMIT_DIR_NAME = "kobe-git-repo-commits";

type Refused = Extract<CommitResult, { status: "refused" }>;
const refused = (
  error: CommitRefusal,
  detail?: string,
  extra: { path?: string } = {},
): Refused => ({
  status: "refused",
  error,
  ...(detail === undefined ? {} : { detail }),
  ...extra,
});

/** A refusal raised anywhere below and answered as is. */
class Stop extends Error {
  constructor(readonly result: Refused) {
    super(result.error);
    this.name = "Stop";
  }
}
const stop = (error: CommitRefusal, detail?: string, extra?: { path?: string }): Stop =>
  new Stop(refused(error, detail, extra));

/** Member, project: one commit to a Repo at a time on this replica (a double click). */
const inFlight = new Set<string>();

export async function commitToRepo(
  deps: RepoCommitDeps,
  req: RepoCommitRequest,
): Promise<CommitResult> {
  const key = `${req.owner.teamId}:${req.projectId}:${req.owner.userId}`;
  if (inFlight.has(key)) return refused("changed");
  inFlight.add(key);
  try {
    return await run(deps, req);
  } catch (err) {
    if (err instanceof Stop) return err.result;
    throw err;
  } finally {
    inFlight.delete(key);
  }
}

interface Context {
  readonly deps: RepoCommitDeps;
  readonly req: RepoCommitRequest;
  readonly plan: Plan;
  readonly facts: RepoCommitFacts;
  /** Kaiju's base tree of the checkout (the three-way check's base). */
  readonly base: Tree;
  readonly connection: GitConnectionRecord;
  readonly adapter: GitHostAdapter;
  readonly repo: GitRepository;
  readonly defaultBranch: string;
  readonly gitdir: string;
}

async function run(deps: RepoCommitDeps, req: RepoCommitRequest): Promise<CommitResult> {
  const { db } = deps.commit;
  const { teamId, userId } = req.owner;
  // Review H1: the plan, the repository row (locked FOR SHARE) and Kaiju's base tree in one
  // transaction, so they describe one state.
  const prepared = await withTeam(db, teamId, async (tx) => {
    const plan = await planCommit(tx, deps.commit, req, { repo: true });
    if (!("files" in plan)) return { result: plan };
    const facts = await loadRepoCommitFacts(tx, teamId, userId, req.projectId, req.via?.runId);
    const base = await loadTree(tx, teamId, plan.checkout.baseCommitId);
    return { plan, facts, base };
  });
  if ("result" in prepared) return prepared.result;
  const { plan, facts, base } = prepared;
  if (!facts) return refused("repo_unavailable", "This Repo has no repository record.");
  if (req.via !== undefined && req.approvedAs !== "commit_repo") {
    return refused(
      "repo_unavailable",
      "This commit was approved for Kaiju's own copy, and the project is a Repo now: commit again so the push to the git host can be approved.",
    );
  }
  const connection = rightsOf(facts, req);
  // Review N1: the limits before any host call or credential mint.
  const limited = await limitsBeforeHost(db, userId);
  if (limited) return limited;
  await deps.afterPlan?.();
  const adapter = await adapterOf(deps, teamId, facts, connection);
  const repo = await recorded(adapter, facts, connection);
  const root = path.join(os.tmpdir(), GIT_REPO_COMMIT_DIR_NAME);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const gitdir = await mkdtemp(path.join(root, "run-"));
  try {
    const ctx: Context = {
      deps,
      req,
      plan,
      facts,
      base,
      connection,
      adapter,
      repo,
      defaultBranch: branchOf(repo, facts),
      gitdir,
    };
    return await commitAndPush(ctx);
  } catch (err) {
    if (err instanceof Stop) {
      await failed(ctx0(deps, req, facts, connection), err.result.error);
      throw err;
    }
    if (err instanceof GitHostError) {
      const stopped = hostStop(err);
      await failed(ctx0(deps, req, facts, connection), stopped.result.error);
      throw stopped;
    }
    throw err;
  } finally {
    await rm(gitdir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const rateLimited = (retryAfterSeconds: number): Refused => ({
  status: "refused",
  error: "rate_limited",
  detail: `Too many commits to Repos. Try again in ${retryAfterSeconds} seconds.`,
  retryAfterSeconds,
});

class PeekDone extends Error {}

/** The limiter's verdict for one more hit, without taking it (the hit rolls back). */
async function peekRateLimit(
  db: KobeDb,
  key: string,
  rule: RateLimitRule,
): Promise<{ readonly allowed: boolean; readonly retryAfterSeconds: number }> {
  let verdict = { allowed: true, retryAfterSeconds: 1 };
  try {
    await db.transaction(async (tx) => {
      verdict = await checkRateLimit(tx, key, rule, undefined, { prune: false });
      throw new PeekDone();
    });
  } catch (err) {
    if (!(err instanceof PeekDone)) throw err;
  }
  return verdict;
}

/**
 * Review N1: before the host is asked anything, the member must be under the commit limit (looked
 * at, not taken: L2, it is taken only when a commit goes out) and gets one attempt from the larger
 * attempt bucket. An over-limit member makes no host request at all.
 */
async function limitsBeforeHost(db: KobeDb, userId: string): Promise<Refused | undefined> {
  const commits = await peekRateLimit(db, `git-repo-commits:${userId}`, GIT_REPO_COMMIT_RATE);
  if (!commits.allowed) return rateLimited(commits.retryAfterSeconds);
  const attempts = await checkRateLimit(
    db,
    `git-repo-commit-attempts:${userId}`,
    GIT_REPO_COMMIT_ATTEMPT_RATE,
  );
  if (!attempts.allowed) return rateLimited(attempts.retryAfterSeconds);
  return undefined;
}

/** Review L1: the host's default branch only when it is a name Kaiju sends; else the recorded one. */
function branchOf(repo: GitRepository, facts: RepoCommitFacts): string {
  const host = repo.defaultBranch;
  if (host !== null) {
    try {
      return assertBranch(host);
    } catch {
      // fall through to the recorded name
    }
  }
  return assertBranch(facts.repo.defaultBranch);
}

/** G12 and the connection's state, from the facts; the connection when the commit may go on. */
function rightsOf(facts: RepoCommitFacts, req: RepoCommitRequest): GitConnectionRecord {
  if (facts.role === null) throw stop("not_found");
  if (facts.role === "member") {
    throw stop(
      "forbidden",
      "Committing to a Repo needs the Contributor role in this Workspace; readers can read it.",
    );
  }
  if (facts.repo.hostState !== "active") {
    throw stop(
      "repo_unavailable",
      "The repository on the git host is gone or archived, so this Repo is read-only.",
    );
  }
  const c = facts.connection;
  if (c === undefined || facts.sealed === undefined) {
    throw stop("repo_unavailable", "The Repo's git connection was removed.");
  }
  if (c.accessLevel !== "read_write") {
    throw stop(
      "repo_unavailable",
      `The git connection "${c.displayName}" is not at Read and write, so commits can't reach the host.`,
    );
  }
  // Review M1 (GQ8): an agent's commit honours the connection's chosen agents, as the git host
  // tools do. The Commit dialog has no agent, so the list does not apply to it.
  if (req.via !== undefined && c.agentIds !== null) {
    const agent = facts.runAgentId ?? null;
    if (agent === null || !c.agentIds.includes(agent)) {
      throw stop(
        "repo_unavailable",
        `The git connection "${c.displayName}" is limited to chosen agents, and this conversation's agent is not one of them.`,
      );
    }
  }
  return c;
}

async function adapterOf(
  deps: RepoCommitDeps,
  teamId: string,
  facts: RepoCommitFacts,
  connection: GitConnectionRecord,
): Promise<GitHostAdapter> {
  if (!deps.envelope || facts.sealed === undefined) {
    throw stop("repo_unavailable", "Git connections are not available on this server.");
  }
  let target: GitHostTarget;
  try {
    target = await siteTarget(deps, connection);
  } catch {
    throw stop("repo_unavailable", "The Site does not allow this git host now.");
  }
  let secret;
  try {
    secret = openGitCredential(
      deps.envelope,
      { teamId, connectionId: connection.id },
      facts.sealed.credentialSealed,
      facts.sealed.credentialKind,
    );
  } catch {
    throw stop("repo_unavailable", "The git connection's credential could not be opened.");
  }
  return (deps.adapterFor ?? gitHostAdapter)({ connection, secret, target, net: deps.net });
}

async function siteTarget(
  deps: RepoCommitDeps,
  connection: GitConnectionRecord,
): Promise<GitHostTarget> {
  return gitHostTarget(await readGitSiteSettings(deps.commit.db), connection.baseUrl, {
    allowHttp: deps.net.policy.allowHttp,
  });
}

/** The recorded repository by the host's id: still private (or internal where allowed), active. */
async function recorded(
  adapter: GitHostAdapter,
  facts: RepoCommitFacts,
  connection: GitConnectionRecord,
): Promise<GitRepository> {
  let repo: GitRepository;
  try {
    repo = await adapter.getRepository({ id: facts.repo.hostRepoId });
  } catch (err) {
    if (err instanceof GitHostError && err.code === "not_found") {
      throw stop("repo_unavailable", "The repository is gone from the git host.");
    }
    throw err;
  }
  const allowed =
    repo.visibility === "private" ||
    (repo.visibility === "internal" && connection.repoVisibility === "internal");
  if (!allowed) {
    throw stop(
      "repo_unavailable",
      "The repository on the git host is no longer private, so Kaiju sends nothing to it.",
    );
  }
  if (repo.archived) throw stop("repo_unavailable", "The repository is archived on the git host.");
  return repo;
}

/**
 * The blobs of the changed files, written loose (path → edit), and the three-way check's base
 * (path → the blob id of Kaiju's base version, null for an added file).
 */
async function blobs(ctx: Context): Promise<Changes> {
  const store = ctx.deps.commit.blobs;
  if (!store) throw stop("storage_failed");
  const copied = new Map(ctx.plan.copies.map((c) => [c.sha256, c.source]));
  const edits = new Map<string, FileEdit>();
  const expected = new Map<string, string | null>();
  for (const change of ctx.plan.changes) {
    const problem = pathRefusal(change.path);
    if (problem !== undefined && change.change !== "deleted") {
      throw stop("invalid_path", `The git host would refuse this name: ${problem}.`, {
        path: change.path,
      });
    }
    const before = ctx.base.get(change.path);
    if (before === undefined) expected.set(change.path, null);
    else {
      const old = await readObject(store, before.blobRef, before.size).catch(() => null);
      if (old === null || createHash("sha256").update(old).digest("hex") !== before.sha256) {
        throw stop("storage_failed", undefined, { path: change.path });
      }
      expected.set(change.path, gitObjectId("blob", old));
    }
    if (change.change === "deleted") {
      edits.set(change.path, null);
      continue;
    }
    const file = ctx.plan.files.get(change.path);
    if (!file) throw stop("storage_failed");
    const key = copied.get(file.sha256) ?? file.blobRef;
    const bytes = await readObject(store, key, file.size).catch(() => null);
    if (bytes === null) throw stop("storage_failed", undefined, { path: change.path });
    if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
      throw stop("storage_failed", undefined, { path: change.path });
    }
    const name = change.path.split("/").pop() ?? "";
    if (isGitattributes(name)) {
      const bad = gitattributesRefusal(bytes);
      if (bad !== undefined) throw stop("invalid_path", bad, { path: change.path });
    }
    edits.set(change.path, {
      blob: await writeLoose(ctx.gitdir, "blob", bytes),
      executable: file.executable,
    });
  }
  return { edits, expected };
}

interface Changes {
  readonly edits: ReadonlyMap<string, FileEdit>;
  readonly expected: ReadonlyMap<string, string | null>;
}

/** An object's bytes, at most `size` of them (more is a mismatch, refused). */
async function readObject(store: BlobStore, key: string, size: number): Promise<Buffer | null> {
  const object = await store.objects.get(key);
  if (!object) return null;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of object.body) {
    const c = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += c.length;
    if (total > size) {
      object.body.destroy();
      return null;
    }
    chunks.push(c);
  }
  return Buffer.concat(chunks, total);
}

interface Built {
  readonly tree: string;
  /** Every object this commit introduces (blobs, trees, the commit), for the pack. */
  readonly objects: readonly string[];
}

/** The changes applied to the tree of commit `onto` on the host, checked three-way (H1). */
async function buildTree(ctx: Context, changes: Changes, onto: string): Promise<Built> {
  const objects = new Set<string>();
  for (const e of changes.edits.values()) if (e !== null) objects.add(e.blob);
  try {
    const { tree } = await editTree(
      onto,
      changes.edits,
      {
        read: async (sha) => (await ctx.adapter.readTree(ctx.repo.name, sha)).entries,
        write: async (content) => {
          const oid = await writeLoose(ctx.gitdir, "tree", content);
          objects.add(oid);
          return oid;
        },
      },
      changes.expected,
    );
    return { tree, objects: [...objects] };
  } catch (err) {
    if (err instanceof TreeMismatch) {
      ctx.deps.refreshMirror?.(ctx.req.owner.teamId, ctx.facts.repo.id);
      throw stop(
        "repo_moved",
        `${err.path} changed on the git host since your copy. Kaiju refreshes its copy; Update, then commit again.`,
      );
    }
    if (err instanceof GitHostError && err.code === "not_found") {
      ctx.deps.refreshMirror?.(ctx.req.owner.teamId, ctx.facts.repo.id);
      throw stop(
        "repo_moved",
        "The commit your copy stands on is no longer on the host. Kaiju refreshes its copy; Update, then commit again.",
      );
    }
    throw err;
  }
}

async function writeCommitObject(ctx: Context, tree: string, parent: string): Promise<string> {
  const identity = buildRunGitContext({
    user: ctx.facts.user,
    mode: gitCommitEmailMode(ctx.facts.teamSettings),
    siteHost: new URL(ctx.deps.publicUrl).hostname,
    connections: [],
  });
  return writeLoose(
    ctx.gitdir,
    "commit",
    commitContent({
      tree,
      parent,
      author: identity.author,
      committer: identity.committer,
      at: (ctx.deps.now ?? (() => new Date()))(),
      message: ctx.req.message,
    }),
  );
}

type PushOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly stale: boolean; readonly reason: string | null };

async function push(
  ctx: Context,
  ref: string,
  oldOid: string | null,
  newOid: string,
  objects: readonly string[],
): Promise<PushOutcome> {
  let target: GitHostTarget;
  try {
    target = await siteTarget(ctx.deps, ctx.connection);
  } catch {
    throw stop("repo_unavailable", "The Site does not allow this git host now.");
  }
  const credential = await ctx.adapter.repositoryCredential(ctx.repo.name, "write");
  const session = gitWireSession({
    net: ctx.deps.net,
    target,
    repositoryUrl: ctx.repo.cloneUrl,
    credential: { username: credential.username, password: credential.password },
    maxRequestBytes: Math.min(GIT_REPO_COMMIT_MAX_REQUEST_BYTES, ctx.connection.pushLimitBytes),
    deadlineAt: Date.now() + GIT_REPO_COMMIT_DEADLINE_MS,
  });
  const file = path.join(ctx.gitdir, `push-${newOid.slice(0, 12)}.req`);
  const size = await writeReceivePack({
    gitdir: ctx.gitdir,
    ref: `refs/heads/${ref}`,
    oldOid,
    newOid,
    objects: [...objects, newOid],
    file,
  });
  if (size > ctx.connection.pushLimitBytes) {
    throw stop("repo_push_rejected", "The commit is larger than the git connection's push limit.");
  }
  const answer = await session.postFile(
    `${ctx.repo.cloneUrl}/git-receive-pack`,
    file,
    size,
    "application/x-git-receive-pack-request",
  );
  await rm(file, { force: true });
  if (answer.status === 401 || answer.status === 403) {
    throw stop(
      "repo_unavailable",
      "The git host refused the Workspace's credential for this push.",
    );
  }
  if (answer.status === 404)
    throw stop("repo_unavailable", "The repository is gone from the git host.");
  if (answer.status === 413) {
    throw stop("repo_push_rejected", "The git host refused the size of the push.");
  }
  if (answer.status !== 200)
    throw stop("repo_unavailable", "The git host could not take the push now.");
  const report = parseReportStatus(answer.body, `refs/heads/${ref}`);
  if (report.ok) return { ok: true };
  return { ok: false, stale: report.stale, reason: hostReason(report.reason) };
}

/**
 * The branch's head on the host now (null: no such branch). A refused push is told apart by it:
 * the branch moved (someone else pushed) or the host refused this push itself (hosts word the
 * first differently, so the head is read rather than the reason parsed).
 */
async function remoteHead(ctx: Context, branch: string): Promise<string | null> {
  let target: GitHostTarget;
  try {
    target = await siteTarget(ctx.deps, ctx.connection);
  } catch {
    throw stop("repo_unavailable", "The Site does not allow this git host now.");
  }
  const credential = await ctx.adapter.repositoryCredential(ctx.repo.name, "read");
  const session = gitWireSession({
    net: ctx.deps.net,
    target,
    repositoryUrl: ctx.repo.cloneUrl,
    credential: { username: credential.username, password: credential.password },
    maxRequestBytes: 0,
    deadlineAt: Date.now() + GIT_REPO_COMMIT_DEADLINE_MS,
  });
  try {
    return (await readRemote(session.http, ctx.repo.cloneUrl, branch)).head;
  } catch (err) {
    if (err instanceof GitHostError || err instanceof Stop) throw err;
    throw stop("repo_unavailable", "The git host could not be reached. Try again.");
  }
}

async function commitAndPush(ctx: Context): Promise<CommitResult> {
  const checkoutBase = ctx.plan.checkout.baseCommitId;
  if (checkoutBase === null) throw stop("repo_unavailable", "Kaiju has no copy of the Repo yet.");
  const changes = await blobs(ctx);
  const head = await remoteHead(ctx, ctx.defaultBranch);
  if (head === null || !/^[0-9a-f]{40}$/.test(head)) {
    throw stop(
      "repo_unavailable",
      `The repository has no ${ctx.defaultBranch} branch on the host.`,
    );
  }
  // Review L2: counted only for a commit that is going to the host.
  const verdict = await checkRateLimit(
    ctx.deps.commit.db,
    `git-repo-commits:${ctx.req.owner.userId}`,
    GIT_REPO_COMMIT_RATE,
  );
  if (!verdict.allowed) return rateLimited(verdict.retryAfterSeconds);
  if (ctx.connection.directCommits) {
    const direct = await directCommit(ctx, changes, head);
    if (direct !== "fallback") return direct;
    return pullRequestCommit(ctx, changes, head, checkoutBase, true);
  }
  return pullRequestCommit(ctx, changes, head, checkoutBase, false);
}

/**
 * After a push the host took: `git.repo.committed` first (retried), then Kaiju's own records, each
 * failure logged and never turned into an error answer (review M3).
 */
async function settle(ctx: Context, what: Committed, then: () => Promise<void>): Promise<void> {
  let recorded = false;
  for (let attempt = 0; attempt < 3 && !recorded; attempt += 1) {
    try {
      await audited(ctx, what);
      recorded = true;
    } catch (err) {
      if (attempt === 2) {
        ctx.deps.commit.log.error(
          { err, project_id: ctx.req.projectId, commit_sha: what.commitSha },
          "git.repo.committed could not be recorded for a push the host took",
        );
      }
    }
  }
  try {
    await ctx.deps.afterPush?.();
    await then();
  } catch (err) {
    ctx.deps.commit.log.error(
      { err, project_id: ctx.req.projectId, commit_sha: what.commitSha },
      "a commit to a Repo landed on the host but Kaiju's records were not all written",
    );
  }
}

/** Straight to the default branch from its head; `fallback` when the host refuses it so. */
async function directCommit(
  ctx: Context,
  changes: Changes,
  head: string,
): Promise<CommitResult | "fallback"> {
  const branch = ctx.defaultBranch;
  const built = await buildTree(ctx, changes, head);
  const commit = await writeCommitObject(ctx, built.tree, head);
  await attempted(ctx, "direct", commit);
  const outcome = await push(ctx, branch, head, commit, built.objects);
  if (!outcome.ok) {
    if (outcome.stale || (await remoteHead(ctx, branch)) !== head) {
      ctx.deps.refreshMirror?.(ctx.req.owner.teamId, ctx.facts.repo.id);
      throw stop(
        "repo_moved",
        `${branch} moved on the git host while committing. Kaiju refreshes its copy; Update, then commit again.`,
      );
    }
    return "fallback";
  }
  let kobe: { readonly seq: number; readonly commitId: string } | undefined;
  // Kaiju's copy takes the same commit only when it stood exactly on the head pushed onto: the
  // checkout's base is the copy of `mirror_head_sha` and that is the host's head (review H1).
  const inSync =
    ctx.facts.repo.mirrorHeadSha === head &&
    ctx.facts.repo.mirrorCommitId !== null &&
    ctx.facts.repo.mirrorCommitId === ctx.plan.checkout.baseCommitId;
  await settle(ctx, { mode: "direct", commitSha: commit, fallback: false }, async () => {
    if (!inSync) return;
    const mirrored = await commitWorkingCopy(ctx.deps.commit, {
      owner: ctx.req.owner,
      projectId: ctx.req.projectId,
      message: ctx.req.message,
      author: ctx.req.author,
      expect: { baseSeq: ctx.plan.checkout.baseSeq, diffHash: ctx.plan.hash },
      repoMirror: { repositoryId: ctx.facts.repo.id, baseSha: head, headSha: commit },
    });
    if (mirrored.status === "committed") kobe = mirrored;
  });
  // The mirror catches up either way: its commit list, or Kaiju's copy when it was not written.
  ctx.deps.refreshMirror?.(ctx.req.owner.teamId, ctx.facts.repo.id);
  return {
    status: "pushed",
    branch,
    commitSha: commit,
    seq: kobe?.seq ?? null,
    commitId: kobe?.commitId ?? null,
  };
}

/** The member's open pull request from this working copy, when the next commit can join it. */
async function openBranch(ctx: Context, checkoutBase: string): Promise<BranchRow | undefined> {
  const row = ctx.facts.branch;
  if (!row || row.repositoryId !== ctx.facts.repo.id || row.baseCommitId !== checkoutBase) {
    return undefined;
  }
  try {
    const pr = await ctx.adapter.getPullRequest(ctx.repo.name, row.pullNumber);
    return pr.state === "open" ? row : undefined;
  } catch (err) {
    if (err instanceof GitHostError && err.code === "not_found") return undefined;
    throw err;
  }
}

async function pullRequestCommit(
  ctx: Context,
  changes: Changes,
  head: string,
  checkoutBase: string,
  fallback: boolean,
): Promise<CommitResult> {
  const open = await openBranch(ctx, checkoutBase);
  if (open) {
    // The open pull request's commits build on its own base, checked against Kaiju's base.
    const built = await buildTree(ctx, changes, open.baseSha);
    if (open.treeSha === built.tree) return { status: "nothing_to_commit" };
    const commit = await writeCommitObject(ctx, built.tree, open.headSha);
    await attempted(ctx, "pull_request", commit);
    const outcome = await push(ctx, open.branch, open.headSha, commit, built.objects);
    if (outcome.ok) {
      const what: Committed = {
        mode: "pull_request",
        commitSha: commit,
        number: open.pullNumber,
        url: open.pullUrl,
        opened: false,
        fallback,
      };
      await settle(ctx, what, () => record(ctx, { ...open, headSha: commit, treeSha: built.tree }));
      return {
        status: "pull_request",
        branch: open.branch,
        commitSha: commit,
        number: open.pullNumber,
        url: open.pullUrl,
        opened: false,
        fallback,
      };
    }
    const moved = outcome.stale || (await remoteHead(ctx, open.branch)) !== open.headSha;
    if (!moved) throw rejected(outcome.reason);
    // Someone moved the pull request's branch on the host: a new branch, never an overwrite.
  }
  const built = await buildTree(ctx, changes, head);
  const commit = await writeCommitObject(ctx, built.tree, head);
  const branch = pullRequestBranch(ctx.facts.user.name, ctx.req.message, commit);
  await attempted(ctx, "pull_request", commit);
  const outcome = await push(ctx, branch, null, commit, built.objects);
  if (!outcome.ok) throw rejected(outcome.reason);
  let created;
  try {
    created = await ctx.adapter.openPullRequest({
      repository: ctx.repo.name,
      title: pullRequestTitle(ctx.req.message),
      body: pullRequestBody({
        message: ctx.req.message,
        memberName: ctx.facts.user.name,
        publicUrl: ctx.deps.publicUrl,
        threadId: ctx.req.via?.threadId,
      }),
      head: branch,
      base: ctx.defaultBranch,
    });
  } catch (err) {
    if (err instanceof GitHostError) {
      throw stop(
        "repo_push_rejected",
        `The commit is on the branch ${branch}, but the git host did not open the pull request (${err.message}) Open it on the host.`,
      );
    }
    throw err;
  }
  const number = created.number ?? 0;
  if (number <= 0) {
    throw stop(
      "repo_push_rejected",
      `The commit is on the branch ${branch}, but the git host gave no pull request number. Open it on the host.`,
    );
  }
  const url = /^https?:\/\//.test(created.webUrl) ? created.webUrl : "";
  const what: Committed = {
    mode: "pull_request",
    commitSha: commit,
    number,
    url,
    opened: true,
    fallback,
  };
  await settle(ctx, what, () =>
    record(ctx, {
      repositoryId: ctx.facts.repo.id,
      baseCommitId: checkoutBase,
      baseSha: head,
      branch,
      headSha: commit,
      treeSha: built.tree,
      pullNumber: number,
      pullUrl: url,
    }),
  );
  return { status: "pull_request", branch, commitSha: commit, number, url, opened: true, fallback };
}

/** `git.repo.commit_attempted`, written before the push (review M3: the intent is on record). */
async function attempted(
  ctx: Context,
  mode: "pull_request" | "direct",
  commitSha: string,
): Promise<void> {
  const { teamId, userId } = ctx.req.owner;
  await withTeam(ctx.deps.commit.db, teamId, (tx) =>
    recordAudit(tx, {
      action: "git.repo.commit_attempted",
      actor: { kind: "user", id: userId },
      teamId,
      target: {
        projectId: ctx.req.projectId,
        repositoryId: ctx.facts.repo.id,
        connectionId: ctx.connection.id,
        mode,
        commitSha,
      },
      ...(ctx.req.via ? { via: ctx.req.via } : {}),
    }),
  );
}

interface Committed {
  readonly mode: "pull_request" | "direct";
  readonly commitSha: string;
  readonly number?: number;
  readonly url?: string;
  readonly opened?: boolean;
  readonly fallback: boolean;
}

const rejected = (reason: string | null): Stop =>
  stop(
    "repo_push_rejected",
    reason === null ? "The git host refused the push." : `The git host refused the push: ${reason}`,
  );

async function record(ctx: Context, row: BranchRow): Promise<void> {
  const { teamId, userId } = ctx.req.owner;
  await withTeam(ctx.deps.commit.db, teamId, (tx) =>
    saveBranch(tx, { teamId, projectId: ctx.req.projectId, userId }, row),
  );
  // A pull request push leaves the default branch alone; the mirror's next pass is enough.
  await ctx.deps
    .requestMirror?.(teamId, ctx.facts.repo.id)
    ?.catch((err: unknown) =>
      ctx.deps.commit.log.warn({ err }, "git mirror refresh not requested"),
    );
}

async function audited(ctx: Context, what: Committed): Promise<void> {
  const { teamId, userId } = ctx.req.owner;
  const { url, ...rest } = what;
  await withTeam(ctx.deps.commit.db, teamId, (tx) =>
    recordAudit(tx, {
      action: "git.repo.committed",
      actor: { kind: "user", id: userId },
      teamId,
      target: {
        projectId: ctx.req.projectId,
        repositoryId: ctx.facts.repo.id,
        connectionId: ctx.connection.id,
        hostRepoId: ctx.facts.repo.hostRepoId,
        ...rest,
        ...(url !== undefined && url.startsWith("https://") ? { url } : {}),
      },
      ...(ctx.req.via ? { via: ctx.req.via } : {}),
    }),
  );
}

interface FailureContext {
  readonly deps: RepoCommitDeps;
  readonly req: RepoCommitRequest;
  readonly facts: RepoCommitFacts;
  readonly connection: GitConnectionRecord;
}
const ctx0 = (
  deps: RepoCommitDeps,
  req: RepoCommitRequest,
  facts: RepoCommitFacts,
  connection: GitConnectionRecord,
): FailureContext => ({ deps, req, facts, connection });

/** `git.repo.commit_failed` for a refusal that reached the host; a failed audit is only logged. */
async function failed(f: FailureContext, failure: CommitRefusal): Promise<void> {
  const { teamId, userId } = f.req.owner;
  try {
    await withTeam(f.deps.commit.db, teamId, (tx) =>
      recordAudit(tx, {
        action: "git.repo.commit_failed",
        actor: { kind: "user", id: userId },
        teamId,
        target: {
          projectId: f.req.projectId,
          repositoryId: f.facts.repo.id,
          connectionId: f.connection.id,
          mode: f.connection.directCommits ? "direct" : "pull_request",
          failure,
        },
        ...(f.req.via ? { via: f.req.via } : {}),
      }),
    );
  } catch (err) {
    f.deps.commit.log.warn(
      { err, project_id: f.req.projectId },
      "git.repo.commit_failed not recorded",
    );
  }
}

/** A host failure as the member's refusal (fixed words; never the host's body). */
function hostStop(err: GitHostError): Stop {
  switch (err.code) {
    case "auth_failed":
      return stop("repo_unavailable", "The git host refused the Workspace's credential.");
    case "forbidden":
      return stop(
        "repo_unavailable",
        "The Workspace's credential may not write to this repository.",
      );
    case "rate_limited":
      return stop("repo_unavailable", "The git host is rate limiting Kaiju. Try again later.");
    case "not_found":
      return stop("repo_unavailable", "The repository is gone from the git host.");
    case "host_refused":
      return stop("repo_unavailable", "The Site does not allow this git host now.");
    case "invalid_request":
      return stop("repo_push_rejected", err.message);
    default:
      return stop("repo_unavailable", "The git host could not be reached. Try again.");
  }
}
