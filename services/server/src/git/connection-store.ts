import {
  GIT_CONNECTIONS_MAX,
  and,
  count,
  eq,
  gitCapabilitiesForStorage,
  gitConnections,
  gitConnectionPublicColumns,
  gitExcessPermissionsSchema,
  gitRepositories,
  inArray,
  isUniqueViolation,
  readGitConnection,
  sql,
  teamAgentRoster,
  teamAgents,
  toGitConnectionRecord,
  withTeam,
  type GitAccessLevel,
  type GitCapabilities,
  type GitConnectionRecord,
  type GitCredentialKind,
  type GitProvider,
  type GitRepoVisibility,
  type GitSealedCredentialRow,
  type KobeDb,
  type KobeTx,
  type SealedGitCredential,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";

/**
 * Writes of the connection routes and the health job (KOBE-760, spec G1, G2, G4, G6, G8, G20). Every
 * function is one short `withTeam()` transaction: no network call happens inside one (the routes
 * and the job probe the host before or after). Reads use the public columns; the only reads of the
 * sealed credential return it to the caller for opening once (cache invalidation), never to a
 * response. Audit rows carry ids, names and codes only.
 */

/** The audit `host` of a base URL: its lowercase host name. */
export function auditHost(baseUrl: string): string {
  return new URL(baseUrl).hostname.toLowerCase();
}

const lockConnections = (tx: KobeTx, teamId: string) =>
  // Serialises connects per Workspace so the cap (G2) holds under concurrent requests.
  tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kobe.git_connections:${teamId}`}, 0))`,
  );

export type CreateBlock = "connection_limit" | "already_connected";

async function blockOf(
  tx: KobeTx,
  teamId: string,
  baseUrl: string,
  organization: string,
): Promise<CreateBlock | undefined> {
  const [row] = await tx
    .select({
      total: count(),
      same: sql<number>`count(*) FILTER (WHERE ${gitConnections.baseUrl} = ${baseUrl}
        AND lower(${gitConnections.organization}) = lower(${organization}))`.mapWith(Number),
    })
    .from(gitConnections)
    .where(eq(gitConnections.teamId, teamId));
  if ((row?.same ?? 0) > 0) return "already_connected";
  if ((row?.total ?? 0) >= GIT_CONNECTIONS_MAX) return "connection_limit";
  return undefined;
}

/** A cheap check before probing the host (the insert checks again under the lock). */
export function precheckCreate(
  db: KobeDb,
  teamId: string,
  baseUrl: string,
  organization: string,
  agentIds: readonly string[] | null | undefined,
): Promise<CreateBlock | "unknown_agent" | undefined> {
  return withTeam(db, teamId, async (tx) => {
    const block = await blockOf(tx, teamId, baseUrl, organization);
    if (block) return block;
    return (await unknownAgents(tx, teamId, agentIds)) ? "unknown_agent" : undefined;
  });
}

/** Agent ids a connection may be limited to (GQ8): the Workspace's agents and roster entries. */
async function unknownAgents(
  tx: KobeTx,
  teamId: string,
  ids: readonly string[] | null | undefined,
): Promise<boolean> {
  if (ids === null || ids === undefined) return false;
  const wanted = [...new Set(ids.map((i) => i.toLowerCase()))];
  const team = await tx
    .select({ id: teamAgents.id })
    .from(teamAgents)
    .where(and(eq(teamAgents.teamId, teamId), inArray(teamAgents.id, wanted)));
  const roster = await tx
    .select({ id: teamAgentRoster.siteAgentId })
    .from(teamAgentRoster)
    .where(and(eq(teamAgentRoster.teamId, teamId), inArray(teamAgentRoster.siteAgentId, wanted)));
  const known = new Set([...team, ...roster].map((r) => r.id.toLowerCase()));
  return wanted.some((i) => !known.has(i));
}

/** What a passing test stores (G4, G6). */
export interface GitProbeColumns {
  readonly capabilities: GitCapabilities;
  readonly excessPermissions: readonly string[];
  readonly credentialExpiresAt: Date | null;
}

function probeColumns(p: GitProbeColumns, now: Date) {
  return {
    capabilities: gitCapabilitiesForStorage(p.capabilities),
    excessPermissions: gitExcessPermissionsSchema.parse(
      p.excessPermissions.map((e) => e.slice(0, 100)).slice(0, 50),
    ),
    credentialExpiresAt: p.credentialExpiresAt,
    lastCheckedAt: now,
    lastOkAt: now,
    lastError: null,
  };
}

