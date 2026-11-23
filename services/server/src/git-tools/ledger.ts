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
  readonly visibility?: "private" | "internal" | "public";
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
  const target = {
    ...common(ctx, connection, record.repository, record.idempotencyKey),
    hostRepoId: safeHostId(record.hostRepoId),
    ...(record.hostId === undefined ? {} : { hostId: safeHostId(record.hostId) }),
    ...(safeNumber(record.number) === undefined ? {} : { number: safeNumber(record.number) }),
    ...(safeUrl(record.url) === undefined ? {} : { url: safeUrl(record.url) }),
    ...(record.on === undefined ? {} : { on: record.on }),
    ...(record.visibility === undefined ? {} : { visibility: record.visibility }),
  };
  await write(db, ctx, action, target);
}

type Ctx = Parameters<typeof auditWrite>[1];

/** Fields every git tool write row carries; values made to fit the allowlist, never refused. */
function common(ctx: Ctx, connection: GitConnectionRecord, repository: string, digest: string) {
  return {
    connectionId: connection.id,
    ...(ctx.agentId === null ? {} : { agentId: ctx.agentId }),
    host: auditHost(connection.baseUrl),
    organization: connection.organization,
    repository: safeRepository(repository),
    callDigest: digest,
  };
}

// M1 (review g103): a host value the allowlist would refuse is stored in a sanitised, truncated
// form, so the row (and with it the record of the write) is never lost to an odd value.
export const safeHostId = (v: string): string =>
  v.replace(/[^A-Za-z0-9_=-]/g, "").slice(0, 64) || "unknown";
const safeRepository = (v: string): string =>
  v.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100) || "unknown";
const safeNumber = (v: number | null | undefined): number | undefined =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v <= 2_147_483_647 ? v : undefined;
function safeUrl(v: string | undefined): string | undefined {
  if (v === undefined || v === "" || v.length > 2048) return undefined;
  try {
    return new URL(v).protocol === "https:" ? v : undefined;
  } catch {
    return undefined;
  }
}

async function write(db: KobeDb, ctx: Ctx, action: string, target: Record<string, unknown>) {
  const { principal } = ctx;
  await withTeam(db, principal.teamId, (tx) =>
    recordAudit(tx, {
      action: action as GitWriteAction,
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

/**
 * Recorded under the member's git write lock and committed BEFORE the host is asked to act (M1):
 * a later repeat that finds this row without a completion knows the outcome is unknown and does
 * not act again.
 */
export async function auditAttempt(
  db: KobeDb,
  ctx: Ctx,
  connection: GitConnectionRecord,
  tool: string,
  repository: string,
  digest: string,
): Promise<void> {
  await write(db, ctx, "git.write.attempted", {
    ...common(ctx, connection, repository, digest),
    tool,
  });
}

/** The host refused for certain (nothing was created): a repeat may try again. */
export async function auditFailed(
  db: KobeDb,
  ctx: Ctx,
  connection: GitConnectionRecord,
  tool: string,
  repository: string,
  digest: string,
  failure: string,
): Promise<void> {
  await write(db, ctx, "git.write.failed", {
    ...common(ctx, connection, repository, digest),
    tool,
    failure: failure.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 64) || "unknown",
  });
}

export type GitPrior =
  | { readonly state: "done"; readonly record: GitWriteRecord }
  /** Started, never finished or refused: the host may or may not have acted. */
  | { readonly state: "unknown" }
  | undefined;

/** The last record of the same call in the last day: done, unknown, or nothing to go on. */
export async function findPrior(
  db: KobeDb,
  principal: GitToolPrincipal,
  action: GitWriteAction,
  idempotencyKey: string,
): Promise<GitPrior> {
  const res = await db.execute<{ action: string; target: Record<string, unknown> }>(sql`
    WITH boundary AS (
      SELECT min(a.seq) AS seq FROM public.audit_log a WHERE a.at > now() - interval '1 day')
    SELECT a.action, a.target FROM public.audit_log a, boundary b
     WHERE a.actor_id = ${principal.userId} AND a.seq >= b.seq
       AND a.team_id = ${principal.teamId}
       AND a.action IN (${action}, 'git.write.attempted', 'git.write.failed')
       AND a.target ->> 'callDigest' = ${idempotencyKey}
     ORDER BY a.seq DESC
     LIMIT 1`);
  const row = res.rows[0];
  if (row === undefined || row.action === "git.write.failed") return undefined;
  if (row.action === "git.write.attempted") return { state: "unknown" };
  const t = row.target;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const hostId = str(t.hostId);
  return {
    state: "done",
    record: {
      kind: KIND_OF[action],
      repository: str(t.repository) ?? "",
      hostRepoId: str(t.hostRepoId) ?? "",
      ...(hostId === undefined ? {} : { hostId }),
      number: typeof t.number === "number" ? t.number : null,
      url: str(t.url) ?? "",
      ...(t.on === "issue" || t.on === "pull_request" ? { on: t.on } : {}),
      ...(t.visibility === "private" || t.visibility === "internal" || t.visibility === "public"
        ? { visibility: t.visibility }
        : {}),
      idempotencyKey,
    },
  };
}
