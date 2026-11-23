/**
 * Words for a notification. Schedules have no name (KOBE-179), so a notification names its
 * schedule by when it runs ("Every day at 09:00 (Europe/Berlin)"); a schedule deleted since has
 * nothing to show and is called that.
 */
import type { ScheduleRecurrence } from "@kobe/protocol";
import type { KobeNotification } from "./api";
import { describeRecurrence } from "../schedules/format";
import { pausedByLabel } from "../schedules/paused-by";
import { roleLabel } from "../teams";
import { memoryNotificationLabel, memoryNotificationTitle } from "./memory";

export interface ScheduleWhen {
  readonly recurrence: ScheduleRecurrence;
  readonly tz: string;
}

function skipped(count: number): string {
  return count === 1 ? "1 action was skipped" : `${count} actions were skipped`;
}

const skillVersion = (n: KobeNotification) =>
  `${n.skillName ?? "A catalog skill"}${n.skillSemver ? ` ${n.skillSemver}` : ""}`;

const siteAdmin = (n: KobeNotification) => `${n.actorName ?? "A site admin"} (site admin)`;
const member = (n: KobeNotification) => n.subjectName ?? "a member";
const asRole = (n: KobeNotification) => (n.teamRole ? ` as ${roleLabel(n.teamRole)}` : "");

/** The day of an instant (UTC), as the expiry email says it. */
const day = (iso: string) => iso.slice(0, 10);

/**
 * Git notices (KOBE-819), in the Files panel's words (KOBE-768): a conversion names its project,
 * an expiry its connection and the day the credential expires (or expired, when it had already
 * lapsed as the notice was written).
 */
function gitTitle(n: KobeNotification): string | null {
  const project = n.projectName ?? "A project";
  switch (n.kind) {
    case "git.conversion.completed":
      return `${project} is now a Repo`;
    case "git.conversion.failed":
      return `Converting ${n.projectName ?? "a project"} to a Repo failed`;
    case "git.connection.token_expiring": {
      const which = n.gitConnectionName
        ? `the git connection ${n.gitConnectionName}`
        : "a git connection";
      if (!n.gitExpiresAt) return `The credential of ${which} expires soon`;
      const lapsed = Date.parse(n.gitExpiresAt) <= Date.parse(n.createdAt);
      return `The credential of ${which} ${lapsed ? "expired" : "expires"} on ${day(n.gitExpiresAt)}`;
    }
    default:
      return null;
  }
}

/** The Workspace console's Git section, where an admin replaces a credential (KOBE-761). */
export const GIT_SECTION_HREF = "/admin/team/git";

/** Where a git notice sends its reader (KOBE-819): an expiry to the Git section; else none. */
export function gitNotificationLink(
  n: KobeNotification,
): { readonly href: string; readonly label: string } | null {
  return n.kind === "git.connection.token_expiring"
    ? { href: GIT_SECTION_HREF, label: "Open the Git section" }
    : null;
}

/**
 * A line under the headline, when the notice has one: why a conversion failed, in the same
 * member-safe words the Convert to repo dialog shows (KOBE-819).
 */
export function notificationDetail(n: KobeNotification): string | null {
  return n.kind === "git.conversion.failed" ? (n.gitFailureMessage ?? null) : null;
}

/** The headline: what happened to the run (or the schedule), or to a catalog skill. */
export function notificationTitle(n: KobeNotification): string {
  const memory = memoryNotificationTitle(n);
  if (memory !== null) return memory;
  const git = gitTitle(n);
  if (git !== null) return git;
  switch (n.kind) {
    case "schedule.run.succeeded":
      return "Scheduled run finished";
    case "schedule.run.failed":
      return "Scheduled run failed";
    case "schedule.run.interrupted":
      return "Scheduled run was interrupted";
    case "schedule.run.skipped_actions":
      return `Scheduled run finished; ${skipped(n.skippedCount ?? 0)}`;
    case "schedule.paused":
      // A paused notification always names why (the owner pausing sends none).
      return pausedByLabel(n.pausedBy ?? "deactivation");
    case "skill.deprecated":
      return `${n.skillName ?? "A catalog skill"} was deprecated`;
    case "skill.version.deprecated":
      return `${skillVersion(n)} was deprecated`;
    case "skill.version.withdrawn":
      return `${skillVersion(n)} was withdrawn — choose a version`;
    case "skill.version.revoked":
      return `${skillVersion(n)} was revoked — choose a version`;
    case "skill.version.unrevoked":
      return `${skillVersion(n)} is available again`;
    case "skill.version.site_published":
      return `${n.actorName ?? "A Site admin"} published ${skillVersion(n)} for the Site`;
    case "team.member.added":
      return `${n.actorName ?? "A Site admin"} added you to this team`;
    case "team.site_admin.member_added":
      return `${siteAdmin(n)} added ${member(n)} to this team${asRole(n)}`;
    case "team.site_admin.member_role_changed":
      return `${siteAdmin(n)} changed ${member(n)}'s team role${n.teamRole ? ` to ${roleLabel(n.teamRole)}` : ""}`;
    case "team.site_admin.member_removed":
      return `${siteAdmin(n)} removed ${member(n)} from this team`;
    case "team.site_admin.member_taken_over":
      return `${siteAdmin(n)} took over ${member(n)}'s membership from the identity provider`;
    case "skill.member_add.blocked":
      return `A Team admin blocked ${n.skillName ?? "a catalog skill"} in this team; your Add for me was removed`;
    default:
      return "Notification";
  }
}

/** What the notification is about: its schedule, or the catalog skill (KOBE-338). */
export function notificationLabel(
  n: KobeNotification,
  known: ReadonlyMap<string, ScheduleWhen> | null,
): string {
  if (n.kind.startsWith("skill.")) return `Catalog skill ${n.skillName ?? ""}`.trim();
  if (n.kind.startsWith("team.")) return "Team membership";
  if (n.kind.startsWith("memory.")) return memoryNotificationLabel(n);
  if (n.kind.startsWith("git.conversion.")) return `Repo ${n.gitRepository ?? ""}`.trim();
  if (n.kind.startsWith("git.")) return `Git connection ${n.gitConnectionName ?? ""}`.trim();
  return n.scheduleId === null
    ? "A schedule that no longer exists"
    : scheduleLabel(n.scheduleId, known);
}

/**
 * Which schedule: its recurrence and zone, or a placeholder when it is not among `known` (null:
 * the caller's schedules could not be loaded, so nothing is known about it either way).
 */
export function scheduleLabel(
  scheduleId: string,
  known: ReadonlyMap<string, ScheduleWhen> | null,
): string {
  if (known === null) return "One of your schedules";
  const s = known.get(scheduleId);
  return s ? `${describeRecurrence(s.recurrence)} (${s.tz})` : "A schedule that no longer exists";
}