export interface GitConnectionSettings {
  readonly displayName?: string | undefined;
  readonly accessLevel?: GitAccessLevel | undefined;
  readonly repoVisibility?: GitRepoVisibility | undefined;
  readonly repoNamePrefix?: string | undefined;
  readonly defaultBranch?: string | undefined;
  readonly pushLimitBytes?: number | undefined;
  readonly directCommits?: boolean | undefined;
  readonly agentIds?: readonly string[] | null | undefined;
}

export interface NewGitConnection {
  readonly teamId: string;
  readonly id: string;
  readonly userId: string;
  readonly provider: GitProvider;
  readonly baseUrl: string;
  readonly organization: string;
  readonly displayName: string;
  readonly credentialKind: GitCredentialKind;
  readonly sealed: SealedGitCredential;
  readonly credentialHint: string | null;
  readonly githubAppId: number | null;
  readonly githubInstallationId: number | null;
  readonly settings: GitConnectionSettings;
  readonly probe: GitProbeColumns;
}

export type InsertResult =
  | { readonly ok: true; readonly connection: GitConnectionRecord }
  | { readonly ok: false; readonly code: CreateBlock | "unknown_agent" };

/**
 * Stores a tested connection: under the Workspace's connect lock, the cap (G2) and the
 * (host, organization) pair are checked again in the same transaction as the insert.
 */
export async function insertGitConnection(db: KobeDb, n: NewGitConnection): Promise<InsertResult> {
  try {
    return await withTeam(db, n.teamId, async (tx): Promise<InsertResult> => {
      await lockConnections(tx, n.teamId);
      const block = await blockOf(tx, n.teamId, n.baseUrl, n.organization);
      if (block) return { ok: false, code: block };
      if (await unknownAgents(tx, n.teamId, n.settings.agentIds)) {
        return { ok: false, code: "unknown_agent" };
      }
      const now = new Date();
      const s = n.settings;
      const [row] = await tx
        .insert(gitConnections)
        .values({
          teamId: n.teamId,
          id: n.id,
          provider: n.provider,
          baseUrl: n.baseUrl,
          organization: n.organization,
          displayName: n.displayName,
          credentialKind: n.credentialKind,
          credentialSealed: n.sealed.credentialSealed,
          credentialKeyId: n.sealed.credentialKeyId,
          credentialHint: n.credentialHint,
          githubAppId: n.githubAppId,
          githubInstallationId: n.githubInstallationId,
          ...(s.accessLevel === undefined ? {} : { accessLevel: s.accessLevel }),
          ...(s.repoVisibility === undefined ? {} : { repoVisibility: s.repoVisibility }),
          ...(s.repoNamePrefix === undefined ? {} : { repoNamePrefix: s.repoNamePrefix }),
          ...(s.defaultBranch === undefined ? {} : { defaultBranch: s.defaultBranch }),
          ...(s.pushLimitBytes === undefined ? {} : { pushLimitBytes: s.pushLimitBytes }),
          ...(s.directCommits === undefined ? {} : { directCommits: s.directCommits }),
          ...(s.agentIds === undefined
            ? {}
            : { agentIds: s.agentIds === null ? null : [...s.agentIds] }),
          ...probeColumns(n.probe, now),
          createdBy: n.userId,
          createdAt: now,
          updatedAt: now,
          credentialUpdatedAt: now,
        })
        .returning(gitConnectionPublicColumns);
      if (!row) throw new Error("git connection insert returned no row");
      const connection = toGitConnectionRecord(row);
      await recordAudit(tx, {
        action: "git.connection.created",
        teamId: n.teamId,
        target: {
          connectionId: connection.id,
          provider: connection.provider,
          host: auditHost(connection.baseUrl),
          organization: connection.organization,
          credentialKind: connection.credentialKind,
          accessLevel: connection.accessLevel,
          excessPermissions: [...connection.excessPermissions].filter((p) =>
            /^[A-Za-z0-9_.:=-]{1,100}$/.test(p),
          ),
        },
      });
      return { ok: true, connection };
    });
  } catch (err) {
    // A concurrent connect of the same pair that the lock did not cover (it does: belt and braces).
    if (isUniqueViolation(err, "git_connections_org_unique")) {
      return { ok: false, code: "already_connected" };
    }
    throw err;
  }
}

