import type { GitConnectionRecord } from "@kobe/db";
import type { GitConnectionAdminView, GitConnectionMemberView } from "@kobe/protocol";

/**
 * What the connection routes answer (KOBE-760). Both views are built from a
 * `GitConnectionRecord`, the public shape `readGitConnection(s)` selects: the sealed credential
 * and its key id are never read for a view. Workspace admins (`team.git.manage`) get the whole
 * record (G4 capabilities, G6 expiry, health, settings); every other member gets what their
 * agents can reach (§7: "Members see connected organizations, read-only").
 */

/** Days before a token's expiry when admins are told and the console warns (G6). */
export const GIT_EXPIRY_NOTICE_DAYS = 14;
const DAY_MS = 86_400_000;

export type GitHealthStatus = "ok" | "failing" | "unchecked" | "not_allowed";

/** Health codes of a Site refusal (G3): Git turned off, or the host dropped from the list. */
const SITE_REFUSED = /^host_refused:site_(git_off|host_limit)$/;

export function healthStatus(c: GitConnectionRecord): GitHealthStatus {
  if (c.lastError !== null && SITE_REFUSED.test(c.lastError)) return "not_allowed";
  if (c.lastCheckedAt === null) return "unchecked";
  if (c.lastError !== null) return "failing";
  return "ok";
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

export function adminConnectionView(
  c: GitConnectionRecord,
  now = Date.now(),
): GitConnectionAdminView {
  const expires = c.credentialExpiresAt?.getTime() ?? null;
  return {
    id: c.id,
    provider: c.provider,
    base_url: c.baseUrl,
    organization: c.organization,
    display_name: c.displayName,
    access_level: c.accessLevel,
    credential: {
      kind: c.credentialKind,
      /** Masked (last characters of a token only); null for a GitHub App. */
      hint: c.credentialHint,
      github_app_id: c.githubAppId,
      github_installation_id: c.githubInstallationId,
      updated_at: c.credentialUpdatedAt.toISOString(),
      expires_at: iso(c.credentialExpiresAt),
      expires_soon: expires !== null && expires - now <= GIT_EXPIRY_NOTICE_DAYS * DAY_MS,
    },
    repo_defaults: {
      visibility: c.repoVisibility,
      name_prefix: c.repoNamePrefix,
      default_branch: c.defaultBranch,
    },
    push_limit_bytes: c.pushLimitBytes,
    direct_commits: c.directCommits,
    agent_ids: c.agentIds === null ? null : [...c.agentIds],
    capabilities: { ...c.capabilities },
    excess_permissions: [...c.excessPermissions],
    health: {
      status: healthStatus(c),
      last_checked_at: iso(c.lastCheckedAt),
      last_ok_at: iso(c.lastOkAt),
      /** A machine code (`auth_failed:credential_rejected`), never the host's message. */
      last_error: c.lastError,
    },
    created_by: c.createdBy,
    updated_by: c.updatedBy,
    created_at: c.createdAt.toISOString(),
    updated_at: c.updatedAt.toISOString(),
  };
}

export function memberConnectionView(c: GitConnectionRecord): GitConnectionMemberView {
  return {
    id: c.id,
    provider: c.provider,
    base_url: c.baseUrl,
    organization: c.organization,
    display_name: c.displayName,
    access_level: c.accessLevel,
    status: healthStatus(c),
    // KOBE-768: the Convert to repo dialog shows the new repository's name with it (G16).
    repo_name_prefix: c.repoNamePrefix,
  };
}
