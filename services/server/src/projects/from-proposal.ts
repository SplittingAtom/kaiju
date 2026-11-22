import { fireAndLog } from "../async-util.js";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { sql, withTeam, type KobeTx } from "@kobe/db";
import {
  fileEditProposedPayloadSchema,
  PROJECT_FILE_MAX_BYTES,
  PROJECT_FILES_MAX,
  type FileEditProposedPayload,
  type ProposalNotAllowedError,
} from "@kobe/protocol";
import { resolveMime, SNIFF_BYTES } from "../uploads/mime.js";
import { verifyingStream, type ObjectStore } from "../workspace-sync/object-store.js";
import type { WorkspaceOwner } from "../workspace-sync/keys.js";
import { loadAccess } from "./access.js";
import { heldContents, type CommitDeps } from "./commits.js";
import { copyThenWrite, type Copy } from "./copy-loop.js";
import { clashesInTree, fitsMount, isConflictCopy } from "./paths.js";
import { checkLimitsAfterWrite, OverLimit } from "./storage.js";
import {
  headOf,
  loadTree,
  projectBlobKey,
  writeCommit,
  type Head,
  type Tree,
  type TreeFile,
} from "./tree.js";

/**
 * Accept commits an agent's proposal (KOBE-591, projects-in-conversations PE4-PE6). The thread's
 * owner accepts a `file.edit_proposed` event for a file of the conversation's project; the server
 * commits exactly the recorded content (never bytes from the request) as a new head whose tree is
 * the head tree with that one file replaced or added (CM1 snapshot). Three steps, as CM5, so no
 * transaction is held while bytes move:
 *  1. inspect (read): the thread is the caller's, the proposal is in it, the project is the
 *     proposal's and still the conversation's, the caller may edit it now, the head still has the
 *     proposal's base (`proposal_stale`), the limits;
 *  2. store (no transaction): the content goes to `teams/<t>/projects/<p>/blobs/<sha256>` through a
 *     hash and size check, the key reserved in `retention_blob_deletions` first; skipped when the
 *     project already holds that content;
 *  3. write (project row lock): inspect again, the team quota under its lock, the commit
 *     (`author_kind user`, the accepting member, with the proposal's thread and run, message = the
 *     edited message or the proposal's summary), audited `project.committed` with
 *     `source: "proposal"`.
 * Mounted members are reconciled after the transaction (CM9). Idempotent on the proposal: a
 * commit by this member's acceptance of it (same run and thread, that path from the base to the
 * proposed content) answers again as committed. Legal holds never block it (a commit deletes no
 * `project_files` row here).
 */

export interface ProposalRequest {
  readonly owner: WorkspaceOwner;
  readonly projectId: string;
  readonly threadId: string;
  readonly proposalId: string;
  readonly message?: string | undefined;
}

export type NotAllowedReason = ProposalNotAllowedError["reason"];

export type ProposalResult =
  | { readonly status: "committed"; readonly seq: number; readonly commitId: string }
  | { readonly status: "thread_not_found" | "proposal_not_found" | "not_found" }
  | { readonly status: "stale"; readonly headSeq: number }
  | { readonly status: "not_allowed"; readonly reason: NotAllowedReason }
  | {
      readonly status: "refused";
      readonly error: "too_many_files" | "file_too_large" | "invalid_path" | "storage_failed";
    }
  | { readonly status: "quota_exceeded"; readonly limit: "bytes" | "objects" };

interface Plan {
  readonly runId: string;
  readonly proposal: FileEditProposedPayload;
  readonly rel: string;
  readonly content: Buffer;
  readonly sha256: string;
  readonly head: Head | null;
  readonly tree: Tree;
  readonly executable: boolean;
  /** The project's existing object for this content, if it holds one. */
  readonly held: { readonly blobRef: string; readonly mime: string } | undefined;
  readonly key: string;
}

type Deps = Pick<CommitDeps, "db" | "blobs" | "limits" | "mounts" | "log">;

/** `projects/<slug>/<rest>` -> `<rest>` (the slug may have changed since; the project id decides). */
function relativePath(path: string): string | undefined {
  const parts = path.split("/");
  if (parts[0] !== "projects" || parts.length < 3) return undefined;
  return parts.slice(2).join("/");
}

