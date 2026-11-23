import { Hono } from "hono";
import { z } from "zod";
import { readGitConnection, sql, withTeam } from "@kobe/db";
import type { RepoCommitInfo } from "@kobe/protocol";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { readWorkingCopy } from "../git/working-copy.js";
import { param } from "../http/request.js";
import { loadAccess } from "../projects/access.js";

/**
 * `GET /v1/projects/{id}/repo-status` (KOBE-767, spec workspace-git G18, G19): for a Repo, where
 * the caller's commits from Kobe's commit flow go (a pull request, or straight to the default
 * branch when the connection allows it), whether the caller may commit there now, their open
 * pull request and their sandbox's working copy (branch, ahead/behind). `repo` null for an
 * ordinary project. Every member who views the project; only the caller's own rows.
 */
export function projectRepoCommitRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  app.use("/:id/repo-status", requireTeam(deps), requireTeamPermission("team.read"));
  app.get("/:id/repo-status", async (c) => {
    const id = param(c, "id", z.uuid());
    const notFound = () =>
      c.json({ code: "not_found", message: "No project with that id is available to you." }, 404);
    if (!id.success) return notFound();
    const teamId = c.get("team").id;
    const userId = c.get("user").id;
    const info = await withTeam(deps.database.db, teamId, async (tx) => {
      const access = await loadAccess(tx, { teamId, userId }, id.data);
      if (!access) return undefined;
      if (access.project.kind !== "repo") return { repo: null } satisfies RepoCommitInfo;
      const repos = await tx.execute<{
        connection_id: string | null;
        default_branch: string;
        host_state: string;
      }>(sql`
        SELECT connection_id, default_branch, host_state FROM git_repositories
         WHERE team_id = ${teamId} AND project_id = ${id.data}`);
      const repo = repos.rows[0];
      const connection =
        repo?.connection_id == null
          ? undefined
          : await readGitConnection(tx, teamId, repo.connection_id);
      const role = await tx.execute<{ role: string }>(sql`
        SELECT role FROM team_members WHERE team_id = ${teamId} AND user_id = ${userId}`);
      const branch = await tx.execute<{
        branch: string;
        pull_number: number;
        pull_url: string;
      }>(sql`
        SELECT branch, pull_number, pull_url FROM git_commit_branches
         WHERE team_id = ${teamId} AND project_id = ${id.data} AND user_id = ${userId}`);
      const pr = branch.rows[0];
      return {
        repo: {
          default_branch: repo?.default_branch ?? "main",
          direct_commits: connection?.directCommits === true,
          can_commit:
            access.can.edit &&
            role.rows[0]?.role !== "member" &&
            repo?.host_state === "active" &&
            connection?.accessLevel === "read_write",
          pull_request: pr ? { branch: pr.branch, number: pr.pull_number, url: pr.pull_url } : null,
          working_copy: await readWorkingCopy(tx, teamId, id.data, userId),
        },
      } satisfies RepoCommitInfo;
    });
    return info === undefined ? notFound() : c.json(info);
  });
  return app;
}
