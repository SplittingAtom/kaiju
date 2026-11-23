import {
  GIT_CONNECTIONS_MAX,
  readGitConnection,
  readGitConnections,
  readGitSiteSettings,
  withTeam,
} from "@kobe/db";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import { teamRoleAllows } from "../authz/permissions.js";
import type { ServerDeps } from "../deps.js";
import {
  gitConnectionCreateBodySchema,
  gitConnectionCredentialBodySchema,
  gitConnectionTestBodySchema,
  gitConnectionUpdateBodySchema,
} from "../git/connection-schemas.js";
import { updateGitConnection } from "../git/connection-store.js";
import { adminConnectionView, memberConnectionView } from "../git/connection-view.js";
import {
  checkGitConnectionNow,
  createGitConnection,
  gitConnectionDeps,
  removeGitConnectionNow,
  replaceGitConnectionCredential,
  testGitConnection,
  type Answer,
} from "../git/connections.js";
import { invalidRequest, param, parseBody } from "../http/request.js";
import { gitNoReplyEmail } from "../git/sandbox-git.js";
import {
  gitTeamSettingsBodySchema,
  readGitCommitEmail,
  writeGitCommitEmail,
} from "../git/team-git-settings.js";

/** Largest request body the git routes read (review L5). */
export const GIT_BODY_MAX_BYTES = 64 * 1024;

const send = (c: Context, a: Answer) => c.json(a.body, a.status);
const notFound = (c: Context) =>
  c.json({ code: "connection_not_found", message: "That git connection does not exist." }, 404);

/** Validation refusals never echo the request (it may hold a credential). */
const CREDENTIAL_SHAPE =
  'credential is {"kind": "access_token", "token"} or (GitHub) {"kind": "github_app", "app_id", ' +
  '"installation_id", "private_key"}';
const TARGET_HELP = `Send provider (github, gitea, forgejo), base_url (needed for Gitea and Forgejo), organization and ${CREDENTIAL_SHAPE}.`;

/**
 * Workspace git connections (`/v1/team/git`, KOBE-760; spec workspace-git §3, §4, §7, §8). Every
 * member reads which organizations the Workspace is connected to (§7: their agents can reach
 * them), without credential details or health internals; Workspace admins (`team.git.manage`)
 * see the whole record and test, connect, change, replace the credential, check and disconnect.
 * Connecting and credential changes are console-only: the Kobe admin MCP offers the reads alone
 * (§7). The credential is accepted on create and replace, sealed, and never answered, logged or
 * audited (G8).
 */