const SETTING_COLUMNS = {
  display_name: "displayName",
  access_level: "accessLevel",
  repo_visibility: "repoVisibility",
  repo_name_prefix: "repoNamePrefix",
  default_branch: "defaultBranch",
  push_limit_bytes: "pushLimitBytes",
  direct_commits: "directCommits",
  agent_ids: "agentIds",
} as const satisfies Record<string, keyof GitConnectionSettings>;
type SettingField = keyof typeof SETTING_COLUMNS;

const sameValue = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export type UpdateResult =
  | { readonly ok: true; readonly connection: GitConnectionRecord; readonly changed: boolean }
  | { readonly ok: false; readonly code: "not_found" | "unknown_agent" | "internal_not_offered" };

/** Changes a connection's settings (G1, G11, GQ8, GQ11); audited when something changed. */
export function updateGitConnection(
  db: KobeDb,
  teamId: string,
  connectionId: string,
  userId: string,
  settings: GitConnectionSettings,
): Promise<UpdateResult> {
  return withTeam(db, teamId, async (tx): Promise<UpdateResult> => {
    const [locked] = await tx
      .select(gitConnectionPublicColumns)
      .from(gitConnections)
      .where(and(eq(gitConnections.teamId, teamId), eq(gitConnections.id, connectionId)))
      .for("update");
    if (!locked) return { ok: false, code: "not_found" };
    const current = toGitConnectionRecord(locked);
    // G10: internal visibility only where the host has it (GitHub organizations).
    if (settings.repoVisibility === "internal" && current.provider !== "github") {
      return { ok: false, code: "internal_not_offered" };
    }
    if (await unknownAgents(tx, teamId, settings.agentIds))
      return { ok: false, code: "unknown_agent" };
    const fields = (Object.keys(SETTING_COLUMNS) as SettingField[]).filter((f) => {
      const key = SETTING_COLUMNS[f];
      return settings[key] !== undefined && !sameValue(settings[key], current[key]);
    });
    if (fields.length === 0) return { ok: true, connection: current, changed: false };
    const set: Record<string, unknown> = { updatedBy: userId, updatedAt: new Date() };
    for (const f of fields) {
      const key = SETTING_COLUMNS[f];
      const value = settings[key];
      set[key] = Array.isArray(value) ? [...(value as readonly string[])] : value;
    }
    const [row] = await tx
      .update(gitConnections)
      .set(set)
      .where(and(eq(gitConnections.teamId, teamId), eq(gitConnections.id, connectionId)))
      .returning(gitConnectionPublicColumns);
    if (!row) return { ok: false, code: "not_found" };
    const connection = toGitConnectionRecord(row);
    const levelChanged = fields.includes("access_level");
    await recordAudit(tx, {
      action: "git.connection.updated",
      teamId,
      target: {
        connectionId,
        fields,
        ...(levelChanged
          ? { accessLevel: connection.accessLevel, previousAccessLevel: current.accessLevel }
          : {}),
      },
    });
    return { ok: true, connection, changed: true };
  });
}

export interface CredentialReplacement {
  readonly teamId: string;
  readonly connectionId: string;
  readonly userId: string;
  readonly credentialKind: GitCredentialKind;
  readonly sealed: SealedGitCredential;
  readonly credentialHint: string | null;
  readonly githubAppId: number | null;
  readonly githubInstallationId: number | null;
  readonly probe: GitProbeColumns;
}

export type ReplaceResult =
  | {
      readonly ok: true;
      readonly connection: GitConnectionRecord;
      /** The old sealed credential, only so the caller can drop its cached tokens. */
      readonly previous: GitSealedCredentialRow;
    }
  | { readonly ok: false; readonly code: "not_found" };

