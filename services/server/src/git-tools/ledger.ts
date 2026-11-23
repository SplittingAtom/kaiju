import { sql, withTeam, type GitConnectionRecord, type KobeDb } from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import type { GitToolPrincipal } from "./access.js";

/**
 * The record of every git host write (spec workspace-git §8; KOBE-762): one audit event per action
 * with the member (actor), the run, thread and tool call (`viaAgent`), the agent, the connection,
 * the repository and what the host returned (its id, number and web link; links only on the
 * connection's own origin, as the adapters guarantee). Never a title, body, branch name or
 * credential: like `mcp.tool_call`, the audit log holds no tool input.
 *
 * The same rows make writes idempotent: each carries the call's idempotency key (`callDigest`) (a hash of team,
 * run, tool and canonical input), and a repeat of that call in the same run within a day returns
 * the recorded result instead of acting on the host again.
 */

export type GitWriteAction =
  | "git.repository.created"
  | "git.branch.created"
  | "git.pull_request.opened"
  | "git.comment.created"
  | "git.issue.created";

const ACTIONS: Readonly<Record<string, GitWriteAction>> = {
  git_create_repository: "git.repository.created",
  git_create_branch: "git.branch.created",
  git_open_pull_request: "git.pull_request.opened",
  git_comment: "git.comment.created",
  git_create_issue: "git.issue.created",
};

export const gitWriteAction = (tool: string): GitWriteAction | undefined => ACTIONS[tool];

export interface GitWriteRecord {
  readonly kind: "repository" | "branch" | "pull_request" | "issue" | "comment";
  readonly repository: string;
  readonly hostRepoId: string;
  /** The created thing's id on the host (none for a branch). */
  readonly hostId?: string;
  readonly number?: number | null;
  /** The host's web link (same origin as the connection), or "". */
  readonly url?: string;
  readonly on?: "issue" | "pull_request";
  readonly visibility?: "private" | "internal";
  readonly cloneUrl?: string;
  readonly idempotencyKey: string;
}

/** The connection's host name as the audit vocabulary has it. */
export function auditHost(baseUrl: string): string {
  return new URL(baseUrl).hostname.toLowerCase();
}

const KIND_OF: Readonly<Record<GitWriteAction, GitWriteRecord["kind"]>> = {
  "git.repository.created": "repository",
  "git.branch.created": "branch",
  "git.pull_request.opened": "pull_request",
  "git.comment.created": "comment",
  "git.issue.created": "issue",
};

export async function auditWrite(
  db: KobeDb,
  ctx: {
    readonly principal: GitToolPrincipal;
    readonly runId: string;
    readonly threadId: string;
    readonly toolCallId: string;
    readonly agentId: string | null;
  },
  connection: GitConnectionRecord,
  action: GitWriteAction,
  record: GitWriteRecord,
): Promise<void> {
  const { principal } = ctx;
  const target = {
    connectionId: connection.id,
    ...(ctx.agentId === null ? {} : { agentId: ctx.agentId }),
    host: auditHost(connection.baseUrl),
    organization: connection.organization,
    repository: record.repository,
    hostRepoId: record.hostRepoId,
    ...(record.hostId === undefined ? {} : { hostId: record.hostId }),
    ...(record.number === undefined || record.number === null ? {} : { number: record.number }),
    ...(record.url === undefined || record.url === "" ? {} : { url: record.url }),
    ...(record.on === undefined ? {} : { on: record.on }),
    ...(record.visibility === undefined ? {} : { visibility: record.visibility }),
    callDigest: record.idempotencyKey,
  };
  await withTeam(db, principal.teamId, (tx) =>
    recordAudit(tx, {
      action,
      actor: { kind: "user", id: principal.userId },
      teamId: principal.teamId,
      via: {
        kind: "agent",
        threadId: ctx.threadId,
        runId: ctx.runId,
        toolCallId: ctx.toolCallId,
      },
      // Each action's allowlist accepts exactly the fields its kind sets (events/git.ts).
      target: target as never,
    }),
  );
}

/** The recorded result of the same call in the last day, if it already acted. */
export async function findDone(
  db: KobeDb,
  principal: GitToolPrincipal,
  action: GitWriteAction,
  idempotencyKey: string,
): Promise<GitWriteRecord | undefined> {
  const res = await db.execute<{ target: Record<string, unknown> }>(sql`
    WITH boundary AS (
      SELECT min(a.seq) AS seq FROM public.audit_log a WHERE a.at > now() - interval '1 day')
    SELECT a.target FROM public.audit_log a, boundary b
     WHERE a.actor_id = ${principal.userId} AND a.seq >= b.seq
       AND a.team_id = ${principal.teamId}
       AND a.action = ${action}
       AND a.target ->> 'callDigest' = ${idempotencyKey}
     ORDER BY a.seq DESC
     LIMIT 1`);
  const t = res.rows[0]?.target;
  if (t === undefined) return undefined;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const hostId = str(t.hostId);
  return {
    kind: KIND_OF[action],
    repository: str(t.repository) ?? "",
    hostRepoId: str(t.hostRepoId) ?? "",
    ...(hostId === undefined ? {} : { hostId }),
    number: typeof t.number === "number" ? t.number : null,
    url: str(t.url) ?? "",
    ...(t.on === "issue" || t.on === "pull_request" ? { on: t.on } : {}),
    ...(t.visibility === "private" || t.visibility === "internal"
      ? { visibility: t.visibility }
      : {}),
    idempotencyKey,
  };
}
