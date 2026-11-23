/**
 * Workspace git connections (`/v1/team/git/connections*`, KOBE-760; the Git section, KOBE-761).
 * Answers are `@kobe/protocol` git-connections.ts, camelized. Reads are open to every member
 * (members get the short view); every write needs `team.git.manage`.
 *
 * The credential (a token, or a GitHub App's private key) goes out once in a JSON body and is
 * never answered: no function here returns it, puts it in a URL or logs it. Callers build the
 * body from the form at submit time and drop it.
 */
import type {
  GitConnectionAdminView,
  GitConnectionList,
  GitConnectionMemberView,
  GitTeamSettings,
  GitTestReport,
} from "@kobe/protocol";
import { apiRequest, type ApiResult } from "../../../api/client";
import type { Camelized } from "../../../api/casing";

const enc = encodeURIComponent;
const BASE = "/v1/team/git/connections";

export type GitProvider = GitConnectionAdminView["provider"];
export type GitAccessLevel = GitConnectionAdminView["access_level"];
export type GitCredentialKind = GitConnectionAdminView["credential"]["kind"];
export type GitVisibility = GitConnectionAdminView["repo_defaults"]["visibility"];
export type GitCapabilities = Camelized<GitConnectionAdminView["capabilities"]>;

export type GitAdminConnection = Camelized<GitConnectionAdminView>;
export type GitMemberConnection = Camelized<GitConnectionMemberView>;
export type GitConnectionsAnswer = Omit<Camelized<GitConnectionList>, "connections"> & {
  readonly connections: readonly (GitAdminConnection | GitMemberConnection)[];
};
export type GitReport = Camelized<GitTestReport>;

/** A Workspace admin's view carries the credential summary; a member's does not. */
export function isAdminView(c: GitAdminConnection | GitMemberConnection): c is GitAdminConnection {
  return "credential" in c;
}

/** What goes on the wire for a credential (write-only; built at submit, never kept). */
export type GitCredentialInput =
  | { readonly kind: "access_token"; readonly token: string }
  | {
      readonly kind: "github_app";
      readonly app_id: number;
      readonly installation_id: number;
      readonly private_key: string;
    };

export interface GitTarget {
  readonly provider: GitProvider;
  /** Omitted for github.com. */
  readonly base_url?: string;
  readonly organization: string;
  readonly credential: GitCredentialInput;
  readonly access_level: GitAccessLevel;
}

/** Settings as the routes take them (snake_case wire names). */
export interface GitSettingsInput {
  readonly display_name?: string;
  readonly access_level?: GitAccessLevel;
  readonly repo_visibility?: GitVisibility;
  readonly repo_name_prefix?: string;
  readonly default_branch?: string;
  readonly push_limit_bytes?: number;
  readonly direct_commits?: boolean;
  readonly agent_ids?: readonly string[] | null;
}

export interface GitSaved {
  readonly connection: GitAdminConnection;
  readonly test: GitReport;
}

export interface GitChecked {
  readonly connection: GitAdminConnection;
  readonly test: GitReport | null;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly test?: GitFailureDetail;
  } | null;
}

/** A failed test's codes (`details.test` of an error answer): never the host's own words. */
export interface GitFailureDetail {
  readonly code: string;
  readonly reason?: string;
  readonly missingPermission?: string;
  readonly retryAt?: string;
}

export function listGitConnections(
  teamId: string,
  fetchFn?: typeof fetch,
): Promise<ApiResult<GitConnectionsAnswer>> {
  return apiRequest<GitConnectionsAnswer>(BASE, { teamId, fetchFn });
}

/** Tests without saving (G4). Errors keep their details (`test`), so the page can say why. */
export function testGitConnection(
  teamId: string,
  target: GitTarget,
): Promise<ApiResult<{ readonly test: GitReport }>> {
  return apiRequest(`${BASE}/test`, { method: "POST", json: target, teamId, errorDetails: true });
}

export function createGitConnection(
  teamId: string,
  target: GitTarget,
  settings: GitSettingsInput,
): Promise<ApiResult<GitSaved>> {
  return apiRequest(BASE, {
    method: "POST",
    json: { ...settings, ...target },
    teamId,
    errorDetails: true,
  });
}

export async function updateGitConnection(
  teamId: string,
  id: string,
  settings: GitSettingsInput,
): Promise<ApiResult<GitAdminConnection>> {
  const res = await apiRequest<{ connection: GitAdminConnection }>(`${BASE}/${enc(id)}`, {
    method: "PATCH",
    json: settings,
    teamId,
  });
  return res.ok ? { ...res, data: res.data.connection } : res;
}

export function replaceGitCredential(
  teamId: string,
  id: string,
  credential: GitCredentialInput,
): Promise<ApiResult<GitSaved>> {
  return apiRequest(`${BASE}/${enc(id)}/credential`, {
    method: "PUT",
    json: { credential },
    teamId,
    errorDetails: true,
  });
}

export function checkGitConnection(teamId: string, id: string): Promise<ApiResult<GitChecked>> {
  return apiRequest(`${BASE}/${enc(id)}/check`, { method: "POST", teamId, errorDetails: true });
}

export function removeGitConnection(
  teamId: string,
  id: string,
): Promise<ApiResult<{ readonly id: string; readonly repositoriesKept: number }>> {
  return apiRequest(`${BASE}/${enc(id)}`, { method: "DELETE", teamId });
}

export type GitWorkspaceSettings = Camelized<GitTeamSettings>;
export type GitCommitEmail = GitTeamSettings["commit_email"];

/** The Workspace's git settings (`team.git.manage`): the commit author email of sandbox commits. */
export function getGitSettings(teamId: string): Promise<ApiResult<GitWorkspaceSettings>> {
  return apiRequest("/v1/team/git/settings", { teamId });
}

export function setGitCommitEmail(
  teamId: string,
  commitEmail: GitCommitEmail,
): Promise<ApiResult<GitWorkspaceSettings>> {
  return apiRequest("/v1/team/git/settings", {
    method: "PATCH",
    json: { commit_email: commitEmail },
    teamId,
  });
}
