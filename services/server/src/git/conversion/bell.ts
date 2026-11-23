import { GIT_CONVERSION_FAILURES } from "@kobe/protocol";
import { sql, type KobeTx } from "@kobe/db";
import { logger } from "../../logger.js";
import type { ConversionRow } from "./store.js";

/**
 * The bell notice of a Convert to repo end (KOBE-819): `git.conversion.completed` or
 * `git.conversion.failed`, to the member who started the attempt while they are an active member
 * of the Workspace (the same recipient rule as the email, `notify.ts`).
 *
 * Written in `tx`, the transaction that records the end (the finish, a failure, or the poison
 * guard giving up), so it commits with the end and only the replica holding the lease writes it.
 * The unique index `notifications_git_conversion_uniq` (attempt, kind, claim count) makes any
 * second write of the same end a no-op. Runs in a savepoint: an error rolls back only the
 * notification, logged, never the end (as `notifyScheduledRunEndInTx`). Ids and the failure code
 * only; the list answer adds the names and the member-safe words, never the stored detail.
 */
export async function notifyConversionEndInTx(tx: KobeTx, row: ConversionRow): Promise<void> {
  if (row.status !== "completed" && row.status !== "failed") return;
  try {
    await tx.transaction((sp) => record(sp, row));
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    const cause = (err as { cause?: { code?: unknown } }).cause?.code;
    logger.error(
      { team: row.teamId, conversion_id: row.id, code: code ?? cause ?? null },
      "git conversion notification not recorded",
    );
  }
}

/** The stored failure code, or `internal_error` for anything the protocol does not list. */
export function failureCodeOf(row: Pick<ConversionRow, "lastError">): string {
  const code = row.lastError;
  return code !== null && (GIT_CONVERSION_FAILURES as readonly string[]).includes(code)
    ? code
    : "internal_error";
}

async function record(tx: KobeTx, row: ConversionRow): Promise<void> {
  const failed = row.status === "failed";
  await tx.execute(sql`
    INSERT INTO notifications (team_id, user_id, kind, git_conversion_id, git_attempt, git_failure)
    SELECT ${row.teamId}::uuid, u.id,
           ${failed ? "git.conversion.failed" : "git.conversion.completed"}::text,
           ${row.id}::uuid, ${row.attempts}::int, ${failed ? failureCodeOf(row) : null}::text
      FROM users u
      JOIN team_members tm ON tm.team_id = ${row.teamId} AND tm.user_id = u.id
     WHERE u.id = ${row.requestedBy} AND u.deactivated_at IS NULL
    ON CONFLICT DO NOTHING`);
}