export function teamGitRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  const git = gitConnectionDeps(deps);
  app.use(requireTeam(deps));
  // Bodies are small (a PEM key is a few KB): refuse anything larger before reading it (review L5).
  app.use(
    bodyLimit({
      maxSize: GIT_BODY_MAX_BYTES,
      onError: (c) =>
        c.json({ code: "too_large", message: "The request body is over 64 KiB." }, 413),
    }),
  );

  app.get("/connections", requireTeamPermission("team.read"), async (c) => {
    const teamId = c.get("team").id;
    const manager = teamRoleAllows(c.get("team").role, "team.git.manage");
    const [connections, site] = await Promise.all([
      withTeam(db, teamId, (tx) => readGitConnections(tx, teamId)),
      readGitSiteSettings(db),
    ]);
    const now = Date.now();
    return c.json({
      connections: connections.map((x) =>
        manager ? adminConnectionView(x, now) : memberConnectionView(x),
      ),
      // The Site ceiling (G3), so the console can say why connecting is not offered.
      site: manager
        ? { enabled: site.enabled, allowed_hosts: [...site.allowedHosts] }
        : { enabled: site.enabled },
      limit: GIT_CONNECTIONS_MAX,
      envelope_configured: git.envelope !== undefined,
    });
  });

  app.get("/connections/:id", requireTeamPermission("team.read"), async (c) => {
    const id = param(c, "id", z.uuid());
    if (!id.success) return notFound(c);
    const teamId = c.get("team").id;
    const found = await withTeam(db, teamId, (tx) => readGitConnection(tx, teamId, id.data));
    if (!found) return notFound(c);
    const manager = teamRoleAllows(c.get("team").role, "team.git.manage");
    return c.json({
      connection: manager ? adminConnectionView(found) : memberConnectionView(found),
    });
  });

  app.post("/connections/test", requireTeamPermission("team.git.manage"), async (c) => {
    const body = await parseBody(c, gitConnectionTestBodySchema);
    if (!body) return invalidRequest(c, TARGET_HELP);
    return send(c, await testGitConnection(git, c.get("team").id, c.get("user").id, body));
  });

  app.post("/connections", requireTeamPermission("team.git.manage"), async (c) => {
    const body = await parseBody(c, gitConnectionCreateBodySchema);
    if (!body) {
      return invalidRequest(
        c,
        `${TARGET_HELP} Optional: display_name, access_level, repo_visibility, repo_name_prefix, default_branch, push_limit_bytes, direct_commits, agent_ids.`,
      );
    }
    return send(c, await createGitConnection(git, c.get("team").id, c.get("user").id, body));
  });

  app.patch("/connections/:id", requireTeamPermission("team.git.manage"), async (c) => {
    const id = param(c, "id", z.uuid());
    const body = await parseBody(c, gitConnectionUpdateBodySchema);
    if (!body) {
      return invalidRequest(
        c,
        "Send at least one of display_name, access_level, repo_visibility, repo_name_prefix, default_branch, push_limit_bytes, direct_commits, agent_ids.",
      );
    }
    if (!id.success) return notFound(c);
    const result = await updateGitConnection(db, c.get("team").id, id.data, c.get("user").id, {
      displayName: body.display_name,
      accessLevel: body.access_level,
      repoVisibility: body.repo_visibility,
      repoNamePrefix: body.repo_name_prefix,
      defaultBranch: body.default_branch,
      pushLimitBytes: body.push_limit_bytes,
      directCommits: body.direct_commits,
      agentIds: body.agent_ids,
    });
    if (result.ok) return c.json({ connection: adminConnectionView(result.connection) });
    if (result.code === "not_found") return notFound(c);
    if (result.code === "unknown_agent") {
      return c.json(
        { code: "unknown_agent", message: "An agent in agent_ids is not one of this Workspace's." },
        422,
      );
    }
    return c.json(
      {
        code: "internal_not_offered",
        message: "Gitea and Forgejo have no internal repositories: choose private.",
      },
      422,
    );
  });

  app.put("/connections/:id/credential", requireTeamPermission("team.git.manage"), async (c) => {
    const id = param(c, "id", z.uuid());
    const body = await parseBody(c, gitConnectionCredentialBodySchema);
    if (!body) return invalidRequest(c, `Send {"credential"}: ${CREDENTIAL_SHAPE}.`);
    if (!id.success) return notFound(c);
    return send(
      c,
      await replaceGitConnectionCredential(
        git,
        c.get("team").id,
        c.get("user").id,
        id.data,
        body.credential,
      ),
    );
  });

  app.post("/connections/:id/check", requireTeamPermission("team.git.manage"), async (c) => {
    const id = param(c, "id", z.uuid());
    if (!id.success) return notFound(c);
    return send(c, await checkGitConnectionNow(git, c.get("team").id, c.get("user").id, id.data));
  });

  app.delete("/connections/:id", requireTeamPermission("team.git.manage"), async (c) => {
    const id = param(c, "id", z.uuid());
    if (!id.success) return notFound(c);
    return send(c, await removeGitConnectionNow(git, c.get("team").id, id.data));
  });

  // The Workspace's git settings (KOBE-761): the author email of sandbox commits (G13, GQ10).
  // Console-only, like connecting: the Kobe admin MCP has no tool for it.
  const settingsAnswer = (c: Context<{ Variables: TeamVariables }>, mode: string) => {
    const user = c.get("user");
    // Read per request (as run starts do), so a deps without a valid public URL still mounts.
    const siteHost = new URL(deps.publicUrl).hostname;
    return {
      commit_email: mode,
      noreply_example: gitNoReplyEmail({ id: user.id, name: user.name }, siteHost),
    };
  };

  app.get("/settings", requireTeamPermission("team.git.manage"), async (c) =>
    c.json(settingsAnswer(c, await readGitCommitEmail(db, c.get("team").id))),
  );

  app.patch("/settings", requireTeamPermission("team.git.manage"), async (c) => {
    const body = await parseBody(c, gitTeamSettingsBodySchema);
    if (!body) return invalidRequest(c, 'Send {"commit_email": "member" | "noreply"}.');
    const mode = await writeGitCommitEmail(db, c.get("team").id, body.commit_email);
    return c.json(settingsAnswer(c, mode));
  });

  return app;
}