/** Replaces the sealed credential after a passing test (G8); the old ciphertext is overwritten. */
export function replaceGitCredential(db: KobeDb, r: CredentialReplacement): Promise<ReplaceResult> {
  return withTeam(db, r.teamId, async (tx): Promise<ReplaceResult> => {
    const [previous] = await tx
      .select({
        credentialKind: gitConnections.credentialKind,
        credentialSealed: gitConnections.credentialSealed,
        credentialKeyId: gitConnections.credentialKeyId,
      })
      .from(gitConnections)
      .where(and(eq(gitConnections.teamId, r.teamId), eq(gitConnections.id, r.connectionId)))
      .for("update");
    if (!previous) return { ok: false, code: "not_found" };
    const now = new Date();
    const [row] = await tx
      .update(gitConnections)
      .set({
        credentialKind: r.credentialKind,
        credentialSealed: r.sealed.credentialSealed,
        credentialKeyId: r.sealed.credentialKeyId,
        credentialHint: r.credentialHint,
        githubAppId: r.githubAppId,
        githubInstallationId: r.githubInstallationId,
        ...probeColumns(r.probe, now),
        expiryNotifiedAt: null,
        credentialUpdatedAt: now,
        updatedBy: r.userId,
        updatedAt: now,
      })
      .where(and(eq(gitConnections.teamId, r.teamId), eq(gitConnections.id, r.connectionId)))
      .returning(gitConnectionPublicColumns);
    if (!row) return { ok: false, code: "not_found" };
    await recordAudit(tx, {
      action: "git.connection.credential_replaced",
      teamId: r.teamId,
      target: {
        connectionId: r.connectionId,
        credentialKind: r.credentialKind,
        previousCredentialKind: previous.credentialKind,
      },
    });
    return { ok: true, connection: toGitConnectionRecord(row), previous };
  });
}

export type RemoveResult =
  | {
      readonly ok: true;
      readonly connection: GitConnectionRecord;
      readonly previous: GitSealedCredentialRow;
      readonly repositories: number;
    }
  | { readonly ok: false; readonly code: "not_found" };

/**
 * Disconnects (G8, G20): deletes the row and with it the credential; the Workspace's repository
 * records stay, marked `unreachable` (the key clears their `connection_id`). Nothing is sent to
 * the host.
 */
export function removeGitConnection(
  db: KobeDb,
  teamId: string,
  connectionId: string,
): Promise<RemoveResult> {
  return withTeam(db, teamId, async (tx): Promise<RemoveResult> => {
    const [locked] = await tx
      .select({
        ...gitConnectionPublicColumns,
        credentialSealed: gitConnections.credentialSealed,
        credentialKeyId: gitConnections.credentialKeyId,
      })
      .from(gitConnections)
      .where(and(eq(gitConnections.teamId, teamId), eq(gitConnections.id, connectionId)))
      .for("update");
    if (!locked) return { ok: false, code: "not_found" };
    const { credentialSealed, credentialKeyId, ...publicRow } = locked;
    const connection = toGitConnectionRecord(publicRow);
    const kept = await tx
      .update(gitRepositories)
      .set({ hostState: "unreachable", updatedAt: new Date() })
      .where(
        and(eq(gitRepositories.teamId, teamId), eq(gitRepositories.connectionId, connectionId)),
      )
      .returning({ id: gitRepositories.id });
    await tx
      .delete(gitConnections)
      .where(and(eq(gitConnections.teamId, teamId), eq(gitConnections.id, connectionId)));
    await recordAudit(tx, {
      action: "git.connection.removed",
      teamId,
      target: {
        connectionId,
        provider: connection.provider,
        host: auditHost(connection.baseUrl),
        organization: connection.organization,
        repositories: kept.length,
      },
    });
    return {
      ok: true,
      connection,
      previous: { credentialKind: connection.credentialKind, credentialSealed, credentialKeyId },
      repositories: kept.length,
    };
  });
}

/** The outcome of a health check (G6, §7), stored only if the credential did not change since. */
export type HealthOutcome =
  | { readonly ok: true; readonly probe: GitProbeColumns }
  | { readonly ok: false; readonly error: string };

/**
 * Stores a health check's outcome. `credentialUpdatedAt` is the credential the check used: a
 * check that raced a credential replacement is dropped (the new credential was just tested).
 */
export async function storeGitHealth(
  db: KobeDb,
  teamId: string,
  connectionId: string,
  credentialUpdatedAt: Date,
  outcome: HealthOutcome,
): Promise<GitConnectionRecord | undefined> {
  return withTeam(db, teamId, async (tx) => {
    const now = new Date();
    const [row] = await tx
      .update(gitConnections)
      .set(
        outcome.ok
          ? probeColumns(outcome.probe, now)
          : { lastCheckedAt: now, lastError: outcome.error.slice(0, 64) },
      )
      .where(
        and(
          eq(gitConnections.teamId, teamId),
          eq(gitConnections.id, connectionId),
          // Millisecond precision: the value went through a JS Date.
          sql`date_trunc('milliseconds', ${gitConnections.credentialUpdatedAt}) = ${credentialUpdatedAt.toISOString()}::timestamptz`,
        ),
      )
      .returning(gitConnectionPublicColumns);
    return row ? toGitConnectionRecord(row) : await readGitConnection(tx, teamId, connectionId);
  });
}