async function findProposal(
  tx: KobeTx,
  teamId: string,
  threadId: string,
  proposalId: string,
): Promise<{ runId: string; proposal: FileEditProposedPayload } | undefined> {
  const res = await tx.execute<{ run_id: string; payload: unknown }>(sql`
    SELECT e.run_id, e.payload FROM run_events e
      JOIN runs r ON r.team_id = e.team_id AND r.id = e.run_id
     WHERE e.team_id = ${teamId} AND r.team_id = ${teamId} AND r.thread_id = ${threadId}
       AND e.type = 'file.edit_proposed' AND e.payload->>'proposal_id' = ${proposalId}
     ORDER BY e.created_at, e.seq
     LIMIT 1`);
  const row = res.rows[0];
  if (!row) return undefined;
  const parsed = fileEditProposedPayloadSchema.safeParse(row.payload);
  return parsed.success ? { runId: row.run_id, proposal: parsed.data } : undefined;
}

/** The commit an earlier accept of this proposal wrote, if any (idempotency without a column). */
async function acceptedBefore(
  tx: KobeTx,
  teamId: string,
  projectId: string,
  req: ProposalRequest,
  runId: string,
  rel: string,
  sha256: string,
  base: string | undefined,
): Promise<{ seq: number; commitId: string } | undefined> {
  const res = await tx.execute<{ id: string; seq: number }>(sql`
    SELECT c.id, c.seq FROM project_commits c
      JOIN project_tree_entries e
        ON e.team_id = c.team_id AND e.commit_id = c.id AND e.path = ${rel} AND e.sha256 = ${sha256}
      LEFT JOIN project_tree_entries pe
        ON pe.team_id = c.team_id AND pe.commit_id = c.parent_id AND pe.path = ${rel}
     WHERE c.team_id = ${teamId} AND c.project_id = ${projectId} AND c.run_id = ${runId}
       AND c.thread_id = ${req.threadId} AND c.author_kind = 'user'
       AND c.author_user_id = ${req.owner.userId}
       AND pe.sha256 IS NOT DISTINCT FROM ${base ?? null}
     ORDER BY c.seq
     LIMIT 1`);
  const row = res.rows[0];
  return row ? { seq: Number(row.seq), commitId: row.id } : undefined;
}

/** Steps 1 and 3 (with `lock`): see the module header. */
async function inspect(
  tx: KobeTx,
  deps: Pick<Deps, "blobs" | "limits">,
  req: ProposalRequest,
  lock: boolean,
): Promise<Plan | ProposalResult> {
  const { teamId, userId } = req.owner;
  const thread = await tx.execute<{ owner_user_id: string; project_id: string | null }>(sql`
    SELECT owner_user_id, project_id FROM threads
     WHERE team_id = ${teamId} AND id = ${req.threadId} AND deleted_at IS NULL`);
  const t = thread.rows[0];
  // Owner only (PE6): a shared reader of the thread never accepts; same answer as no thread.
  if (t?.owner_user_id !== userId) return { status: "thread_not_found" };
  const found = await findProposal(tx, teamId, req.threadId, req.proposalId);
  if (!found) return { status: "proposal_not_found" };
  const access = await loadAccess(tx, req.owner, req.projectId, { lock });
  if (!access) return { status: "not_found" };
  const { proposal, runId } = found;
  const rel = proposal.project_id === undefined ? undefined : relativePath(proposal.path);
  if (proposal.project_id === undefined || rel === undefined) {
    return { status: "not_allowed", reason: "not_a_project_proposal" };
  }
  if (proposal.project_id !== req.projectId) return { status: "not_allowed", reason: "moved" };
  const content = Buffer.from(proposal.content, "utf8");
  const sha256 = createHash("sha256").update(content).digest("hex");
  const done = await acceptedBefore(
    tx,
    teamId,
    req.projectId,
    req,
    runId,
    rel,
    sha256,
    proposal.base_sha256,
  );
  if (done) return { status: "committed", ...done };
  if (t.project_id !== req.projectId) return { status: "not_allowed", reason: "moved" };
  if (!access.can.edit) return { status: "not_allowed", reason: "no_edit_access" };
  if (access.project.archivedAt !== null) return { status: "not_allowed", reason: "archived" };
  const head = await headOf(tx, teamId, req.projectId);
  const tree = await loadTree(tx, teamId, head?.id ?? null);
  const current = tree.get(rel);
  if (current?.sha256 !== proposal.base_sha256) {
    return { status: "stale", headSeq: head?.seq ?? Math.max(1, proposal.base_commit_seq ?? 1) };
  }
  if (current === undefined) {
    if (tree.size >= PROJECT_FILES_MAX) return { status: "refused", error: "too_many_files" };
    if (isConflictCopy(rel) || clashesInTree(tree, rel) || !fitsMount(access.project.slug, rel)) {
      return { status: "refused", error: "invalid_path" };
    }
  }
  if (content.length > Math.min(PROJECT_FILE_MAX_BYTES, deps.limits.maxFileBytes)) {
    return { status: "refused", error: "file_too_large" };
  }
  const held = (await heldContents(tx, teamId, req.projectId, [sha256])).get(sha256);
  return {
    runId,
    proposal,
    rel,
    content,
    sha256,
    head,
    tree,
    executable: current?.executable ?? false,
    held,
    key: projectBlobKey(deps.blobs?.prefix ?? "", teamId, req.projectId, sha256),
  };
}

