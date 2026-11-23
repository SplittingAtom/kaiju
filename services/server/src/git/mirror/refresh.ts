import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
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
import type { GitMirrorFailure } from "@kobe/protocol";
import type { Logger } from "pino";
import { GitHostError, type GitHostAdapter } from "../../git-hosts/adapter.js";
import { gitHostAdapter, type GitAdapterInput } from "../../git-hosts/factory.js";
import { gitWireSession } from "../../git-hosts/git-wire.js";
import type { GitHostNet } from "../../git-hosts/http.js";
import { gitHostTarget, type GitHostTarget } from "../../git-hosts/target.js";
import { GIT_CONNECTION_READS_PER_HOUR } from "../../git-tools/execute.js";
import type { MirrorFetchLimits } from "../repo-limits.js";
import { mimeForName } from "../../projects/import.js";
import {
  projectBlobKey,
  queueProjectBlobs,
  type Tree,
  type TreeFile,
} from "../../projects/tree.js";
import { checkRateLimit } from "../../rate-limit.js";
import type { BlobStore } from "../../retention/blobs.js";
import { resolveMime, SNIFF_BYTES } from "../../uploads/mime.js";
import { applyMirror, MirrorHeld } from "./apply.js";
import { fetchBranch, MirrorError, remoteHead, type FetchedBranch } from "./fetch.js";
import {
  GIT_MIRROR_DEADLINE_MS,
  GIT_MIRROR_DIR_NAME,
  GIT_MIRROR_DISK_MARGIN_BYTES,
  GIT_MIRROR_GONE_CONFIRMATIONS,
  GIT_MIRROR_LIMITS,
  GIT_MIRROR_TOO_LARGE_RECHECK_MS,
  GIT_MIRROR_RUN_MS,
  GIT_MIRROR_SIZE_HINT_MARGIN,
  GIT_MIRROR_SLOTS,
  GIT_MIRROR_TOO_LARGE_CODES,
  GIT_MIRROR_WORK_PREFIX,
  mirrorBackoffMs,
} from "./limits.js";
import {
  claimRefresh,
  MirrorLeaseLost,
  recordFailure,
  recordHostFacts,
  recordSuccess,
  releaseLease,
  underLease,
  type MirrorLease,
  type MirrorRow,
} from "./store.js";

/**
 * One refresh of a Repo's mirror (KOBE-766, spec workspace-git G17, G20), on the replica that
 * claimed it (a lease on the repository row). In order, with no transaction open during a host
 * call:
 *
 * 1. the connection's hourly read budget (the one agents' git tools share, 3,000 an hour): a
 *    refresh takes one read; refused, it waits for the window without counting as a failure;
 * 2. the connection, the Site's decision and the credential, opened for this refresh only;
 * 3. the repository by the host's id (G20: a rename or transfer is followed; not found marks it
 *    `deleted`, archived marks it `archived`; the Repo is then read-only from its last mirror);
 * 4. the head of its default branch (one `info/refs`): unchanged, the refresh ends here;
 * 5. otherwise a shallow fetch into a work folder, every object's size checked before it is
 *    read, the files hashed and new content stored under the project's content-addressed keys
 *    (reserved first, so an interrupted refresh leaves nothing behind), then one transaction
 *    writes the mirror ({@link applyMirror}).
 *
 * A failure keeps the last mirror, records a code and backs off (doubling from 5 minutes to 6
 * hours, or until the host's rate-limit reset). Reads never wait for a refresh.
 */
export interface MirrorDeps {
  readonly db: KobeDb;
  readonly envelope: Envelope | undefined;
  readonly net: GitHostNet;
  readonly blobs: BlobStore | undefined;
  readonly log: Pick<Logger, "info" | "warn" | "error">;
  /** Tests: a fake adapter. */
  readonly adapterFor?: (input: GitAdapterInput) => GitHostAdapter;
  /** Tests: concurrent refreshes per replica. */
  readonly slots?: number;
  /** Tests: scaled-down sizes (derived with `mirrorFetchLimits` from scaled Repo limits). */
  readonly limits?: MirrorFetchLimits;
}

