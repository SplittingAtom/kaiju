import {
  decideGitHost,
  gitConversions,
  readGitConnection,
  readGitSiteSettings,
  sql,
  withTeam,
  type GitConnectionRecord,
  type GitRepoVisibility,
  type KobeTx,
} from "@kobe/db";
import type {
  GitConversionAbandoned,
  GitConversionStartBody,
  GitConversionView,
} from "@kobe/protocol";
import { recordAudit } from "../../audit/record.js";
import { assertRepositoryName } from "../../git-hosts/adapter.js";
import { loadAccess, teamRoleFor } from "../../projects/access.js";
import { projectCheckouts } from "../../projects/checkouts.js";
import { checkRateLimit } from "../../rate-limit.js";
import {
  GIT_CONVERSION_MAX_BYTES,
  GIT_CONVERSION_RATE,
  GIT_CONVERSION_MAX_FILE_BYTES,
} from "./limits.js";
import { repoContentRefusal } from "../repo-limits.js";
import { pathRefusal } from "./paths.js";
import { buildConversionPlan } from "./plan.js";
import { refusalMessage, REFUSAL_STATUS, type StartRefusal } from "./refusals.js";
import type { ConversionDeps } from "./runner.js";
import { activeConversion, conversionView, latestConversion, type ConversionRow } from "./store.js";

/**
 * Starting, retrying and abandoning a conversion (KOBE-765, G16, GQ13), for the routes. The
 * project's owner and Workspace admins (`manage`) may do all three; every member who views the
 * project may read the attempt. A start checks everything Kaiju can know without the host (G16:
 * "refused ... and the dialog says which"), freezes the commit plan and inserts the attempt under
 * the project row lock, the lock every Kaiju write takes, so no commit slips in between: from then
 * on the project takes no Kaiju writes until the attempt completes (a Repo) or is abandoned.
 */
export type Viewer = { readonly teamId: string; readonly userId: string };

export type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly status: number; readonly body: Record<string, unknown> };

const refuse = (r: StartRefusal, conversion?: ConversionRow): Outcome<never> => ({
  ok: false,
  status: REFUSAL_STATUS[r.code],
  body: {
    code: r.code,
    message: refusalMessage(r),
    ...(r.path === undefined ? {} : { path: r.path }),
    ...(r.seq === undefined ? {} : { seq: r.seq }),
    ...(r.checkouts === undefined ? {} : { checkouts: r.checkouts }),
    ...(r.paths === undefined ? {} : { paths: r.paths }),
    ...(r.limitBytes === undefined ? {} : { limit_bytes: r.limitBytes }),
    ...(r.sizeBytes === undefined ? {} : { size_bytes: r.sizeBytes }),
    ...(conversion ? { conversion: conversionView(conversion) } : {}),
  },
});
const plain = (status: number, code: string, message: string): Outcome<never> => ({
  ok: false,
  status,
  body: { code, message },
});
const NOT_FOUND = plain(404, "not_found", "No project with that id is available to you.");
const FORBIDDEN = plain(
  403,
  "forbidden",
  "Only the project's owner and Workspace admins may convert it to a Repo.",
);
/** The shared Postgres limiter (`checkRateLimit`, as the git host tools use it). */
async function rateLimited(deps: Pick<ConversionDeps, "db">, userId: string) {
  const verdict = await checkRateLimit(deps.db, `git-conversions:${userId}`, GIT_CONVERSION_RATE);
  if (verdict.allowed) return undefined;
  return {
    ok: false as const,
    status: 429,
    body: {
      code: "rate_limited",
      message: "Too many conversion attempts. Try again later.",
      retry_after_seconds: verdict.retryAfterSeconds,
    },
  };
}

export { hostRejectsPath } from "./paths.js";

/** The repository name the dialog proposes: the connection's prefix + the project's slug (G16). */
export function defaultRepositoryName(prefix: string, slug: string): string {
  return `${prefix}${slug}`;
}

async function underHold(tx: KobeTx, teamId: string): Promise<boolean> {
  const res = await tx.execute<{ held: boolean }>(
    sql`SELECT public.memory_legal_hold_covers(${teamId}, NULL) AS held`,
  );
  return res.rows[0]?.held === true;
}

/** Most offending paths a refusal lists. */
const REJECTED_LISTED = 20;

/**
 * Every file the host would reject (review M1: git's fsck rules, `paths.ts`, and the host's file
 * size), across every tree the conversion carries, with the first commit that has it.
 */
