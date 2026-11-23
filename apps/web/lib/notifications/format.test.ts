import { describe, expect, it } from "vitest";
import type { KobeNotification } from "./api";
import { notificationDetail, notificationLabel, notificationTitle, scheduleLabel } from "./format";

const base: KobeNotification = {
  notificationId: "n",
  kind: "schedule.run.succeeded",
  scheduleId: "s1",
  threadId: "t",
  runId: "r",
  readAt: null,
  createdAt: "2026-10-11T08:00:00Z",
};

describe("notification words (KOBE-181)", () => {
  it.each([
    ["schedule.run.succeeded", {}, "Scheduled run finished"],
    ["schedule.run.failed", {}, "Scheduled run failed"],
    ["schedule.run.interrupted", {}, "Scheduled run was interrupted"],
    [
      "schedule.run.skipped_actions",
      { skippedCount: 1 },
      "Scheduled run finished; 1 action was skipped",
    ],
    [
      "schedule.run.skipped_actions",
      { skippedCount: 3 },
      "Scheduled run finished; 3 actions were skipped",
    ],
    ["schedule.paused", { pausedBy: "team_admin" }, "Paused by a team admin"],
    ["schedule.paused", { pausedBy: "deactivation" }, "Paused: owner deactivated or removed"],
  ] as const)("%s %o → %s", (kind, extra, words) => {
    expect(notificationTitle({ ...base, kind, ...extra })).toBe(words);
  });

  it("says a Team admin's block removed the member's add (KOBE-338)", () => {
    const blocked = {
      ...base,
      kind: "skill.member_add.blocked",
      scheduleId: null,
      threadId: null,
      runId: null,
      skillId: "k1",
      skillName: "sales-report",
    } as const;
    expect(notificationTitle(blocked)).toBe(
      "A Team admin blocked sales-report in this team; your Add for me was removed",
    );
    expect(notificationLabel(blocked, null)).toBe("Catalog skill sales-report");
    expect(notificationLabel(base, null)).toBe("One of your schedules");
  });

  it("says which Site admin added the user to the team (KOBE-638)", () => {
    const added = {
      ...base,
      kind: "team.member.added",
      scheduleId: null,
      threadId: null,
      runId: null,
      actorName: "Ada Admin",
    } as const;
    expect(notificationTitle(added)).toBe("Ada Admin added you to this team");
    expect(notificationLabel(added, null)).toBe("Team membership");
  });

  it("tells team admins what a site admin changed (KOBE-638 review M1)", () => {
    const told = {
      ...base,
      scheduleId: null,
      threadId: null,
      runId: null,
      actorName: "Ada",
      subjectName: "Bob",
    } as const;
    expect(
      notificationTitle({ ...told, kind: "team.site_admin.member_added", teamRole: "member" }),
    ).toBe("Ada (site admin) added Bob to this team as Member");
    expect(
      notificationTitle({
        ...told,
        kind: "team.site_admin.member_role_changed",
        teamRole: "team_admin",
      }),
    ).toBe("Ada (site admin) changed Bob's team role to Team admin");
    expect(notificationTitle({ ...told, kind: "team.site_admin.member_removed" })).toBe(
      "Ada (site admin) removed Bob from this team",
    );
    expect(notificationLabel({ ...told, kind: "team.site_admin.member_removed" }, null)).toBe(
      "Team membership",
    );
  });

  it("names a schedule by its recurrence and zone, or says it is gone", () => {
    const known = new Map([
      ["s1", { recurrence: { kind: "daily", at: "09:00" }, tz: "Europe/Berlin" }],
    ] as const);
    expect(scheduleLabel("s1", known)).toBe("Every day at 09:00 (Europe/Berlin)");
    expect(scheduleLabel("s2", known)).toBe("A schedule that no longer exists");
    expect(scheduleLabel("s1", null)).toBe("One of your schedules");
  });

  describe("git notifications (KOBE-819)", () => {
    const git = { ...base, scheduleId: null, threadId: null, runId: null } as const;
    const conversion = {
      ...git,
      gitConversionId: "c1",
      projectId: "p1",
      projectName: "Sales analysis",
      gitRepository: "acme/sales-analysis",
    } as const;
    it("says a conversion finished or failed, naming the project and the Repo", () => {
      const done = { ...conversion, kind: "git.conversion.completed" } as const;
      expect(notificationTitle(done)).toBe("Sales analysis is now a Repo");
      expect(notificationLabel(done, null)).toBe("Repo acme/sales-analysis");
      expect(notificationDetail(done)).toBeNull();
      const failed = {
        ...conversion,
        kind: "git.conversion.failed",
        gitFailure: "repository_exists",
        gitFailureMessage: "A repository with that name already exists in the organization.",
      } as const;
      expect(notificationTitle(failed)).toBe("Converting Sales analysis to a Repo failed");
      expect(notificationDetail(failed)).toBe(
        "A repository with that name already exists in the organization.",
      );
      expect(notificationTitle({ ...done, projectName: undefined })).toBe(
        "A project is now a Repo",
      );
    });
    it("says when a connection's credential expires, or that it expired", () => {
      const soon = {
        ...git,
        kind: "git.connection.token_expiring",
        gitConnectionId: "g1",
        gitConnectionName: "Acme on GitHub",
        gitExpiresAt: "2026-10-20T00:00:00Z",
        createdAt: "2026-10-11T08:00:00Z",
      } as const;
      expect(notificationTitle(soon)).toBe(
        "The credential of the git connection Acme on GitHub expires on 2026-10-20",
      );
      expect(notificationLabel(soon, null)).toBe("Git connection Acme on GitHub");
      expect(notificationTitle({ ...soon, gitExpiresAt: "2026-10-10T00:00:00Z" })).toBe(
        "The credential of the git connection Acme on GitHub expired on 2026-10-10",
      );
      expect(notificationTitle({ ...soon, gitConnectionName: undefined })).toBe(
        "The credential of a git connection expires on 2026-10-20",
      );
    });
  });
});
