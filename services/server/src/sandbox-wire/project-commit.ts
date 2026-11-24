import { type ServerToSandboxFrame, type ProjectCommitFrame } from "@kobe/protocol/sandbox-wire";
import {
  APPROVAL_TTL_MS,
  CAPABILITY_PROJECTS,
  CAPABILITY_REPO_COMMITS,
  type PolicyDecision,
  type ProjectCommitOutcome,
} from "@kobe/protocol";
import { sql, withTeam } from "@kobe/db";
import type { Logger } from "pino";
import { approvalHolds, noPromptCode, recordDeniedWrite } from "../approvals/server-write.js";
import type { ApprovalVerifier } from "../approvals/verify.js";
import { loadAccess } from "../projects/access.js";
import { type CommitDeps, type CommitResult } from "../projects/commits.js";
import {
  commitProject,
  previewProjectCommit,
  REPO_REFUSAL_MESSAGES,
  type RepoCommitWiring,
} from "../git/repo-commit/dispatch.js";
import type { ToolFrameSpec } from "./gated-frame.js";
import type { ApprovalBroker, SandboxTarget } from "./types.js";
import { PROJECT_WRITE_BLOCK_MESSAGES } from "../projects/repo-state.js";

/**
 * `project.commit` (KOBE-579, Workspaces CM6) on one connection: the agent's `commit_project`.
 * The sandbox pushed its working copy first; nothing it says about the files is trusted. Accepted
 * only if the connection announced `projects`, the run is leased here and active, and the policy
 * check allowed this exact call (input hash, D-3). Then, from the database: the run is the
 * caller's and active, its thread is in a project, the run's owner may edit it (PR3), and the run
 * may wait for a person (D32: `auto` and scheduled runs are refused and the skip is recorded).
 *
 * The approval binds what is committed: the server builds the canonical input itself, `{project_id,
 * base_seq, message, diff_sha256}` (the SHA-256 of the sorted diff of the working copy against the
 * checkout's base, `projects/tree.ts diffHash`). When a policy rule allowed the call outright the
 * commit runs at once; otherwise the policy check deferred the approval to here
 * (`SERVER_APPROVED_TOOLS`), an approval over that input is asked, the sandbox is answered
 * `pending_approval`, and the commit runs when it is granted, only if the working copy still has
 * the same base and diff hash. One commit per project and connection is in flight at a time: a
 * repeat meanwhile is answered `pending_approval` without asking again. Exactly one
 * `project.commit_result` per frame.
 */
export interface ProjectCommitDeps {
  readonly commit: CommitDeps;
  /** KOBE-767: a Repo's commit goes to its git host (read on use; absent: Repos refuse as before). */
  readonly repo?: () => RepoCommitWiring;
  readonly approvals: ApprovalBroker;
  readonly verifier: ApprovalVerifier | undefined;
  readonly runMaxEvents: number;
  readonly log: Pick<Logger, "warn" | "error">;
}

export interface ProjectCommitConnection {
  readonly deps: ProjectCommitDeps;
  readonly target: SandboxTarget;
  readonly connectionId: string;
  /**
   * True only when the policy check allowed this frame's call by a rule (a positive mark on the
   * allowance); anything else, including an evicted entry, asks for an approval (fail closed).
   */
  readonly ruleAllowed: (frame: ProjectCommitFrame) => boolean;
  /** Projects with a commit waiting for approval on this connection. */
  readonly pending: Set<string>;
  /** Aborts when the connection closes (a pending approval resolves as denied). */
  readonly signal: AbortSignal;
  /** The agent's hello capabilities (KOBE-767: Repo outcomes only to `repo_commits` agents). */
  readonly hasCapability?: (name: string) => boolean;
  send(frame: ServerToSandboxFrame): boolean;
}

const TOOL = "commit_project";
/**
 * Review M2 (KOBE-767): a commit to a Repo sends the project's files to an external git host, so
 * it is its own approval subject: rules that allow `commit_project` (written when it only touched
 * Kaiju's copy) never cover it, and every one asks a person, with where it pushes on the card.
 */
export const REPO_COMMIT_TOOL = "commit_repo";

type Reply =
  { ok: true; outcome: ProjectCommitOutcome } | { ok: false; code: string; message: string };

const failed = (code: string, message: string): Reply => ({ ok: false, code, message });

/**
 * A commit outcome as the tool sees it (the message reaches the model verbatim). `repoCommits`:
 * the agent understands the Repo outcomes (KOBE-767); an older one is told in words, as a failed
 * call, because its parser fails closed on an unknown status.
 */