async function rejectedFiles(
  tx: KobeTx,
  teamId: string,
  projectId: string,
  history: boolean,
  maxFile: number,
): Promise<{ path: string; seq: number | null; why: "name" | "size" }[]> {
  const rows = history
    ? (
        await tx.execute<{ path: string; seq: number; size: string }>(sql`
          SELECT e.path, min(c.seq) AS seq, max(e.size_bytes) AS size FROM project_tree_entries e
            JOIN project_commits c ON c.team_id = e.team_id AND c.id = e.commit_id
           WHERE e.team_id = ${teamId} AND c.project_id = ${projectId}
           GROUP BY e.path ORDER BY min(c.seq), e.path`)
      ).rows
    : (
        await tx.execute<{ path: string; seq: null; size: string }>(sql`
          SELECT path, NULL AS seq, size_bytes AS size FROM project_files
           WHERE team_id = ${teamId} AND project_id = ${projectId} ORDER BY path`)
      ).rows;
  const out: { path: string; seq: number | null; why: "name" | "size" }[] = [];
  for (const r of rows) {
    const why =
      pathRefusal(r.path) !== undefined ? "name" : Number(r.size) > maxFile ? "size" : undefined;
    if (why === undefined) continue;
    out.push({ path: r.path, seq: r.seq === null ? null : Number(r.seq), why });
    if (out.length === REJECTED_LISTED) break;
  }
  return out;
}

/** New content per git commit (bytes no earlier commit had), oldest first. */
async function contentPerCommit(
  tx: KobeTx,
  teamId: string,
  projectId: string,
  history: boolean,
): Promise<{ seq: number | null; bytes: number }[]> {
  if (!history) {
    const res = await tx.execute<{ bytes: string | null }>(sql`
      SELECT sum(size_bytes) AS bytes FROM (
        SELECT DISTINCT ON (sha256) sha256, size_bytes FROM project_files
         WHERE team_id = ${teamId} AND project_id = ${projectId} ORDER BY sha256) f`);
    return [{ seq: null, bytes: Number(res.rows[0]?.bytes ?? 0) }];
  }
  const res = await tx.execute<{ seq: number; bytes: string }>(sql`
    SELECT seq, sum(size_bytes) AS bytes FROM (
      SELECT DISTINCT ON (e.sha256) e.sha256, e.size_bytes, c.seq FROM project_tree_entries e
        JOIN project_commits c ON c.team_id = e.team_id AND c.id = e.commit_id
       WHERE e.team_id = ${teamId} AND c.project_id = ${projectId}
       ORDER BY e.sha256, c.seq) f
     GROUP BY seq ORDER BY seq`);
  return res.rows.map((r) => ({ seq: Number(r.seq), bytes: Number(r.bytes) }));
}

/** The checks against the stored project and connection (no host call); undefined when fine. */
async function check(
  tx: KobeTx,
  input: {
    readonly teamId: string;
    readonly projectId: string;
    readonly connection: GitConnectionRecord;
    readonly history: boolean;
    readonly useExisting: boolean;
  },
): Promise<StartRefusal | undefined> {
  const { teamId, projectId, connection, history } = input;
  if (connection.accessLevel !== "read_write") return { code: "connection_read_only" };
  if (!input.useExisting && connection.capabilities.create === "no") {
    return { code: "cannot_create_repositories" };
  }
  if (await underHold(tx, teamId)) return { code: "legal_hold" };
  const checkouts = (await projectCheckouts(tx, teamId, projectId)).filter(
    (c) => c.changed_files > 0,
  ).length;
  if (checkouts > 0) return { code: "unsaved_checkouts", checkouts };
  const rejected = await rejectedFiles(
    tx,
    teamId,
    projectId,
    history,
    GIT_CONVERSION_MAX_FILE_BYTES,
  );
  const strip = (list: typeof rejected) => list.map(({ path, seq }) => ({ path, seq }));
  const names = rejected.filter((r) => r.why === "name");
  const big = rejected.filter((r) => r.why === "size");
  if (names[0]) return { code: "file_rejected_by_host", path: names[0].path, paths: strip(names) };
  if (big[0]) {
    return {
      code: "file_too_large",
      path: big[0].path,
      paths: strip(big),
      limitBytes: GIT_CONVERSION_MAX_FILE_BYTES,
    };
  }
  // KOBE-766 review R3-M1: the Repo's mirror must be able to hold the current files, or Kaiju
  // could never show the host's changes after conversion.
  const current = await tx.execute<{
    files: string;
    bytes: string | null;
    largest: string | null;
  }>(sql`
    SELECT count(*) AS files, sum(size_bytes) AS bytes, max(size_bytes) AS largest
      FROM project_files WHERE team_id = ${teamId} AND project_id = ${projectId}`);
  const facts = current.rows[0];
  const mirror = repoContentRefusal({
    files: Number(facts?.files ?? 0),
    bytes: Number(facts?.bytes ?? 0),
    largest: Number(facts?.largest ?? 0),
  });
  if (mirror) {
    return {
      code: "too_large_to_mirror",
      mirrorLimit: mirror.limit,
      ...(mirror.limit === "files"
        ? {}
        : { limitBytes: mirror.limitValue, sizeBytes: Number(facts?.bytes ?? 0) }),
    };
  }
  const sizes = await contentPerCommit(tx, teamId, projectId, history);
  const limit = Math.min(GIT_CONVERSION_MAX_BYTES, connection.pushLimitBytes);
  const total = sizes.reduce((n, s) => n + s.bytes, 0);
  if (total > limit) return { code: "project_too_large", limitBytes: limit, sizeBytes: total };
  return undefined;
}

