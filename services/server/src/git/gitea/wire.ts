import { z } from "zod";
import { GitHostError } from "../provider-errors.js";
import type {
  GitComment,
  GitIssue,
  GitOrganization,
  GitPullRequest,
  GitRepository,
} from "../provider.js";

/**
 * Gitea/Forgejo `/api/v1` answers, validated (never trusted) and mapped to the neutral shapes.
 * Only the fields Kobe reads are checked; anything else the host adds is ignored.
 */

const id = z.union([z.number().int(), z.string().max(64)]).transform(String);
const text = z.string().max(4096);
const url = z.string().max(2048);

function parse<T>(schema: z.ZodType<T>, json: unknown): T {
  const out = schema.safeParse(json);
  if (!out.success) throw new GitHostError("unexpected");
  return out.data;
}

export function asVersion(json: unknown): string {
  return parse(z.object({ version: z.string().max(256) }), json).version;
}

export function asUser(json: unknown): { login: string; isAdmin: boolean } {
  const u = parse(
    z.object({ login: z.string().min(1).max(255), is_admin: z.boolean().optional() }),
    json,
  );
  return { login: u.login, isAdmin: u.is_admin === true };
}

export function asOrganization(json: unknown, webRoot: string): GitOrganization {
  const o = parse(
    z.object({
      id,
      // `username` is the org's name on every supported version; `name` is the older alias.
      username: z.string().max(255).optional(),
      name: z.string().max(255).optional(),
      full_name: text.optional(),
    }),
    json,
  );
  const name = o.username ?? o.name;
  if (!name) throw new GitHostError("unexpected");
  return {
    id: o.id,
    name,
    displayName: o.full_name || name,
    webUrl: `${webRoot}/${encodeURIComponent(name)}`,
  };
}

export interface OrgPermissions {
  readonly isOwner: boolean;
  readonly isAdmin: boolean;
  readonly canRead: boolean;
  readonly canWrite: boolean;
  readonly canCreateRepository: boolean;
}

export function asPermissions(json: unknown): OrgPermissions {
  const p = parse(
    z.object({
      is_owner: z.boolean(),
      is_admin: z.boolean(),
      can_write: z.boolean(),
      can_read: z.boolean(),
      can_create_repository: z.boolean(),
    }),
    json,
  );
  return {
    isOwner: p.is_owner,
    isAdmin: p.is_admin,
    canRead: p.can_read,
    canWrite: p.can_write,
    canCreateRepository: p.can_create_repository,
  };
}

const repository = z.object({
  id,
  name: z.string().min(1).max(255),
  full_name: z.string().max(512),
  owner: z.object({ login: z.string().max(255) }),
  default_branch: z.string().max(255).optional(),
  private: z.boolean(),
  empty: z.boolean().optional(),
  archived: z.boolean().optional(),
  html_url: url,
  clone_url: url,
  permissions: z
    .object({ admin: z.boolean(), push: z.boolean(), pull: z.boolean() })
    .partial()
    .optional(),
});

export function asRepository(json: unknown): { owner: string; value: GitRepository } {
  const r = parse(repository, json);
  return {
    owner: r.owner.login,
    value: {
      id: r.id,
      name: r.name,
      fullName: r.full_name,
      defaultBranch: r.default_branch || "main",
      private: r.private,
      empty: r.empty === true,
      archived: r.archived === true,
      webUrl: r.html_url,
      cloneUrl: r.clone_url,
      permissions: {
        read: r.permissions?.pull === true,
        write: r.permissions?.push === true,
        admin: r.permissions?.admin === true,
      },
    },
  };
}

export function asPullRequest(json: unknown): GitPullRequest {
  const p = parse(
    z.object({
      number: z.number().int().positive(),
      title: text,
      html_url: url,
      state: z.string().max(32),
      merged: z.boolean().optional(),
    }),
    json,
  );
  return {
    number: p.number,
    title: p.title,
    webUrl: p.html_url,
    state: p.merged === true ? "merged" : p.state === "closed" ? "closed" : "open",
  };
}

export function asIssue(json: unknown): GitIssue {
  const i = parse(
    z.object({ number: z.number().int().positive(), title: text, html_url: url }),
    json,
  );
  return { number: i.number, title: i.title, webUrl: i.html_url };
}

export function asComment(json: unknown): GitComment {
  const c = parse(z.object({ id, html_url: url }), json);
  return { id: c.id, webUrl: c.html_url };
}