const isPlan = (p: Plan | ProposalResult): p is Plan => "rel" in p;

/** Step 2: the recorded bytes to their content-addressed key, hash and size checked. */
const store =
  (objects: ObjectStore) =>
  async (copy: Copy, plan: Plan): Promise<string> => {
    const verified = verifyingStream(plan.sha256, plan.content.length);
    Readable.from([plan.content]).pipe(verified);
    await objects.put(copy.key, verified, plan.content.length);
    return resolveMime(plan.content.subarray(0, SNIFF_BYTES), "text/plain");
  };

async function write(
  deps: Deps,
  req: ProposalRequest,
  mimes: ReadonlyMap<string, string>,
): Promise<ProposalResult | "again"> {
  const { teamId } = req.owner;
  return withTeam(deps.db, teamId, async (tx) => {
    const plan = await inspect(tx, deps, req, true);
    if (!isPlan(plan)) return plan;
    const mime = mimes.get(plan.sha256);
    if (!plan.held && mime === undefined) return "again";
    const newObjects = plan.held ? 0 : 1;
    const file: TreeFile = {
      path: plan.rel,
      sha256: plan.sha256,
      blobRef: plan.held?.blobRef ?? plan.key,
      size: plan.content.length,
      mime: plan.held?.mime ?? mime ?? "text/plain",
      executable: plan.executable,
    };
    const tree = new Map(plan.tree);
    tree.set(plan.rel, file);
    try {
      const written = await tx.transaction(async (sp) => {
        const commit = await writeCommit(sp, {
          teamId,
          projectId: req.projectId,
          tree,
          author: {
            userId: req.owner.userId,
            kind: "user",
            threadId: req.threadId,
            runId: plan.runId,
            proposalId: req.proposalId,
          },
          message: req.message ?? plan.proposal.summary,
        });
        // The team quota under its lock, after the history aggregate (P2-44).
        await checkLimitsAfterWrite(sp, teamId, deps.limits, {
          bytes: newObjects * plan.content.length,
          objects: newObjects,
        });
        return commit;
      });
      return { status: "committed", seq: written.seq, commitId: written.commitId };
    } catch (err) {
      if (err instanceof OverLimit) return { status: "quota_exceeded", limit: err.limit };
      throw err;
    }
  });
}

/** Accepts a proposal: see the module header. */
export async function commitProposal(deps: Deps, req: ProposalRequest): Promise<ProposalResult> {
  const written = await copyThenWrite<Plan, ProposalResult>({
    db: deps.db,
    teamId: req.owner.teamId,
    projectId: req.projectId,
    userId: req.owner.userId,
    limits: deps.limits,
    log: deps.log,
    failure: "proposal commit: storing failed",
    plan: () => withTeam(deps.db, req.owner.teamId, (tx) => inspect(tx, deps, req, false)),
    isPlan,
    copiesOf: (plan) =>
      plan.held
        ? []
        : [{ sha256: plan.sha256, size: plan.content.length, source: "", key: plan.key }],
    store: deps.blobs ? store(deps.blobs.objects) : undefined,
    write: (mimes) => write(deps, req, mimes),
    refuse: {
      quota: (limit) => ({ status: "quota_exceeded", limit }),
      storage: () => ({ status: "refused", error: "storage_failed" }),
      // Kept as before the shared loop (KOBE-780 P2-45 is a pure refactor).
      changed: () => ({ status: "refused", error: "storage_failed" }),
    },
  });
  if (written.status === "committed") {
    fireAndLog(
      deps.log,
      "project mount reconcile",
      deps.mounts?.reconcileProject(req.owner.teamId, req.projectId),
      { team_id: req.owner.teamId, project_id: req.projectId },
    );
  }
  return written;
}