export function replyOf(result: CommitResult, repoCommits = true): Reply {
  switch (result.status) {
    case "committed":
      return { ok: true, outcome: { status: "committed", seq: result.seq } };
    case "nothing_to_commit":
      return { ok: true, outcome: { status: "nothing_to_commit" } };
    case "commit_conflict":
      return { ok: true, outcome: { status: "commit_conflict", head_seq: result.headSeq } };
    case "pull_request": {
      const outcome = {
        status: "pull_request" as const,
        branch: result.branch,
        number: result.number,
        url: result.url,
        opened: result.opened,
      };
      if (repoCommits) return { ok: true, outcome };
      return failed(
        "committed_as_pull_request",
        `Committed to the Repo as pull request #${result.number} (branch ${result.branch})${result.url === "" ? "" : `: ${result.url}`}. Do not commit again for the same change.`,
      );
    }
    case "pushed":
      if (repoCommits) {
        return { ok: true, outcome: { status: "pushed", branch: result.branch, seq: result.seq } };
      }
      return failed(
        "committed_to_default_branch",
        `Committed and pushed to the Repo's ${result.branch} branch. Do not commit again for the same change.`,
      );
    case "refused":
      break;
  }
  const named = result.path === undefined ? "" : ` (${result.path})`;
  switch (result.error) {
    case "not_found":
    case "forbidden":
      return failed("not_allowed", "You can read this project but not change it.");
    case "checkout_required":
      return failed(
        "checkout_required",
        "The project is not checked out. Ask the user to check it out, then commit.",
      );
    case "archived":
      return failed("not_allowed", "The project is archived.");
    case "too_many_files":
      return failed("too_many_files", "A project holds at most 500 files.");
    case "file_too_large":
      return failed("too_large", `A file is larger than a project file may be${named}.`);
    case "conflict_file":
      return failed(
        "conflict_file",
        `A conflict copy is in the working copy${named}: resolve it (keep what is needed, delete the copy), then commit.`,
      );
    case "invalid_path":
      return failed("invalid_path", `A file name can't be used in a project${named}.`);
    case "quota_exceeded":
      return failed(
        "quota_exceeded",
        result.limit === "objects"
          ? "The commit would pass the workspace's object budget."
          : "The commit would pass the workspace's storage quota.",
      );
    case "legal_hold":
      return failed(
        "not_allowed",
        "The workspace is under a legal hold; its files stay as they are.",
      );
    case "changed":
      return failed(
        "not_allowed",
        "The working copy changed after the commit was approved, so nothing was committed.",
      );
    case "storage_failed":
      return failed("storage_failed", "The commit could not be stored. Try again.");
    case "repo":
    case "converting":
      return failed("not_allowed", PROJECT_WRITE_BLOCK_MESSAGES[result.error]);
    case "repo_moved":
    case "repo_unavailable":
    case "repo_push_rejected":
      return failed(result.error, result.detail ?? REPO_REFUSAL_MESSAGES[result.error]);
    case "rate_limited":
      return failed("rate_limited", result.detail ?? "Too many commits to Repos. Try again later.");
  }
}

