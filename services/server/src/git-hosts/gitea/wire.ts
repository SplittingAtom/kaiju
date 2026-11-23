import { z } from "zod";
import {
  GitHostError,
  type GitCreated,
  type GitOrganization,
  type GitRepository,
} from "../adapter.js";

/**
 * Gitea/Forgejo `/api/v1` answers, validated (never trusted) and mapped to the shared shapes
 * (KOBE-759). Only the fields Kobe reads are checked; anything else the host adds is ignored.
 */

const id = z.union([z.number().int(), z.string().max(64)]).transform(String);
const url = z.string().max(2048);

function parse<T>(schema: z.ZodType<T>, json: unknown): T {
  const out = schema.safeParse(json);
  if (!out.success) throw new GitHostError("unexpected", "The git host gave an unexpected answer.");
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
      full_name: z.string().max(4096).optional(),
    }),
    json,
  );
  const login = o.username ?? o.name;
  if (!login) throw new GitHostError("unexpected", "The git host gave an unexpected answer.");
  return {
    id: o.id,
    login,
    name: o.full_name ? o.full_name : null,
    kind: "organization",
    webUrl: `${webRoot}/${encodeURIComponent(login)}`,
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

export interface GiteaRepository {
  readonly owner: string;
  readonly value: GitRepository;
  /** What the token's account may do there (pull, push). */
  readonly canRead: boolean;
  readonly canWrite: boolean;
}

export function asRepository(json: unknown): GiteaRepository {
  const r = parse(repository, json);
  const empty = r.empty === true;
  return {
    owner: r.owner.login,
    canRead: r.permissions?.pull === true,
    canWrite: r.permissions?.push === true,
    value: {
      id: r.id,
      name: r.name,
      fullName: r.full_name,
      // Gitea and Forgejo have no internal repositories.
      visibility: r.private ? "private" : "public",
      // An empty repository reports its configured default branch, but has none yet.
      defaultBranch: empty ? null : r.default_branch || null,
      archived: r.archived === true,
      empty,
      webUrl: r.html_url,
      cloneUrl: r.clone_url,
    },
  };
}

export function asCreated(json: unknown, withNumber: boolean): GitCreated {
  const c = parse(
    z.object({ id, number: z.number().int().positive().optional(), html_url: url }),
    json,
  );
  return { id: c.id, number: withNumber ? (c.number ?? null) : null, webUrl: c.html_url };
}
