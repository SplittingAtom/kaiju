import type { Context } from "hono";
import { z } from "zod";
import { withTeam, type KobeTx } from "@kobe/db";
import { type TeamVariables } from "../../authz/middleware.js";
import type { ServerDeps } from "../../deps.js";
import { loadAccess, type ProjectAccess } from "../../projects/access.js";
import { type CommitDeps, type CommitResult } from "../../projects/commits.js";
import { REPO_REFUSAL_MESSAGES, type RepoCommitWiring } from "../../git/repo-commit/dispatch.js";
import { type ProposalResult } from "../../projects/from-proposal.js";
import { logger } from "../../logger.js";
import {
  PROJECT_WRITE_BLOCK_CODES,
  PROJECT_WRITE_BLOCK_MESSAGES,
} from "../../projects/repo-state.js";
import { DEFAULT_TEAM_MAX_OBJECTS, DEFAULT_UPLOAD_SETTINGS } from "../../uploads/settings.js";
import type { WorkspaceSync } from "../../workspace-sync/service.js";
import { param } from "../../http/request.js";

export type Ctx = Context<{ Variables: TeamVariables }>;
export type ProjectAction = "view" | "edit" | "manage";

export const idParam = z.uuid();
export const seqParam = z.coerce.number().int().positive().max(2_147_483_647);

export const fail = (c: Ctx, status: number, code: string, message: string, extra: object = {}) =>
  c.json({ code, message, ...extra }, status as 400);

export const notFound = (c: Ctx) =>
  fail(c, 404, "not_found", "No project with that id is available to you.");
export const forbidden = (c: Ctx) =>
  fail(c, 403, "forbidden", "Your project role doesn't allow that.");
export const noStorage = (c: Ctx) =>
  fail(c, 503, "storage_unavailable", "File storage is not available. Try again.");

/** A commit or revert outcome as the REST contract answers it (`project-commits.ts`). */
export function commitAnswer(
  c: Ctx,
  result: CommitResult | { status: "commit_not_found" },
): Response {
  switch (result.status) {
    case "committed":
      return c.json({ status: "committed", seq: result.seq, commit_id: result.commitId });
    case "nothing_to_commit":
      return c.json({ status: "nothing_to_commit" });
    case "commit_conflict":
      return fail(
        c,
        409,
        "commit_conflict",
        `The project moved on to #${result.headSeq} since you checked it out. Update, then commit again.`,
        { head_seq: result.headSeq },
      );
    case "commit_not_found":
      return fail(c, 404, "commit_not_found", "No such commit in this project (or it was pruned).");
    case "pull_request":
      return c.json({
        status: "pull_request",
        branch: result.branch,
        commit_sha: result.commitSha,
        number: result.number,
        url: result.url,
        opened: result.opened,
        fallback: result.fallback,
      });
    case "pushed":
      return c.json({
        status: "pushed",
        branch: result.branch,
        commit_sha: result.commitSha,
        seq: result.seq,
        commit_id: result.commitId,
      });
    case "refused":
      return refusal(c, result);
  }
}

export function refusal(c: Ctx, r: Extract<CommitResult, { status: "refused" }>): Response {
  const named = r.path === undefined ? "" : ` (${r.path})`;
  switch (r.error) {
    case "not_found":
      return notFound(c);
    case "forbidden":
      return forbidden(c);
    case "checkout_required":
      return fail(c, 409, "checkout_required", "Check the project out first.");
    case "archived":
      return fail(c, 409, "archived", "The project is archived.");
    case "too_many_files":
      return fail(c, 422, "invalid_input", "A project holds at most 500 files.");
    case "file_too_large":
      return fail(c, 413, "file_too_large", `A file is larger than a project file may be${named}.`);
    case "conflict_file":
      return fail(
        c,
        422,
        "invalid_input",
        `Resolve the conflict copy first: keep what you need and delete it${named}.`,
      );
    case "invalid_path":
      return fail(c, 422, "invalid_input", `A file name can't be used in a project${named}.`);
    case "quota_exceeded":
      return fail(
        c,
        507,
        "quota_exceeded",
        r.limit === "objects"
          ? "The commit would pass your workspace's object budget."
          : "The commit would pass your workspace's storage quota.",
        { limit: r.limit ?? "bytes" },
      );
    case "legal_hold":
      return fail(c, 409, "forbidden", "The workspace is under a legal hold: its files stay.");
    case "changed":
      c.header("Retry-After", "2");
      return fail(c, 503, "busy", "Your working copy changed while committing. Try again.");
    case "storage_failed":
      return noStorage(c);
    case "repo":
    case "converting":
      return fail(
        c,
        409,
        PROJECT_WRITE_BLOCK_CODES[r.error],
        PROJECT_WRITE_BLOCK_MESSAGES[r.error],
      );
    case "repo_moved":
    case "repo_unavailable":
    case "repo_push_rejected":
      return fail(c, 409, r.error, r.detail ?? REPO_REFUSAL_MESSAGES[r.error]);
  }
}

