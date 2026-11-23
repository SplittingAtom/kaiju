import { READY, defineTeamSection } from "../types";

export default defineTeamSection({
  id: "git",
  label: "Git",
  description:
    "Connect git organizations on GitHub, Gitea or Forgejo, test them, set their access level and disconnect them.",
  group: "Workspace settings",
  order: 45,
  // /v1/team/git/connections (KOBE-760, KOBE-761).
  permission: "team.git.manage",
  status: READY,
});
