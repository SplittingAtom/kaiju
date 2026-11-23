import {
  GIT_CONVERSION_FAILURES,
  MARK_READ_IDS_MAX,
  type GitConversionFailure,
  type ListNotificationsQuery,
  type ListNotificationsResponse,
  type MarkNotificationsReadBody,
  type MarkNotificationsReadResponse,
  type Notification,
  type NotificationKind,
  type SchedulePausedBy,
} from "@kobe/protocol";
import { sql, withTeam, type KobeDb, type KobeTx, makeCursorCodec } from "@kobe/db";
import { z } from "zod";
import { FAILURE_MESSAGES } from "../git/conversion/refusals.js";

/**
 * The caller's notifications in the active team (KOBE-179; contract in KOBE-176): every query is
 * in `withTeam()` (RLS) and names the caller's `user_id`, so nobody reads or marks anyone
 * else's. Schedule rows whose schedule was deleted since (`schedule_id` set null) are left out:
 * the contract requires the schedule id. Skill rows (KOBE-338) name a catalog skill instead.
 */
export interface Viewer {
  readonly teamId: string;
  readonly userId: string;
}

/** Opaque keyset cursor: the last row's `created_at` (microseconds, as text) and id. */
const cursorSchema = z.strictObject({
  t: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
    // A real instant (no month 13 or 30 February): Postgres would refuse the cast with a 500.
    .refine((t) => {
      const ms = `${t.slice(0, 23)}Z`;
      const d = new Date(ms);
      return !Number.isNaN(d.getTime()) && d.toISOString() === ms;
    }),
  i: z.uuid(),
});
type Cursor = z.infer<typeof cursorSchema>;

const noticeCursor = makeCursorCodec(cursorSchema);

export function encodeCursor(cursor: Cursor): string {
  return noticeCursor.encode(cursor);
}

/** The cursor, or null when it is not one this server issued. */
export function decodeCursor(raw: string): Cursor | null {
  return noticeCursor.decode(raw) ?? null;
}

type Row = {
  id: string;
  kind: NotificationKind;
  schedule_id: string | null;
  thread_id: string | null;
  run_id: string | null;
  skipped_count: number | null;
  paused_by: SchedulePausedBy | null;
  skill_id: string | null;
  skill_name: string | null;
  skill_semver: string | null;
  actor_name: string | null;
  subject_name: string | null;
  team_role: "team_admin" | "contributor" | "member" | null;
  memory_scope: "team" | "site" | null;
  memory_object_id: string | null;
  related_kind: NotificationKind | null;
  item_count: number | null;
  project_id: string | null;
  git_conversion_id: string | null;
  git_project_id: string | null;
  project_name: string | null;
  git_repository: string | null;
  git_failure: string | null;
  git_connection_id: string | null;
  git_connection_name: string | null;
  git_expires_at: Date | string | null;
  read_at: Date | null;
  created_at: Date;
  created_key: string;
};

const iso = (d: Date | string) => new Date(d).toISOString();

function toNotification(row: Row): Notification {
  return {
    notification_id: row.id,
    kind: row.kind,
    schedule_id: row.schedule_id,
    thread_id: row.thread_id,
    run_id: row.run_id,
    ...(row.skipped_count !== null && row.skipped_count > 0
      ? { skipped_count: row.skipped_count }
      : {}),
    ...(row.paused_by !== null ? { paused_by: row.paused_by } : {}),
    ...(row.skill_id !== null && row.skill_name !== null
      ? { skill_id: row.skill_id, skill_name: row.skill_name }
      : {}),
    ...(row.skill_semver !== null ? { skill_semver: row.skill_semver } : {}),
    ...(row.actor_name !== null ? { actor_name: row.actor_name } : {}),
    ...(row.subject_name !== null ? { subject_name: row.subject_name } : {}),
    ...(row.team_role !== null ? { team_role: row.team_role } : {}),
    ...(row.memory_scope !== null ? { memory_scope: row.memory_scope } : {}),
    ...(row.memory_object_id !== null ? { memory_object_id: row.memory_object_id } : {}),
    ...(row.related_kind !== null
      ? { related_kind: row.related_kind as NonNullable<Notification["related_kind"]> }
      : {}),
    ...(row.item_count !== null ? { item_count: row.item_count } : {}),
    ...(row.project_id !== null ? { project_id: row.project_id } : {}),
    ...gitFields(row),
    read_at: row.read_at === null ? null : iso(row.read_at),
    created_at: iso(row.created_at),
  };
}

/**
 * What a git notification names (KOBE-819): a conversion its attempt, project and repository and,
 * when it failed, the code and the same member-safe words the Convert to repo dialog shows (never
 * the stored detail, which may quote the host); an expiry its connection's name and the expiry.
 */
