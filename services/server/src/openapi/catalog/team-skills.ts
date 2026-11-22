import type { CatalogArea } from "./build.js";
import { teamSkillsDetails } from "./details/team-skills.js";

/** OpenAPI catalog: the team's skill administration (KOBE-727; routes in `routes/team-skill-*.ts`, `skill-promotions.ts`, `skill-usage.ts`). */
export const teamSkillsAreas: readonly CatalogArea[] = [
  {
    tag: "Team: skills",
    detailed: true,
    teamScoped: true,
    details: teamSkillsDetails,
    description:
      "A team's skill review queue and settings, catalog installs and blocks, and Promote to Site requests. Team-scoped: send X-Kobe-Team on changes.",
    entries: [
      [
        "get",
        "/v1/team/skill-promotions",
        "List the team's Promote to Site requests",
        "Team admins.",
      ],
      [
        "get",
        "/v1/team/skill-promotions/{id}",
        "Get one Promote to Site request with what would leave the team",
        "Team admins.",
      ],
      [
        "post",
        "/v1/team/skill-promotions/{id}/confirm",
        "Confirm a Promote to Site request",
        "Team admins.",
      ],
      [
        "post",
        "/v1/team/skill-promotions/{id}/decline",
        "Decline a Promote to Site request",
        "Team admins.",
      ],
      [
        "get",
        "/v1/team/skill-review",
        "List the team's skill versions awaiting or past review",
        "Team admins (`team.skills.review`).",
      ],
      [
        "post",
        "/v1/team/skill-review/{skillId}/versions/{version}",
        "Decide on a team skill version",
        "Team admins (`team.skills.review`).",
      ],
      [
        "get",
        "/v1/team/skill-review/settings",
        "Read the team's skill switches and eval judge",
        "Team members (`team.read`).",
      ],
      [
        "put",
        "/v1/team/skill-review/settings",
        "Change the team's skill switches and eval judge",
        "Team admins (`team.skills.review`). Audited.",
      ],
      [
        "get",
        "/v1/team/skills/blocks",
        "List the catalog skills this team blocks",
        "Team admins (`team.skills.installs.manage`).",
      ],
      [
        "delete",
        "/v1/team/skills/blocks/{skillId}",
        "Unblock a catalog skill for this team",
        "Team admins (`team.skills.installs.manage`).",
      ],
      [
        "put",
        "/v1/team/skills/blocks/{skillId}",
        "Block a catalog skill for this team",
        "Team admins (`team.skills.installs.manage`).",
      ],
      [
        "get",
        "/v1/team/skills/install-requests",
        "List members' requests to install catalog skills",
        "Team admins (`team.skills.installs.manage`).",
      ],
      [
        "post",
        "/v1/team/skills/install-requests/{skillId}/dismiss",
        "Dismiss the install requests for a catalog skill",
        "Team admins (`team.skills.installs.manage`).",
      ],
      [
        "get",
        "/v1/team/skills/installs",
        "List the catalog skills installed in this team",
        "Team members (`team.read`).",
      ],
      [
        "delete",
        "/v1/team/skills/installs/{skillId}",
        "Uninstall a catalog skill from this team",
        "Team admins (`team.skills.installs.manage`). Takes an optional reason.",
      ],
      [
        "put",
        "/v1/team/skills/installs/{skillId}",
        "Install a catalog skill or change its pin and access",
        "`team.skills.publish`; Builders only while the team allows it.",
      ],
      [
        "get",
        "/v1/team/skills/installs/{skillId}/diff",
        "Show the file diff from the running version to another one",
        "Team members (`team.read`).",
      ],
      [
        "post",
        "/v1/team/skills/installs/{skillId}/move",
        "Move an installed skill's pin to another version",
        "`team.skills.publish`. Audited.",
      ],
      [
        "post",
        "/v1/team/skills/installs/{skillId}/rollback",
        "Roll an install back to its earlier version",
        "`team.skills.publish`. Answers 409 when there is none.",
      ],
      [
        "get",
        "/v1/team/skills/installs/{skillId}/updates",
        "Show newer versions of an install with changelog and eval delta",
        "Team members (`team.read`).",
      ],
      [
        "get",
        "/v1/team/skills/member-adds",
        "List the catalog skills members added for themselves",
        "Team admins (`team.skills.installs.manage`).",
      ],
      [
        "post",
        "/v1/team/skills/removed-defaults/{skillId}/reinstall",
        "Reinstall a Default skill the team had removed",
        "Team admins (`team.skills.installs.manage`). Answers 201.",
      ],
      [
        "get",
        "/v1/team/skills/usage",
        "Show the team's usage of catalog skills",
        "Team admins (`team.skills.installs.manage`).",
      ],
    ],
  },
];
