import type { AgentDefinition } from "@kobe/agent-file";
import {
  and,
  desc,
  eq,
  siteAgents,
  siteAgentVersions,
  lt,
  teamAgents,
  teamAgentVersions,
  type AgentScope,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import type { AgentMemorySetting } from "@kobe/protocol";
import type { SkillLeftOut } from "../skill-freeze.js";
import { skillManifestSchema, type SkillManifest } from "../../skills/frozen.js";
import { toolManifestSchema, withSiteNames, type ToolManifest } from "../manifest.js";
import { inLocation, siteWhere, type AgentLocation, type AgentRecord } from "../store.js";

/**
 * Published agent versions as stored (spec D19, KOBE-46): the records, their columns and reads.
 * Publishing is `publish.ts`; this module never imports it.
 */

export interface AgentVersionSummary {
  readonly version: number;
  /** Null for gallery versions the server published from the repo's definitions (KOBE-87). */
  readonly publishedBy: string | null;
  readonly publishedAt: Date;
  /** The draft revision published; null for a rollback. */
  readonly draftRevision: number | null;
  /** For a rollback or a memory change: the version it republished. */
  readonly republishedFrom: number | null;
  /** The version's memory setting (KOBE-646): `all`, `notes_only` or `off`. */
  readonly memory: AgentMemorySetting;
}

export interface AgentVersionRecord extends AgentVersionSummary {
  readonly agentId: string;
  readonly definition: AgentDefinition;
  readonly toolManifest: ToolManifest;
  /**
   * Team versions: the local skill versions frozen at publish (KOBE-318, SK28). Null for
   * personal and gallery versions, which have no team to freeze in.
   */
  readonly skillManifest: SkillManifest | null;
}

export type PublishError =
  | "not_found"
  | "revision_mismatch"
  | "archived"
  | "version_not_found"
  | "already_current"
  | "invalid_draft"
  | "unchanged"
  | "version_limit"
  /** The tool manifest changed since the eval scored it (KOBE-93): evaluate again. */
  | "eval_stale"
  /** A memory change (KOBE-646) needs a published version to republish. */
  | "not_published"
  /** The version is in Dangerous mode and the caller may not use it (AC1). */
  | "dangerous_forbidden";

/** Limits on versions (review M3): versions are immutable and never deleted by the app. */
export interface VersionLimits {
  /** Versions per agent (they only grow; `current_version` is the count). */
  readonly maxVersions: number;
}

/** Sane default: years of daily publishing per agent, small next to the per-team agent cap. */
export const DEFAULT_VERSION_LIMITS: VersionLimits = { maxVersions: 1000 };

export interface Published {
  readonly agent: AgentRecord;
  readonly version: AgentVersionRecord;
  /**
   * Named team skills this publish left out of the frozen manifest: none of their versions can
   * load (KOBE-318, review-318 B-S2). A publish warning; runs omit them until a republish.
   */
  readonly skillsLeftOut: readonly SkillLeftOut[];
}

const SUMMARY_COLUMNS = (t: typeof teamAgentVersions | typeof siteAgentVersions) => ({
  version: t.version,
  publishedBy: t.publishedBy,
  publishedAt: t.publishedAt,
  draftRevision: t.draftRevision,
  republishedFrom: t.republishedFrom,
  memory: t.memory,
});
export const FULL_COLUMNS = (t: typeof teamAgentVersions | typeof siteAgentVersions) => ({
  ...SUMMARY_COLUMNS(t),
  agentId: t.agentId,
  frontmatter: t.frontmatter,
  prompt: t.prompt,
  toolManifest: t.toolManifest,
});

/** Team versions also carry their frozen skill versions (KOBE-318). */
export const TEAM_FULL_COLUMNS = {
  ...FULL_COLUMNS(teamAgentVersions),
  skillManifest: teamAgentVersions.skillManifest,
};

export type FullRow = AgentVersionSummary & {
  agentId: string;
  frontmatter: Record<string, unknown>;
  prompt: string;
  toolManifest: Record<string, unknown>;
  skillManifest?: unknown;
};

/** A stored version whose tool or skill manifest doesn't parse (manual SQL, a future format). */
export class UnreadableVersionError extends Error {
  readonly code = "version_unreadable";
  constructor(
    readonly agentId: string,
    readonly version: number,
  ) {
    super(`agent ${agentId} version ${version} has an unreadable tool manifest`);
    this.name = "UnreadableVersionError";
  }
}

/**
 * A stored version as a record. The manifest is re-validated on every read: one that doesn't
 * parse throws `UnreadableVersionError` rather than run with an unknown tool set (fail closed).
 */
export function toVersion(row: FullRow): AgentVersionRecord {
  const { frontmatter, prompt, toolManifest, skillManifest, ...rest } = row;
  const manifest = toolManifestSchema.safeParse(withSiteNames(toolManifest));
  if (!manifest.success) throw new UnreadableVersionError(row.agentId, row.version);
  // Only team rows select the column; a team row without a readable one fails closed.
  const skills = "skillManifest" in row ? skillManifestSchema.safeParse(skillManifest) : undefined;
  if (skills && !skills.success) throw new UnreadableVersionError(row.agentId, row.version);
  return {
    ...rest,
    // Copied from a validated draft at publish time.
    definition: { frontmatter, prompt } as AgentDefinition,
    toolManifest: manifest.data,
    skillManifest: skills ? skills.data : null,
  };
}

/** Versions of an agent in `location`, newest first; null when the agent isn't there. */
export async function listVersions(
  db: KobeDb,
  location: AgentLocation,
  agentId: string,
  page: { before?: number | undefined; limit: number },
): Promise<AgentVersionSummary[] | null> {
  return inLocation(db, location, async (tx) => {
    if (!(await agentExists(tx, location, agentId))) return null;
    const t = location.scope === "team" ? teamAgentVersions : siteAgentVersions;
    return tx
      .select(SUMMARY_COLUMNS(t))
      .from(t)
      .where(and(eq(t.agentId, agentId), page.before ? lt(t.version, page.before) : undefined))
      .orderBy(desc(t.version))
      .limit(page.limit);
  });
}

/** One version of an agent in `location`; null when either doesn't exist there. */
export async function getVersion(
  db: KobeDb,
  location: AgentLocation,
  agentId: string,
  version: number,
): Promise<AgentVersionRecord | null> {
  return inLocation(db, location, async (tx) => {
    if (!(await agentExists(tx, location, agentId))) return null;
    return readVersion(tx, location.scope, agentId, version);
  });
}

async function agentExists(tx: KobeTx, location: AgentLocation, id: string): Promise<boolean> {
  const rows =
    location.scope === "team"
      ? await tx.select({ id: teamAgents.id }).from(teamAgents).where(eq(teamAgents.id, id))
      : await tx
          .select({ id: siteAgents.id })
          .from(siteAgents)
          .where(and(siteWhere(location), eq(siteAgents.id, id)));
  return rows.length > 0;
}

/** A version row by number (callers have already confined the agent to its location). */
export async function readVersion(
  tx: KobeTx,
  scope: AgentScope,
  agentId: string,
  version: number,
): Promise<AgentVersionRecord | null> {
  const [row]: FullRow[] =
    scope === "team"
      ? await tx
          .select(TEAM_FULL_COLUMNS)
          .from(teamAgentVersions)
          .where(
            and(eq(teamAgentVersions.agentId, agentId), eq(teamAgentVersions.version, version)),
          )
      : await tx
          .select(FULL_COLUMNS(siteAgentVersions))
          .from(siteAgentVersions)
          .where(
            and(eq(siteAgentVersions.agentId, agentId), eq(siteAgentVersions.version, version)),
          );
  return row ? toVersion(row) : null;
}

/** The audit target of an agent change. */
export const ref = (location: AgentLocation, agent: AgentRecord) => ({
  agentId: agent.id,
  scope: location.scope,
  slug: agent.slug,
});

/**
 * The memory setting a publish from the draft keeps (KOBE-646): the current version's, or `all`
 * for a first publish. The draft has no memory setting of its own; it changes only by
 * {@link setAgentMemory}.
 */
export async function currentMemory(
  tx: KobeTx,
  location: Pick<AgentLocation, "scope">,
  agent: Pick<AgentRecord, "id" | "currentVersion">,
): Promise<AgentMemorySetting> {
  if (agent.currentVersion === null) return "all";
  const t = location.scope === "team" ? teamAgentVersions : siteAgentVersions;
  const [row] = await tx
    .select({ memory: t.memory })
    .from(t)
    .where(and(eq(t.agentId, agent.id), eq(t.version, agent.currentVersion)));
  return row?.memory ?? "all";
}