function visibilityOf(
  connection: GitConnectionRecord,
  asked: GitRepoVisibility | undefined,
): GitRepoVisibility | undefined {
  const wanted = asked ?? connection.repoVisibility;
  if (wanted === "private") return "private";
  // G10: internal only where the host has it (GitHub) and the admin allowed it.
  return connection.provider === "github" && connection.repoVisibility === "internal"
    ? "internal"
    : undefined;
}

/** `POST /v1/projects/{id}/repo-conversion`: checks, freezes the plan, inserts the attempt. */
export async function startConversion(
  deps: Pick<ConversionDeps, "db" | "envelope" | "blobs" | "publicUrl">,
  viewer: Viewer,
  projectId: string,
  body: GitConversionStartBody,
): Promise<Outcome<GitConversionView>> {
  const limited = await rateLimited(deps, viewer.userId);
  if (limited) return limited;
  const settings = await readGitSiteSettings(deps.db);
  const siteHost = new URL(deps.publicUrl).hostname;
  return withTeam(deps.db, viewer.teamId, async (tx): Promise<Outcome<GitConversionView>> => {
    const access = await loadAccess(tx, viewer, projectId, { lock: true });
    if (!access) return NOT_FOUND;
    if (!access.can.manage) return FORBIDDEN;
    const { project } = access;
    if (project.kind === "repo") return refuse({ code: "already_repo" });
    const active = await activeConversion(tx, viewer.teamId, projectId);
    if (active) return refuse({ code: "conversion_in_progress" }, active);
    if (project.archivedAt !== null) return refuse({ code: "archived" });
    if (!deps.envelope || !deps.blobs) return refuse({ code: "git_unavailable" });
    const connection = await readGitConnection(tx, viewer.teamId, body.connection_id);
    if (!connection) return refuse({ code: "connection_not_found" });
    const decision = decideGitHost(settings, connection.baseUrl);
    if (!decision.ok) {
      return refuse({
        code: decision.code === "git_disabled" ? "git_disabled" : "host_not_allowed",
      });
    }
    const name =
      body.repository_name ?? defaultRepositoryName(connection.repoNamePrefix, project.slug);
    try {
      assertRepositoryName(name);
    } catch {
      return refuse({ code: "invalid_repository_name" });
    }
    const visibility = visibilityOf(connection, body.visibility);
    if (visibility === undefined) return refuse({ code: "internal_not_offered" });
    const history = body.carry_history ?? true;
    const useExisting = body.use_existing ?? false;
    // G16: only a Workspace admin chooses an existing repository; owners create a new one.
    if (useExisting && (await teamRoleFor(tx, viewer.teamId, viewer.userId)) !== "team_admin") {
      return refuse({ code: "existing_repository_admin_only" });
    }
    const refusal = await check(tx, {
      teamId: viewer.teamId,
      projectId,
      connection,
      history,
      useExisting,
    });
    if (refusal) return refuse(refusal);
    const requestedAt = new Date();
    const plan = await buildConversionPlan(tx, {
      teamId: viewer.teamId,
      projectId,
      carryHistory: history,
      branch: connection.defaultBranch,
      requestedBy: viewer.userId,
      requestedAt,
      siteHost,
    });
    const [row] = await tx
      .insert(gitConversions)
      .values({
        teamId: viewer.teamId,
        projectId,
        connectionId: connection.id,
        requestedBy: viewer.userId,
        provider: connection.provider,
        baseUrl: connection.baseUrl,
        organization: connection.organization,
        repositoryName: name,
        visibility,
        carryHistory: history,
        useExisting,
        defaultBranch: connection.defaultBranch,
        plan,
        commitsTotal: plan.commits.length,
        createdAt: requestedAt,
      })
      .returning();
    if (!row) throw new Error("git_conversions insert returned no row");
    await recordAudit(tx, {
      action: "git.project.conversion_requested",
      actor: { kind: "user", id: viewer.userId },
      teamId: viewer.teamId,
      target: {
        conversionId: row.id,
        projectId,
        connectionId: connection.id,
        provider: connection.provider,
        host: decision.host,
        organization: connection.organization,
        visibility,
        carryHistory: history,
        useExisting,
      },
    });
    return { ok: true, value: conversionView(row) };
  });
}

