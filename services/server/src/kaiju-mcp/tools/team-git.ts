import { gitConnectionAdminViewSchema } from "@kaiju/protocol";
import { z } from "zod";
import { cursorSchema, kaijuTool, page } from "../catalog.js";

/**
 * Team console › Git (`/v1/team/git/connections`, page permission `team.git.manage`; KOBE-760,
 * spec workspace-git §7): the page's reads only. Connecting, changing, replacing a credential and
 * disconnecting stay in the console, like injected headers. Not even the masked token hint is
 * passed on: the answer goes to a model.
 */

const connectionsAnswer = z.object({
  connections: z.array(gitConnectionAdminViewSchema),
  site: z.object({ enabled: z.boolean() }),
});

const level = z.enum(["off", "read", "read_write"]);
const capability = z.enum(["yes", "no", "unknown"]);

export const teamGitConnectionsList = kaijuTool({
  name: "team_git_connections_list",
  title: "List the team's git connections",
  description:
    "Lists the git organizations the conversation's team is connected to (Team console › Git): " +
    "host, organization, access level, what the credential may do, health and token expiry. " +
    "Never a credential. Connecting and credential changes are console-only. Paged: pass " +
    "next_cursor back as cursor.",
  scope: "team",
  permission: "team.git.manage",
  readOnly: true,
  input: z.strictObject({ cursor: cursorSchema.optional() }),
  output: z.strictObject({
    site_git_enabled: z.boolean(),
    connections: z
      .array(
        z.strictObject({
          connection_id: z.uuid(),
          display_name: z.string().max(100),
          provider: z.enum(["github", "gitea", "forgejo"]),
          base_url: z.string().max(2048),
          organization: z.string().max(100),
          access_level: level,
          credential_kind: z.enum(["github_app", "access_token"]),
          capabilities: z.strictObject({
            create: capability,
            read: capability,
            write: capability,
            admin: capability,
          }),
          excess_permissions: z.array(z.string().max(100)).max(50),
          health: z.enum(["ok", "failing", "unchecked", "not_allowed"]),
          last_error: z.string().max(64).nullable(),
          last_checked_at: z.string().nullable(),
          credential_expires_at: z.string().nullable(),
        }),
      )
      .max(50),
    next_cursor: cursorSchema.optional(),
  }),
  route: () => ({ method: "GET", path: "/team/git/connections" }),
  reduce: (body, input) => {
    const answer = connectionsAnswer.parse(body);
    const { rows, next_cursor } = page(answer.connections, input.cursor);
    return {
      site_git_enabled: answer.site.enabled,
      connections: rows.map((c) => ({
        connection_id: c.id,
        display_name: c.display_name.slice(0, 100),
        provider: c.provider,
        base_url: c.base_url.slice(0, 2048),
        organization: c.organization.slice(0, 100),
        access_level: c.access_level,
        credential_kind: c.credential.kind,
        capabilities: c.capabilities,
        excess_permissions: c.excess_permissions.slice(0, 50).map((p) => p.slice(0, 100)),
        health: c.health.status,
        last_error: c.health.last_error?.slice(0, 64) ?? null,
        last_checked_at: c.health.last_checked_at,
        credential_expires_at: c.credential.expires_at,
      })),
      ...(next_cursor === undefined ? {} : { next_cursor }),
    };
  },
});