function gitFields(row: Row): Partial<Notification> {
  if (row.git_conversion_id !== null && row.git_repository !== null) {
    const failure = row.git_failure === null ? null : failureOf(row.git_failure);
    return {
      git_conversion_id: row.git_conversion_id,
      git_repository: row.git_repository,
      ...(row.git_project_id !== null ? { project_id: row.git_project_id } : {}),
      ...(row.project_name !== null ? { project_name: row.project_name } : {}),
      ...(failure !== null
        ? { git_failure: failure, git_failure_message: FAILURE_MESSAGES[failure] }
        : {}),
    };
  }
  if (
    row.git_connection_id !== null &&
    row.git_connection_name !== null &&
    row.git_expires_at !== null
  ) {
    return {
      git_connection_id: row.git_connection_id,
      git_connection_name: row.git_connection_name,
      git_expires_at: iso(row.git_expires_at),
    };
  }
  return {};
}

const failureOf = (code: string): GitConversionFailure =>
  (GIT_CONVERSION_FAILURES as readonly string[]).includes(code)
    ? (code as GitConversionFailure)
    : "internal_error";

// A schedule notification needs its schedule (the contract names it); a skill notification
// (KOBE-338) names a catalog skill instead, and a Site admin's new version (KOBE-495) its version
// and the admin; a team notification (KOBE-638) the admin and, for team admins, the member; a
// memory notification (KOBE-645) what its kind names.
const mine = (v: Viewer) =>
  sql`team_id = ${v.teamId} AND user_id = ${v.userId}
    AND (schedule_id IS NOT NULL
      OR kind IN ('skill.member_add.blocked', 'skill.version.site_published')
      OR kind LIKE 'team.%' OR kind LIKE 'memory.%' OR kind LIKE 'git.%')`;

async function unreadCount(tx: KobeTx, v: Viewer): Promise<number> {
  const res = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM notifications WHERE ${mine(v)} AND read_at IS NULL`);
  return res.rows[0]?.n ?? 0;
}

/** Newest first; `cursor` must come from `decodeCursor` (null = first page). */
export async function listNotifications(
  db: KobeDb,
  v: Viewer,
  query: Omit<ListNotificationsQuery, "cursor">,
  cursor: Cursor | null,
): Promise<ListNotificationsResponse> {
  return withTeam(db, v.teamId, async (tx) => {
    const res = await tx.execute<Row>(sql`
      SELECT id, kind, schedule_id, thread_id, run_id, skipped_count, paused_by, skill_id,
             (SELECT r.name FROM registry_skills r WHERE r.id = notifications.skill_id)
               AS skill_name,
             skill_semver,
             (SELECT u.name FROM users u WHERE u.id = notifications.actor_user_id) AS actor_name,
             (SELECT u.name FROM users u WHERE u.id = notifications.subject_user_id)
               AS subject_name,
             team_role, memory_scope, memory_object_id, related_kind, item_count, project_id,
             git_conversion_id, git_failure, git_connection_id, git_expires_at,
             (SELECT c.organization || '/' || c.repository_name FROM git_conversions c
               WHERE c.team_id = notifications.team_id AND c.id = notifications.git_conversion_id)
               AS git_repository,
             (SELECT c.project_id FROM git_conversions c
               WHERE c.team_id = notifications.team_id AND c.id = notifications.git_conversion_id)
               AS git_project_id,
             (SELECT p.name FROM git_conversions c
                JOIN projects p ON p.team_id = c.team_id AND p.id = c.project_id
               WHERE c.team_id = notifications.team_id AND c.id = notifications.git_conversion_id)
               AS project_name,
             (SELECT g.display_name FROM git_connections g
               WHERE g.team_id = notifications.team_id AND g.id = notifications.git_connection_id)
               AS git_connection_name,
             read_at, created_at,
             to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_key
        FROM notifications
       WHERE ${mine(v)}
         ${query.unread ? sql`AND read_at IS NULL` : sql``}
         ${cursor ? sql`AND (created_at, id) < (${cursor.t}::timestamptz, ${cursor.i}::uuid)` : sql``}
       ORDER BY created_at DESC, id DESC
       LIMIT ${query.limit + 1}`);
    const page = res.rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      notifications: page.map(toNotification),
      unread_count: await unreadCount(tx, v),
      next_cursor:
        res.rows.length > query.limit && last
          ? encodeCursor({ t: last.created_key, i: last.id })
          : null,
    };
  });
}

/** Marks the caller's listed (or all) notifications read; already-read ones are not counted. */
export async function markNotificationsRead(
  db: KobeDb,
  v: Viewer,
  body: MarkNotificationsReadBody,
): Promise<MarkNotificationsReadResponse> {
  const ids = (body.notification_ids ?? []).slice(0, MARK_READ_IDS_MAX);
  return withTeam(db, v.teamId, async (tx) => {
    const res = await tx.execute(sql`
      UPDATE notifications SET read_at = now()
       WHERE ${mine(v)} AND read_at IS NULL
         ${
           body.all
             ? sql``
             : sql`AND id IN (${sql.join(
                 ids.map((id) => sql`${id}::uuid`),
                 sql`, `,
               )})`
         }`);
    return { updated: res.rowCount ?? 0, unread_count: await unreadCount(tx, v) };
  });
}
