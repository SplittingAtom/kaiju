import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { KaijuTx } from "../client.js";
import { gitConnections } from "../schema/git.js";
import {
  GIT_CAPABILITY_VALUES,
  GIT_EXCESS_PERMISSION_MAX_LENGTH,
  GIT_EXCESS_PERMISSIONS_MAX,
  type GitCapabilities,
  type GitConnectionRecord,
  type GitCredentialKind,
} from "./types.js";

/**
 * Reading git connections (KOBE-757, review M2). {@link readGitConnections} and
 * {@link readGitConnection} select only {@link gitConnectionPublicColumns}: never the sealed
 * credential or its key id. Routes, the admin MCP reads, health jobs and the egress proxy's
 * listings use them. The one path that needs the credential (opening it for one host call) uses
 * {@link readGitConnectionSealedCredential}, which returns nothing else. Callers run inside
 * `withTeam()` (RLS confines every read to the Workspace).
 */

const capability = z.enum(GIT_CAPABILITY_VALUES);

/** The stored shape of `git_connections.capabilities` (checked on write and on read). */
export const gitCapabilitiesSchema = z.strictObject({
  create: capability,
  read: capability,
  write: capability,
  admin: capability,
});

/** The stored shape of `git_connections.excess_permissions`. */
export const gitExcessPermissionsSchema = z
  .array(z.string().min(1).max(GIT_EXCESS_PERMISSION_MAX_LENGTH))
  .max(GIT_EXCESS_PERMISSIONS_MAX);

/** Validates capabilities before they are stored (e.g. from an adapter's probe). */
export function gitCapabilitiesForStorage(value: unknown): GitCapabilities {
  return gitCapabilitiesSchema.parse(value);
}

/** Every column except `credential_sealed` and `credential_key_id`. */
export const gitConnectionPublicColumns = {
  teamId: gitConnections.teamId,
  id: gitConnections.id,
  provider: gitConnections.provider,
  baseUrl: gitConnections.baseUrl,
  organization: gitConnections.organization,
  displayName: gitConnections.displayName,
  credentialKind: gitConnections.credentialKind,
  githubAppId: gitConnections.githubAppId,
  githubInstallationId: gitConnections.githubInstallationId,
  credentialHint: gitConnections.credentialHint,
  accessLevel: gitConnections.accessLevel,
  repoVisibility: gitConnections.repoVisibility,
  repoNamePrefix: gitConnections.repoNamePrefix,
  defaultBranch: gitConnections.defaultBranch,
  pushLimitBytes: gitConnections.pushLimitBytes,
  directCommits: gitConnections.directCommits,
  agentIds: gitConnections.agentIds,
  capabilities: gitConnections.capabilities,
  excessPermissions: gitConnections.excessPermissions,
  lastCheckedAt: gitConnections.lastCheckedAt,
  lastOkAt: gitConnections.lastOkAt,
  lastError: gitConnections.lastError,
  credentialExpiresAt: gitConnections.credentialExpiresAt,
  expiryNotifiedAt: gitConnections.expiryNotifiedAt,
  createdBy: gitConnections.createdBy,
  updatedBy: gitConnections.updatedBy,
  createdAt: gitConnections.createdAt,
  updatedAt: gitConnections.updatedAt,
  credentialUpdatedAt: gitConnections.credentialUpdatedAt,
} as const;

type PublicRow = {
  [
    K in keyof typeof gitConnectionPublicColumns
  ]: (typeof gitConnectionPublicColumns)[K]["_"]["data"] extends infer D
    ? (typeof gitConnectionPublicColumns)[K]["_"]["notNull"] extends true
      ? D
      : D | null
    : never;
};

export class GitConnectionShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitConnectionShapeError";
  }
}

/** A selected public row as the record server code passes around (capabilities re-validated). */
export function toGitConnectionRecord(row: PublicRow): GitConnectionRecord {
  const capabilities = gitCapabilitiesSchema.safeParse(row.capabilities);
  const excess = gitExcessPermissionsSchema.safeParse(row.excessPermissions);
  if (!capabilities.success || !excess.success) {
    throw new GitConnectionShapeError("a stored git connection has an invalid shape");
  }
  return {
    teamId: row.teamId,
    id: row.id,
    provider: row.provider,
    baseUrl: row.baseUrl,
    organization: row.organization,
    displayName: row.displayName,
    credentialKind: row.credentialKind,
    githubAppId: row.githubAppId,
    githubInstallationId: row.githubInstallationId,
    credentialHint: row.credentialHint,
    accessLevel: row.accessLevel,
    repoVisibility: row.repoVisibility,
    repoNamePrefix: row.repoNamePrefix,
    defaultBranch: row.defaultBranch,
    pushLimitBytes: row.pushLimitBytes,
    directCommits: row.directCommits,
    agentIds: row.agentIds,
    capabilities: capabilities.data,
    excessPermissions: excess.data,
    lastCheckedAt: row.lastCheckedAt,
    lastOkAt: row.lastOkAt,
    lastError: row.lastError,
    credentialExpiresAt: row.credentialExpiresAt,
    expiryNotifiedAt: row.expiryNotifiedAt,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    credentialUpdatedAt: row.credentialUpdatedAt,
  };
}

/** The Workspace's connections, oldest first, without credentials. */
export async function readGitConnections(
  tx: KaijuTx,
  teamId: string,
): Promise<GitConnectionRecord[]> {
  const rows = await tx
    .select(gitConnectionPublicColumns)
    .from(gitConnections)
    .where(eq(gitConnections.teamId, teamId))
    .orderBy(gitConnections.createdAt, gitConnections.id);
  return rows.map(toGitConnectionRecord);
}

/** One connection without its credential, or undefined. */
export async function readGitConnection(
  tx: KaijuTx,
  teamId: string,
  connectionId: string,
): Promise<GitConnectionRecord | undefined> {
  const [row] = await tx
    .select(gitConnectionPublicColumns)
    .from(gitConnections)
    .where(and(eq(gitConnections.teamId, teamId), eq(gitConnections.id, connectionId)));
  return row ? toGitConnectionRecord(row) : undefined;
}

/** The sealed credential of one connection, for `openGitCredential()` and a key rotation sweep. */
export interface GitSealedCredentialRow {
  readonly credentialKind: GitCredentialKind;
  readonly credentialSealed: string;
  readonly credentialKeyId: string;
}

/**
 * The ONLY reader of the sealed credential: for opening it for one host call (server or egress
 * proxy) or re-wrapping it. Its result must never be returned by an API, logged or audited.
 */
export async function readGitConnectionSealedCredential(
  tx: KaijuTx,
  teamId: string,
  connectionId: string,
): Promise<GitSealedCredentialRow | undefined> {
  const [row] = await tx
    .select({
      credentialKind: gitConnections.credentialKind,
      credentialSealed: gitConnections.credentialSealed,
      credentialKeyId: gitConnections.credentialKeyId,
    })
    .from(gitConnections)
    .where(and(eq(gitConnections.teamId, teamId), eq(gitConnections.id, connectionId)));
  return row;
}