/** Where an agent's commit to this project would go on the git host, when it is a Repo. */
async function repoTarget(
  c: ProjectCommitConnection,
  projectId: string,
): Promise<string | undefined> {
  const { teamId } = c.target;
  return withTeam(c.deps.commit.db, teamId, async (tx) => {
    const res = await tx.execute<{
      base_url: string | null;
      full_name: string | null;
      default_branch: string | null;
      direct_commits: boolean | null;
    }>(sql`
      SELECT g.base_url, g.full_name, g.default_branch, k.direct_commits
        FROM projects p
        LEFT JOIN git_repositories g ON g.team_id = p.team_id AND g.project_id = p.id
        LEFT JOIN git_connections k ON k.team_id = g.team_id AND k.id = g.connection_id
       WHERE p.team_id = ${teamId} AND p.id = ${projectId} AND p.kind = 'repo'`);
    const r = res.rows[0];
    if (!r) return undefined;
    // Review R2-L2: a Repo is decided by the project's kind alone; a missing record still asks.
    if (r.base_url === null || r.full_name === null) {
      return "the Repo's git host (its repository record is missing)";
    }
    const host = r.base_url.replace(/^https:\/\//, "");
    const branch = r.default_branch ?? "the default branch";
    return r.direct_commits === true
      ? `${host}/${r.full_name}: straight to ${branch} (a pull request if the host protects it)`
      : `${host}/${r.full_name}: a branch with a pull request into ${branch}`;
  });
}

/**
 * Who decides an agent's commit (review M2): an ordinary project's commit goes ahead on a rule
 * that allowed `commit_project`, else asks; a Repo's commit always asks, as `commit_repo`.
 */
export function commitSubject(
  pushesTo: string | undefined,
  ruleAllowed: boolean,
): { readonly tool: string; readonly ask: boolean } {
  if (pushesTo !== undefined) return { tool: REPO_COMMIT_TOOL, ask: true };
  return { tool: TOOL, ask: !ruleAllowed };
}

const repoApprovalDecision = (
  pushesTo: string,
): Extract<PolicyDecision, { effect: "require_approval" }> => ({
  effect: "require_approval",
  expires_at: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
  risk: "write",
  reasons: [
    {
      code: "risk_write",
      stage: "risk_class",
      message: `commit_repo sends the project's changed files to the git host: ${pushesTo}.`.slice(
        0,
        500,
      ),
    },
  ],
});

const approvalDecision = (): Extract<PolicyDecision, { effect: "require_approval" }> => ({
  effect: "require_approval",
  // The broker sets the real expiry (1 h, D29).
  expires_at: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
  risk: "write",
  reasons: [
    {
      code: "risk_write",
      stage: "risk_class",
      message:
        "commit_project writes a new version of the project's shared files (on a Repo: a git commit on the host, by default as a pull request).",
    },
  ],
});

type Gate =
  { readonly ok: true; readonly projectId: string } | { readonly ok: false; readonly reply: Reply };

/** The run is the caller's, active and a message run; its project; edit access (PR3). */
async function gate(c: ProjectCommitConnection, frame: ProjectCommitFrame): Promise<Gate> {
  const { teamId, userId } = c.target;
  return withTeam(c.deps.commit.db, teamId, async (tx) => {
    const res = await tx.execute<{ status: string; kind: string; project_id: string | null }>(sql`
      SELECT r.status, r.kind, t.project_id FROM runs r
        JOIN threads t ON t.team_id = r.team_id AND t.id = r.thread_id
       WHERE r.team_id = ${teamId} AND r.id = ${frame.run_id} AND r.thread_id = ${frame.thread_id}
         AND t.team_id = ${teamId} AND t.owner_user_id = ${userId}`);
    const row = res.rows[0];
    if (
      (row?.status !== "running" && row?.status !== "waiting_approval") ||
      row.kind !== "message"
    ) {
      return {
        ok: false,
        reply: failed("not_allowed", "The run has ended, so nothing was committed."),
      };
    }
    if (row.project_id === null) {
      return {
        ok: false,
        reply: failed("not_in_project", "This conversation is not in a project."),
      };
    }
    const access = await loadAccess(tx, { teamId, userId }, row.project_id);
    if (!access?.can.edit) {
      return {
        ok: false,
        reply: failed("not_allowed", "You can read this project but not change it."),
      };
    }
    return { ok: true, projectId: row.project_id };
  });
}

/** Exactly one `project.commit_result` for the frame, whatever answers it first. */
function answerOnce(c: ProjectCommitConnection, frame: ProjectCommitFrame): (reply: Reply) => void {
  let answered = false;
  return (reply) => {
    if (answered) return;
    answered = true;
    c.send(
      reply.ok
        ? {
            v: 1,
            type: "project.commit_result",
            request_id: frame.request_id,
            ok: true,
            op: "project_commit",
            outcome: reply.outcome,
          }
        : {
            v: 1,
            type: "project.commit_result",
            request_id: frame.request_id,
            ok: false,
            error: { code: reply.code, message: reply.message.slice(0, 2000) },
          },
    );
  };
}

/**
 * The gate's spec for `project.commit`. The allowance is single use (KOBE-783, P2-22): one allowed
 * call commits at most once, so a rule-allowed call can't commit again from a changed working copy
 * (and a rule revoked after its one recorded use stops it). A repeat of the call's frame is
 * answered `pending_approval` while the first is still going (as a repeat always was), else
 * `not_allowed`. One commit per project runs at a time.
 */
export function projectCommitSpec(
  c: ProjectCommitConnection,
): ToolFrameSpec<ProjectCommitFrame, "consume"> {
  /** This connection's commit calls still going, by run and tool call. */
  const going = new Set<string>();
  const callKey = (frame: ProjectCommitFrame) => JSON.stringify([frame.run_id, frame.tool_call_id]);
  return {
    capabilities: [CAPABILITY_PROJECTS],
    allowance: "consume",
    refuse(frame, refusal) {
      const answer = answerOnce(c, frame);
      switch (refusal.stage) {
        case "capability":
          answer(failed("not_allowed", "This sandbox did not announce projects."));
          return;
        case "ended":
          answer(failed("not_allowed", "The run has ended, so nothing was committed."));
          return;
        case "verdict": {
          const { verdict } = refusal;
          if (verdict === "replayed" && going.has(callKey(frame))) {
            answer({ ok: true, outcome: { status: "pending_approval" } });
            return;
          }
          c.deps.log.warn(
            { run_id: frame.run_id, verdict, security: true },
            "project.commit refused",
          );
          answer(
            failed(
              "not_allowed",
              verdict === "input_mismatch"
                ? "The commit differs from the call that was allowed."
                : verdict === "replayed"
                  ? "This tool call was already used; make a new call to commit."
                  : "This tool call was not allowed for this tool.",
            ),
          );
          return;
        }
        case "busy":
          return; // no in-flight cap for this kind
      }
    },
    act(frame) {
      const answer = answerOnce(c, frame);
      const key = callKey(frame);
      going.add(key);
      let held: string | undefined;
      void run(c, frame, answer, (projectId) => {
        held = projectId;
      })
        .catch((err: unknown) => {
          c.deps.log.error({ err, run_id: frame.run_id }, "project.commit failed");
          answer(failed("storage_failed", "The commit could not be stored. Try again."));
        })
        .finally(() => {
          going.delete(key);
          if (held !== undefined) c.pending.delete(held);
        });
    },
  };
}

async function run(
  c: ProjectCommitConnection,
  frame: ProjectCommitFrame,
  answer: (reply: Reply) => void,
  hold: (projectId: string) => void,
): Promise<void> {
  const { deps } = c;
  const call = {
    teamId: c.target.teamId,
    userId: c.target.userId,
    runId: frame.run_id,
    toolCallId: frame.tool_call_id,
  };
  const g = await gate(c, frame);
  if (!g.ok) {
    answer(g.reply);
    return;
  }
  // D32: a run that never waits for a person never commits; the skip is recorded.
  const noPrompt = await noPromptCode(deps.commit.db, call);
  if (noPrompt) {
    await recordDeniedWrite(deps.commit.db, deps.log, call, TOOL, deps.runMaxEvents, noPrompt);
    answer(
      failed("not_allowed", "This run does not wait for approvals, so nothing was committed."),
    );
    return;
  }
  // Checked and taken in one synchronous step: a repeat can never slip in between.
  if (c.pending.has(g.projectId)) {
    answer({ ok: true, outcome: { status: "pending_approval" } });
    return;
  }
  c.pending.add(g.projectId);
  hold(g.projectId);
  const owner = { teamId: c.target.teamId, userId: c.target.userId };
  const repo = deps.repo?.();
  const repoCommits = c.hasCapability?.(CAPABILITY_REPO_COMMITS) === true;
  const preview = await previewProjectCommit(deps.commit, repo, { owner, projectId: g.projectId });
  if ("status" in preview) {
    answer(replyOf(preview, repoCommits));
    return;
  }
  const pushesTo = repo === undefined ? undefined : await repoTarget(c, g.projectId);
  const subject = commitSubject(pushesTo, c.ruleAllowed(frame));
  const tool = subject.tool;
  const input = {
    project_id: g.projectId,
    base_seq: preview.baseSeq,
    message: frame.input.message,
    diff_sha256: preview.diffHash,
    ...(pushesTo === undefined ? {} : { pushes_to: pushesTo }),
  };
  const commit = () =>
    commitProject(deps.commit, repo, {
      owner,
      projectId: g.projectId,
      message: frame.input.message,
      author: {
        userId: owner.userId,
        kind: "agent",
        threadId: frame.thread_id,
        runId: frame.run_id,
      },
      expect: { baseSeq: preview.baseSeq, diffHash: preview.diffHash },
      via: {
        kind: "agent",
        threadId: frame.thread_id,
        runId: frame.run_id,
        toolCallId: frame.tool_call_id,
      },
      approvedAs: tool === REPO_COMMIT_TOOL ? "commit_repo" : "commit_project",
    });
  // M2: a rule never lets a commit reach an external git host without a person's approval.
  if (!subject.ask) {
    // A policy rule allowed commit_project outright (remembered or team rule): no approval.
    answer(replyOf(await commit(), repoCommits));
    return;
  }
  const outcome = await deps.approvals.request(
    {
      teamId: owner.teamId,
      userId: owner.userId,
      connectionId: c.connectionId,
      runId: frame.run_id,
      threadId: frame.thread_id,
      toolCallId: frame.tool_call_id,
      tool,
      input,
      decision: pushesTo === undefined ? approvalDecision() : repoApprovalDecision(pushesTo),
      signal: c.signal,
    },
    () => answer({ ok: true, outcome: { status: "pending_approval" } }),
  );
  if (outcome.decision === "deny") {
    answer(failed("not_allowed", outcome.message));
    return;
  }
  if (!(await approvalHolds(deps.verifier, call, tool, input))) {
    answer(failed("not_allowed", "This commit was not approved."));
    return;
  }
  // Only reaches the sandbox when the approval was immediate; otherwise `pending_approval` went first.
  const result = await commit();
  if (
    result.status !== "committed" &&
    result.status !== "pull_request" &&
    result.status !== "pushed"
  ) {
    deps.log.warn({ run_id: frame.run_id, status: result.status }, "approved commit not written");
  }
  answer(replyOf(result, repoCommits));
}