export const NOT_ALLOWED: Record<
  Extract<ProposalResult, { status: "not_allowed" }>["reason"],
  string
> = {
  moved: "The conversation is no longer in this project, so the edit can't be committed here.",
  no_edit_access: "You can no longer edit this project, so the edit can't be committed.",
  archived: "The project is archived.",
  not_a_project_proposal: "This proposal is for your own files; save it there instead.",
};

/** An accepted proposal's outcome as the REST contract answers it (`project-commits.ts`). */
export function proposalAnswer(c: Ctx, result: ProposalResult): Response {
  switch (result.status) {
    case "committed":
      return c.json({ status: "committed", seq: result.seq, commit_id: result.commitId });
    case "thread_not_found":
      return fail(c, 404, "thread_not_found", "No thread with that id.");
    case "proposal_not_found":
      return fail(c, 404, "proposal_not_found", "No such proposal in that conversation.");
    case "not_found":
      return notFound(c);
    case "stale":
      return fail(
        c,
        409,
        "proposal_stale",
        "This file changed after the agent proposed the edit. Ask it to propose again.",
        { head_seq: result.headSeq },
      );
    case "not_allowed":
      return fail(c, 409, "proposal_not_allowed", NOT_ALLOWED[result.reason], {
        reason: result.reason,
      });
    case "quota_exceeded":
      return refusal(c, { status: "refused", error: "quota_exceeded", limit: result.limit });
    case "refused":
      return refusal(c, { status: "refused", error: result.error });
    case "blocked":
      return refusal(c, { status: "refused", error: result.block });
  }
}

export type CommitKit = ReturnType<typeof commitKit>;

/** What the commit route groups share: the caller, upload settings, commit deps and access. */
export function commitKit(deps: ServerDeps, sync: WorkspaceSync | undefined) {
  const db = deps.database.db;
  const owner = (c: Ctx) => ({ teamId: c.get("team").id, userId: c.get("user").id });
  const settings = () => deps.uploads ?? DEFAULT_UPLOAD_SETTINGS;
  /** KOBE-767: what a commit to a Repo needs besides the commit deps (read on use). */
  const repoCommit = (): RepoCommitWiring => ({
    envelope: deps.envelope,
    net: deps.gitHostNet,
    publicUrl: deps.publicUrl,
  });
  const commitDeps = (): CommitDeps => ({
    db,
    blobs: deps.blobs,
    mounts: deps.projectMounts,
    limits: {
      quotaDefaultBytes: settings().defaultQuotaBytes,
      maxObjectsDefault: settings().defaultMaxObjects ?? DEFAULT_TEAM_MAX_OBJECTS,
      maxFileBytes: settings().maxFileBytes,
    },
    log: logger,
  });

  const withProject = async (
    c: Ctx,
    action: ProjectAction,
    fn: (tx: KobeTx, access: ProjectAccess) => Promise<Response>,
    lock = false,
  ): Promise<Response> => {
    const id = param(c, "id", idParam);
    if (!id.success) return notFound(c);
    return withTeam(db, c.get("team").id, async (tx) => {
      const access = await loadAccess(tx, owner(c), id.data, { lock });
      if (!access) return notFound(c);
      if (!access.can[action]) return forbidden(c);
      return fn(tx, access);
    });
  };

  return { deps, db, sync, owner, settings, commitDeps, repoCommit, withProject };
}