export type RefreshOutcome =
  "refreshed" | "unchanged" | "deleted" | "read_only" | "deferred" | "failed" | "busy" | "gone";

/** A refresh (or relink) that stops with a failure code. */
export class MirrorStop extends Error {
  constructor(readonly code: GitMirrorFailure) {
    super(`git mirror: ${code}`);
    this.name = "MirrorStop";
  }
}

/** The connection's budget is used up: try after `retryAfterSeconds`, not a failure. */
class MirrorDeferred extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("git mirror: connection budget");
    this.name = "MirrorDeferred";
  }
}

const CONNECTION_READ_RULE = { windowMs: 60 * 60_000, max: GIT_CONNECTION_READS_PER_HOUR } as const;

let running = 0;

/** Refreshes this process runs now (tests). */
export const runningRefreshes = (): number => running;

export async function refreshRepository(
  deps: MirrorDeps,
  teamId: string,
  repositoryId: string,
): Promise<RefreshOutcome> {
  if (running >= (deps.slots ?? GIT_MIRROR_SLOTS)) return "busy";
  running += 1;
  try {
    const owner = randomUUID();
    const claimed = await claimRefresh(deps.db, teamId, repositoryId, owner);
    if (claimed === "busy") return "busy";
    const lease: MirrorLease = { teamId, id: repositoryId, owner };
    let workDir: string | undefined;
    try {
      const root = path.join(tmpdir(), GIT_MIRROR_DIR_NAME);
      await mkdir(root, { recursive: true, mode: 0o700 });
      workDir = await mkdtemp(path.join(root, GIT_MIRROR_WORK_PREFIX));
      return await run(deps, lease, claimed, workDir);
    } catch (err) {
      if (err instanceof MirrorLeaseLost) return "gone";
      return await fail(deps, lease, claimed, err);
    } finally {
      if (workDir !== undefined)
        await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  } finally {
    running -= 1;
  }
}

/** The code, whether it counts towards the back-off, and the earliest next try. */
export function failureOf(
  err: unknown,
  failures: number,
  now = Date.now(),
): { code: GitMirrorFailure; counts: boolean; nextAt: Date } {
  if (err instanceof MirrorDeferred) {
    return {
      code: "connection_budget",
      counts: false,
      nextAt: new Date(now + err.retryAfterSeconds * 1000),
    };
  }
  const backoff = new Date(now + mirrorBackoffMs(failures + 1));
  const at = (code: GitMirrorFailure, until?: Date) => ({
    code,
    counts: true,
    nextAt: until && until > backoff ? until : backoff,
  });
  if (err instanceof MirrorStop) return at(err.code);
  if (err instanceof MirrorError) {
    // Review R4-M1: too large is not transient; tried again slowly (it may shrink).
    if (GIT_MIRROR_TOO_LARGE_CODES.has(err.code))
      return at(err.code, new Date(now + GIT_MIRROR_TOO_LARGE_RECHECK_MS));
    return at(err.code);
  }
  if (err instanceof MirrorHeld) return at("legal_hold");
  if (err instanceof GitHostError) {
    switch (err.code) {
      case "auth_failed":
        return at("credential_rejected");
      case "forbidden":
        return at("credential_forbidden");
      case "rate_limited":
        return at("host_rate_limited", err.resetAt);
      case "host_unreachable":
        return at("host_unreachable");
      case "host_refused":
      case "unsupported_host":
        return at("host_not_allowed");
      default:
        return at("fetch_failed");
    }
  }
  return at("internal_error");
}

async function fail(
  deps: MirrorDeps,
  lease: MirrorLease,
  row: MirrorRow,
  err: unknown,
): Promise<RefreshOutcome> {
  const { code, counts, nextAt } = failureOf(err, row.mirrorFailures);
  const log = code === "internal_error" ? deps.log.error : deps.log.warn;
  log.call(
    deps.log,
    { err, team_id: lease.teamId, repository_id: lease.id, failure: code },
    "git mirror refresh failed",
  );
  await recordFailure(deps.db, lease, row, code, nextAt, counts);
  return counts ? "failed" : "deferred";
}

export interface Opened {
  readonly adapter: GitHostAdapter;
  readonly target: GitHostTarget;
  readonly connection: GitConnectionRecord;
}

/**
 * A connection's adapter for one operation: the connection, the Site's decision and the opened
 * credential (never kept), or `removed`. Throws a {@link MirrorStop} with the reason it cannot.
 */
export async function openConnection(
  deps: Pick<MirrorDeps, "db" | "envelope" | "net" | "adapterFor">,
  teamId: string,
  connectionId: string | null,
): Promise<Opened | "removed"> {
  if (connectionId === null) return "removed";
  if (!deps.envelope) throw new MirrorStop("git_unavailable");
  const { connection, sealed } = await withTeam(deps.db, teamId, async (tx) => ({
    connection: await readGitConnection(tx, teamId, connectionId),
    sealed: await readGitConnectionSealedCredential(tx, teamId, connectionId),
  }));
  if (!connection || !sealed) return "removed";
  if (connection.accessLevel === "off") throw new MirrorStop("connection_off");
  let target: GitHostTarget;
  try {
    target = gitHostTarget(await readGitSiteSettings(deps.db), connection.baseUrl, {
      allowHttp: deps.net.policy.allowHttp,
    });
  } catch {
    throw new MirrorStop("host_not_allowed");
  }
  let secret;
  try {
    secret = openGitCredential(
      deps.envelope,
      { teamId, connectionId },
      sealed.credentialSealed,
      sealed.credentialKind,
    );
  } catch {
    throw new MirrorStop("credential_unavailable");
  }
  const adapter = (deps.adapterFor ?? gitHostAdapter)({
    connection,
    secret,
    target,
    net: deps.net,
  });
  return { adapter, target, connection };
}

async function run(
  deps: MirrorDeps,
  lease: MirrorLease,
  claimed: MirrorRow,
  workDir: string,
): Promise<RefreshOutcome> {
  // Review M1: the whole run, local work included, ends well before the lease lapses.
  const deadlineAt = Date.now() + GIT_MIRROR_RUN_MS;
  const limits = deps.limits ?? GIT_MIRROR_LIMITS;
  const budget = claimed.connectionId
    ? await checkRateLimit(
        deps.db,
        `git-tools:connection:read:${claimed.connectionId}`,
        CONNECTION_READ_RULE,
      )
    : { allowed: true, retryAfterSeconds: 0 };
  if (!budget.allowed) throw new MirrorDeferred(budget.retryAfterSeconds);
  if (!deps.blobs) throw new MirrorStop("git_unavailable");
  const opened = await openConnection(deps, claimed.teamId, claimed.connectionId);
  if (opened !== "removed" && opened.connection.baseUrl !== claimed.baseUrl) {
    throw new MirrorStop("host_not_allowed");
  }
  if (opened === "removed") {
    // G20: the connection is gone; the Repo stays readable from its last mirror.
    await withTeam(deps.db, lease.teamId, (tx) =>
      underLease(tx, lease, async () => {
        await recordHostFacts(tx, claimed, {
          fullName: claimed.fullName,
          defaultBranch: claimed.defaultBranch,
          hostState: "unreachable",
        });
        await releaseLease(tx, lease);
      }),
    );
    return "read_only";
  }
  const { adapter, target } = opened;
  let repo;
  try {
    repo = await adapter.getRepository({ id: claimed.hostRepoId });
  } catch (err) {
    if (!(err instanceof GitHostError) || err.code !== "not_found") throw err;
    // Review M2: "not found" can also mean "no longer visible to this credential" (a narrowed
    // App installation or token). Only several answers in a row, spread by the back-off, mark the
    // Repo deleted; until then it is a failure like any other. A Repo already deleted stays so.
    const inARow = claimed.mirrorError === "repository_not_found" ? claimed.mirrorFailures + 1 : 1;
    if (claimed.hostState !== "deleted" && inARow < GIT_MIRROR_GONE_CONFIRMATIONS) {
      throw new MirrorStop("repository_not_found");
    }
    await withTeam(deps.db, lease.teamId, (tx) =>
      underLease(tx, lease, async () => {
        await recordHostFacts(tx, claimed, {
          fullName: claimed.fullName,
          defaultBranch: claimed.defaultBranch,
          hostState: "deleted",
        });
        await releaseLease(tx, lease);
      }),
    );
    return "deleted";
  }
  const row: MirrorRow = {
    ...claimed,
    fullName: repo.fullName,
    defaultBranch: repo.defaultBranch ?? claimed.defaultBranch,
    hostState: repo.archived ? "archived" : "active",
  };
  await withTeam(deps.db, lease.teamId, (tx) =>
    underLease(tx, lease, () =>
      recordHostFacts(tx, claimed, {
        fullName: row.fullName,
        defaultBranch: row.defaultBranch,
        hostState: row.hostState,
        isPrivate: repo.visibility !== "public",
      }),
    ),
  );
  // KOBE-818: a Repo already too large to mirror is not downloaded again while the host (an
  // untrusted hint) still reports it far over the limit. It stays too large, with the same
  // failure, and is checked again on the usual slow timer.
  if (
    claimed.mirrorError !== null &&
    GIT_MIRROR_TOO_LARGE_CODES.has(claimed.mirrorError) &&
    repo.sizeKb !== undefined &&
    repo.sizeKb * 1024 > limits.maxPackBytes * GIT_MIRROR_SIZE_HINT_MARGIN
  ) {
    throw new MirrorError(claimed.mirrorError as MirrorError["code"]);
  }
  const credential = await adapter.repositoryCredential(repo.name, "read");
  const session = gitWireSession({
    net: deps.net,
    target,
    repositoryUrl: repo.cloneUrl,
    credential: { username: credential.username, password: credential.password },
    maxRequestBytes: 1024 * 1024,
    // The pack's own cap (pack-unpack.ts) trips first and says "too large"; this is a backstop.
    maxResponseBytes: limits.maxPackBytes + 1024 * 1024,
    deadlineAt: Math.min(Date.now() + GIT_MIRROR_DEADLINE_MS, deadlineAt),
  });
  const remote = await remoteHead(session.http, repo.cloneUrl, row.defaultBranch);
  const head = remote.head;
  if (head === null) throw new MirrorError("branch_missing");
  if (head === claimed.mirrorHeadSha) {
    await withTeam(deps.db, lease.teamId, (tx) =>
      underLease(tx, lease, () => recordSuccess(tx, lease, { headSha: head })),
    );
    return "unchanged";
  }
  await assertRoom(workDir, limits.maxDiskBytes);
  const project = await projectSlug(deps.db, row);
  const fetched = await fetchBranch(
    session.http,
    repo.cloneUrl,
    { ...remote, head },
    path.join(workDir, "repo"),
    {
      maxFiles: limits.maxFiles,
      maxFileBytes: limits.maxFileBytes,
      maxTotalBytes: limits.maxInflatedBytes,
      maxDiskBytes: limits.maxDiskBytes,
      maxPackBytes: limits.maxPackBytes,
      slug: project,
      deadlineAt,
    },
  );
  const tree = await storeFiles(deps, deps.blobs, row, fetched, deadlineAt, limits.maxContentBytes);
  const applied = await applyMirror(deps.db, lease, row, {
    head: fetched.head,
    tree,
    commits: fetched.commits,
    skipped: fetched.skipped,
  });
  return applied.kind === "gone" ? "gone" : "refreshed";
}

async function projectSlug(db: KobeDb, row: MirrorRow): Promise<string> {
  const res = await withTeam(db, row.teamId, (tx) =>
    tx.execute<{ slug: string }>(sql`
      SELECT slug FROM projects WHERE team_id = ${row.teamId} AND id = ${row.projectId}`),
  );
  const slug = res.rows[0]?.slug;
  if (slug === undefined) throw new MirrorLeaseLost();
  return slug;
}

/** Refuses to fetch when the work folder's file system has no room for the largest pack. */
async function assertRoom(dir: string, budget: number): Promise<void> {
  const fsStats = await statfs(dir).catch(() => undefined);
  const free = fsStats ? Number(fsStats.bavail) * Number(fsStats.bsize) : 0;
  // The refresh's disk budget (pack plus loose objects, enforced as they are written). On an
  // emptyDir this sees the node's file system; the budget itself keeps /tmp within its limit.
  if (free < budget + GIT_MIRROR_DISK_MARGIN_BYTES) {
    throw new MirrorError("server_capacity");
  }
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

interface Hashed {
  readonly path: string;
  readonly oid: string;
  readonly sha256: string;
  readonly size: number;
  readonly mime: string;
  readonly executable: boolean;
}

/**
 * The head's files as a project tree: content the project already holds keeps its key; new
 * content is reserved for the blob deleter first (6 hours: a refresh that stops before writing
 * leaves nothing behind for long), then stored under the project's content-addressed key.
 */
async function storeFiles(
  deps: MirrorDeps,
  blobs: BlobStore,
  row: MirrorRow,
  fetched: FetchedBranch,
  deadlineAt: number,
  maxContentBytes: number,
): Promise<Tree> {
  const tooLong = () => {
    if (Date.now() > deadlineAt) {
      throw new GitHostError("host_unreachable", "The refresh took too long.");
    }
  };
  const hashed: Hashed[] = [];
  let total = 0;
  for (const f of fetched.files) {
    tooLong();
    const bytes = await fetched.readBlob(f.oid);
    total += bytes.length;
    if (total > maxContentBytes) {
      throw new MirrorError("repository_too_large", String(maxContentBytes));
    }
    const name = f.path.slice(f.path.lastIndexOf("/") + 1);
    hashed.push({
      path: f.path,
      oid: f.oid,
      sha256: sha256(bytes),
      size: bytes.length,
      mime: resolveMime(bytes.subarray(0, SNIFF_BYTES), mimeForName(name)),
      executable: f.executable,
    });
  }
  const held = await withTeam(deps.db, row.teamId, async (tx) => {
    const res = await tx.execute<{ sha256: string; blob_ref: string }>(sql`
      SELECT DISTINCT ON (sha256) sha256, blob_ref FROM (
        SELECT e.sha256, e.blob_ref FROM project_tree_entries e
          JOIN project_commits c ON c.team_id = e.team_id AND c.id = e.commit_id
         WHERE e.team_id = ${row.teamId} AND c.project_id = ${row.projectId}
        UNION ALL
        SELECT sha256, blob_ref FROM project_files
         WHERE team_id = ${row.teamId} AND project_id = ${row.projectId}) h
       ORDER BY sha256, blob_ref`);
    return new Map(res.rows.map((r) => [r.sha256, r.blob_ref]));
  });
  const fresh = new Map<string, Hashed>();
  for (const h of hashed) if (!held.has(h.sha256)) fresh.set(h.sha256, h);
  const keyOf = (digest: string) =>
    held.get(digest) ?? projectBlobKey(blobs.prefix, row.teamId, row.projectId, digest);
  if (fresh.size > 0) {
    await withTeam(deps.db, row.teamId, (tx) =>
      queueProjectBlobs(
        tx,
        row.teamId,
        row.projectId,
        row.createdBy,
        [...fresh.keys()].map(keyOf),
        "reservation",
      ),
    );
    for (const h of fresh.values()) {
      tooLong();
      const bytes = await fetched.readBlob(h.oid);
      await blobs.objects.put(keyOf(h.sha256), Readable.from([Buffer.from(bytes)]), h.size);
    }
  }
  const tree = new Map<string, TreeFile>();
  for (const h of hashed) {
    tree.set(h.path, {
      path: h.path,
      sha256: h.sha256,
      blobRef: keyOf(h.sha256),
      size: h.size,
      mime: h.mime,
      executable: h.executable,
    });
  }
  return tree;
}
