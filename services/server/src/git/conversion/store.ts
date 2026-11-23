import { and, desc, eq, gitConversions, sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import {
  GIT_CONVERSION_FAILURES,
  type GitConversionFailure,
  type GitConversionView,
} from "@kobe/protocol";
import { GIT_CONVERSION_LEASE_MS } from "./limits.js";
import { FAILURE_MESSAGES } from "./refusals.js";

/**
 * Reads and writes of `git_conversions` (KOBE-765). Every write the job makes is its own short
 * `withTeam()` transaction and names the lease it holds (`lease_owner`), so a replica that lost
 * its claim (it stalled past the lease and another took over) changes nothing: {@link LeaseLost}.
 */
export type ConversionRow = typeof gitConversions.$inferSelect;

export class LeaseLost extends Error {
  constructor() {
    super("conversion lease lost");
    this.name = "LeaseLost";
  }
}

const isFailure = (code: string | null): code is GitConversionFailure =>
  code !== null && (GIT_CONVERSION_FAILURES as readonly string[]).includes(code);

export function conversionView(row: ConversionRow): GitConversionView {
  const code = row.lastError;
  return {
    id: row.id,
    project_id: row.projectId,
    status: row.status,
    step: row.step,
    connection_id: row.connectionId,
    provider: row.provider,
    base_url: row.baseUrl,
    organization: row.organization,
    repository_name: row.repositoryName,
    full_name: `${row.organization}/${row.repositoryName}`,
    visibility: row.visibility,
    carry_history: row.carryHistory,
    use_existing: row.useExisting,
    default_branch: row.defaultBranch,
    repository_created: row.hostRepoId !== null && !row.useExisting,
    commits_total: row.commitsTotal,
    commits_pushed: row.commitsPushed,
    head_sha: row.headSha,
    error:
      row.status === "failed" && isFailure(code)
        ? { code, message: FAILURE_MESSAGES[code], detail: row.lastErrorDetail }
        : row.status === "failed"
          ? {
              code: "internal_error",
              message: FAILURE_MESSAGES.internal_error,
              detail: row.lastErrorDetail,
            }
          : null,
    attempts: row.attempts,
    requested_by: row.requestedBy,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    finished_at: row.finishedAt?.toISOString() ?? null,
  };
}

export async function readConversion(
  tx: KobeTx,
  teamId: string,
  id: string,
): Promise<ConversionRow | undefined> {
  const [row] = await tx
    .select()
    .from(gitConversions)
    .where(and(eq(gitConversions.teamId, teamId), eq(gitConversions.id, id)));
  return row;
}

/** The project's latest attempt (any status). */
export async function latestConversion(
  tx: KobeTx,
  teamId: string,
  projectId: string,
): Promise<ConversionRow | undefined> {
  const [row] = await tx
    .select()
    .from(gitConversions)
    .where(and(eq(gitConversions.teamId, teamId), eq(gitConversions.projectId, projectId)))
    .orderBy(desc(gitConversions.createdAt))
    .limit(1);
  return row;
}

/** The project's running or failed attempt (at most one), locked. */
export async function activeConversion(
  tx: KobeTx,
  teamId: string,
  projectId: string,
): Promise<ConversionRow | undefined> {
  const [row] = await tx
    .select()
    .from(gitConversions)
    .where(
      and(
        eq(gitConversions.teamId, teamId),
        eq(gitConversions.projectId, projectId),
        sql`${gitConversions.status} IN ('running', 'failed')`,
      ),
    )
    .for("update");
  return row;
}

/**
 * Claims a running attempt nobody holds (no lease, or a lapsed one) and counts the attempt.
 * Returns the row, or undefined when another replica holds it or it is no longer running.
 */
export async function claimConversion(
  db: KobeDb,
  teamId: string,
  id: string,
  owner: string,
): Promise<ConversionRow | undefined> {
  return withTeam(db, teamId, async (tx) => {
    const [row] = await tx
      .update(gitConversions)
      .set({
        leaseOwner: owner,
        leaseUntil: sql`now() + make_interval(secs => ${GIT_CONVERSION_LEASE_MS / 1000})`,
        attempts: sql`${gitConversions.attempts} + 1`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(gitConversions.teamId, teamId),
          eq(gitConversions.id, id),
          eq(gitConversions.status, "running"),
          sql`(${gitConversions.leaseUntil} IS NULL OR ${gitConversions.leaseUntil} < now())`,
        ),
      )
      .returning();
    return row;
  });
}

export interface Lease {
  readonly teamId: string;
  readonly id: string;
  readonly owner: string;
}

const held = (lease: Lease) =>
  and(
    eq(gitConversions.teamId, lease.teamId),
    eq(gitConversions.id, lease.id),
    eq(gitConversions.status, "running"),
    eq(gitConversions.leaseOwner, lease.owner),
  );

/** Renews the lease; throws {@link LeaseLost} when it is no longer ours. */
export async function renewLease(db: KobeDb, lease: Lease): Promise<void> {
  const rows = await withTeam(db, lease.teamId, (tx) =>
    tx
      .update(gitConversions)
      .set({
        leaseUntil: sql`now() + make_interval(secs => ${GIT_CONVERSION_LEASE_MS / 1000})`,
      })
      .where(held(lease))
      .returning({ id: gitConversions.id }),
  );
  if (rows.length === 0) throw new LeaseLost();
}

type Changes = Partial<typeof gitConversions.$inferInsert>;

/** Writes `changes` while the lease is ours (in `tx`); throws {@link LeaseLost} otherwise. */
export async function updateHeld(
  tx: KobeTx,
  lease: Lease,
  changes: Changes,
): Promise<ConversionRow> {
  const [row] = await tx
    .update(gitConversions)
    .set({ ...changes, updatedAt: sql`now()` })
    .where(held(lease))
    .returning();
  if (!row) throw new LeaseLost();
  return row;
}

/** {@link updateHeld} in its own transaction. */
export function writeHeld(db: KobeDb, lease: Lease, changes: Changes): Promise<ConversionRow> {
  return withTeam(db, lease.teamId, (tx) => updateHeld(tx, lease, changes));
}
