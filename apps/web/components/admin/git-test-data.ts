/**
 * Wire answers of `/v1/team/git/connections*` (snake_case, as the server sends them) for the Git
 * section's tests (KOBE-761). Typed against `@kobe/protocol`, so a shape change fails here.
 */
import type {
  GitConnectionAdminView,
  GitConnectionList,
  GitConnectionMemberView,
  GitTestReport,
} from "@kobe/protocol";

export const GIT_BASE = "/v1/team/git/connections";
export const ID = "11111111-1111-4111-8111-111111111111";
export const ID2 = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";

export function adminConnection(
  over: Partial<GitConnectionAdminView> = {},
): GitConnectionAdminView {
  return {
    id: ID,
    provider: "github",
    base_url: "https://github.com",
    organization: "acme",
    display_name: "acme on GitHub",
    access_level: "read_write",
    credential: {
      kind: "github_app",
      hint: null,
      github_app_id: 4242,
      github_installation_id: 777,
      updated_at: "2026-11-20T10:00:00.000Z",
      expires_at: null,
      expires_soon: false,
    },
    repo_defaults: { visibility: "private", name_prefix: "", default_branch: "main" },
    push_limit_bytes: 1024 * 1024 * 1024,
    direct_commits: false,
    agent_ids: null,
    capabilities: { create: "yes", read: "yes", write: "yes", admin: "no" },
    excess_permissions: [],
    health: {
      status: "ok",
      last_checked_at: "2026-11-22T09:00:00.000Z",
      last_ok_at: "2026-11-22T09:00:00.000Z",
      last_error: null,
    },
    created_by: USER,
    updated_by: null,
    created_at: "2026-11-20T10:00:00.000Z",
    updated_at: "2026-11-20T10:00:00.000Z",
    ...over,
  };
}

export function tokenConnection(
  over: Partial<GitConnectionAdminView> = {},
): GitConnectionAdminView {
  return adminConnection({
    id: ID2,
    provider: "forgejo",
    base_url: "https://code.example.org",
    organization: "infra",
    display_name: "infra on Forgejo",
    access_level: "read",
    credential: {
      kind: "access_token",
      hint: "••••9f3a",
      github_app_id: null,
      github_installation_id: null,
      updated_at: "2026-11-20T10:00:00.000Z",
      expires_at: null,
      expires_soon: false,
    },
    ...over,
  });
}

export function memberConnection(
  over: Partial<GitConnectionMemberView> = {},
): GitConnectionMemberView {
  return {
    id: ID,
    provider: "github",
    base_url: "https://github.com",
    organization: "acme",
    display_name: "acme on GitHub",
    access_level: "read_write",
    status: "ok",
    ...over,
  };
}

export function list(
  connections: GitConnectionList["connections"],
  over: Partial<GitConnectionList> = {},
): GitConnectionList {
  return {
    connections,
    site: { enabled: true, allowed_hosts: [] },
    limit: 5,
    envelope_configured: true,
    ...over,
  };
}

export function report(over: Partial<GitTestReport> = {}): GitTestReport {
  return {
    ok: true,
    provider: "github",
    organization: { login: "acme", name: "Acme Inc", kind: "organization" },
    host_version: null,
    actor: { kind: "app", login: "kobe-acme[bot]" },
    capabilities: { create: "yes", read: "yes", write: "yes", admin: "no" },
    excess_permissions: [],
    credential_expires_at: null,
    missing: [],
    warnings: [],
    ...over,
  };
}