/** `GET /v1/projects/{id}/repo-conversion`: the latest attempt (any member who views the project). */
export async function readProjectConversion(
  deps: Pick<ConversionDeps, "db">,
  viewer: Viewer,
  projectId: string,
): Promise<Outcome<GitConversionView | null>> {
  return withTeam(deps.db, viewer.teamId, async (tx) => {
    const access = await loadAccess(tx, viewer, projectId);
    if (!access) return NOT_FOUND;
    const row = await latestConversion(tx, viewer.teamId, projectId);
    return { ok: true, value: row ? conversionView(row) : null };
  });
}

const NOT_FAILED = (row: ConversionRow | undefined): Outcome<never> =>
  row
    ? {
        ok: false,
        status: 409,
        body: {
          code: "conversion_running",
          message:
            "The conversion is still running; it can be retried or abandoned once it failed.",
          conversion: conversionView(row),
        },
      }
    : plain(404, "conversion_not_found", "This project has no conversion to retry or abandon.");

/** Retry: a failed attempt runs again from its step. */
export async function retryConversion(
  deps: Pick<ConversionDeps, "db">,
  viewer: Viewer,
  projectId: string,
): Promise<Outcome<GitConversionView>> {
  const limited = await rateLimited(deps, viewer.userId);
  if (limited) return limited;
  return withTeam(deps.db, viewer.teamId, async (tx): Promise<Outcome<GitConversionView>> => {
    const access = await loadAccess(tx, viewer, projectId, { lock: true });
    if (!access) return NOT_FOUND;
    if (!access.can.manage) return FORBIDDEN;
    const row = await activeConversion(tx, viewer.teamId, projectId);
    if (row?.status !== "failed") return NOT_FAILED(row);
    if (await underHold(tx, viewer.teamId)) return refuse({ code: "legal_hold" }, row);
    const [again] = await tx
      .update(gitConversions)
      .set({
        status: "running",
        lastError: null,
        lastErrorDetail: null,
        leaseOwner: null,
        leaseUntil: null,
        // A person's retry starts the poison guard afresh (review M3).
        claimedAt: null,
        stalls: 0,
        resumes: 0,
        updatedAt: new Date(),
      })
      .where(sql`${gitConversions.teamId} = ${viewer.teamId} AND ${gitConversions.id} = ${row.id}`)
      .returning();
    if (!again) throw new Error("git_conversions update returned no row");
    await recordAudit(tx, {
      action: "git.project.conversion_retried",
      actor: { kind: "user", id: viewer.userId },
      teamId: viewer.teamId,
      target: { conversionId: row.id, projectId, step: row.step },
    });
    return { ok: true, value: conversionView(again) };
  });
}

/**
 * Abandon: a failed attempt ends; the project stays an ordinary project and takes commits again.
 * A repository the host created for it stays on the host (Kaiju deletes nothing there, §9): the
 * answer names it, and it stays listed in the Git section's repositories.
 */
export async function abandonConversion(
  deps: Pick<ConversionDeps, "db">,
  viewer: Viewer,
  projectId: string,
): Promise<Outcome<GitConversionAbandoned>> {
  return withTeam(deps.db, viewer.teamId, async (tx): Promise<Outcome<GitConversionAbandoned>> => {
    const access = await loadAccess(tx, viewer, projectId, { lock: true });
    if (!access) return NOT_FOUND;
    if (!access.can.manage) return FORBIDDEN;
    const row = await activeConversion(tx, viewer.teamId, projectId);
    if (row?.status !== "failed") return NOT_FAILED(row);
    const now = new Date();
    const [ended] = await tx
      .update(gitConversions)
      .set({
        status: "abandoned",
        finishedAt: now,
        finishedBy: viewer.userId,
        leaseOwner: null,
        leaseUntil: null,
        updatedAt: now,
      })
      .where(sql`${gitConversions.teamId} = ${viewer.teamId} AND ${gitConversions.id} = ${row.id}`)
      .returning();
    if (!ended) throw new Error("git_conversions update returned no row");
    const leftOnHost = row.hostRepoId !== null && !row.useExisting;
    await recordAudit(tx, {
      action: "git.project.conversion_abandoned",
      actor: { kind: "user", id: viewer.userId },
      teamId: viewer.teamId,
      target: {
        conversionId: row.id,
        projectId,
        leftOnHost,
        ...(row.repositoryId === null ? {} : { repositoryId: row.repositoryId }),
      },
    });
    return {
      ok: true,
      value: {
        conversion: conversionView(ended),
        left_on_host: leftOnHost
          ? { full_name: `${row.organization}/${row.repositoryName}`, base_url: row.baseUrl }
          : null,
      },
    };
  });
}
