import { agentSkills, validateAgentDefinition, type AgentDefinition } from "@kobe/agent-file";
import {
  and,
  eq,
  siteAgents,
  siteAgentVersions,
  teamAgents,
  teamAgentVersions,
  type AuditActor,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import { canonicalJson, type AgentMemorySetting } from "@kobe/protocol";
import { recordAudit } from "../../audit/record.js";
import { readPublishFloor } from "../floor.js";
import { freezeLocalSkills } from "../skill-freeze.js";
import type { SkillManifest } from "../../skills/frozen.js";
import { computeToolManifest, type ToolManifest } from "../manifest.js";
import {
  auditTeam,
  inLocation,
  siteWhere,
  SITE,
  lockAgent,
  TEAM,
  toRecord,
  type AgentLocation,
  type AgentRecord,
  type Result,
  type Row,
} from "../store.js";
import {
  currentMemory,
  DEFAULT_VERSION_LIMITS,
  FULL_COLUMNS,
  readVersion,
  ref,
  TEAM_FULL_COLUMNS,
  toVersion,
  UnreadableVersionError,
  type FullRow,
  type Published,
  type PublishError,
  type VersionLimits,
} from "./records.js";

/**
 * Publishing agent versions (spec D19, KOBE-46): publish copies an agent's draft into an immutable
 * numbered version with a frozen tool manifest and moves `current_version` to it; rollback
 * republishes an older version's content as a new number (manifest recomputed against today's
 * floor). Every change locks the agent row first, so concurrent publishes get consecutive numbers.
 */

export interface NewVersion {
  readonly limits: VersionLimits;
  readonly definition: AgentDefinition;
  readonly publishedBy: string | null;
  readonly draftRevision: number | null;
  readonly republishedFrom: number | null;
  /** The manifest an eval scored; a different one now (the floor changed) refuses the publish. */
  readonly expectedManifest?: ToolManifest;
  /** A rollback restores the frozen skill versions of the version it republishes (KOBE-318). */
  readonly skillManifest?: SkillManifest | null;
  /**
   * The new version's memory setting (KOBE-646): a publish keeps the current version's, a
   * rollback restores the republished version's, a memory change sets it.
   */
  readonly memory: AgentMemorySetting;
}

/**
 * Content that makes two versions the same: definition, frozen tool manifest and, for team
 * versions, the frozen skill versions (KOBE-318): a republish that only picks up a newer skill
 * version is a new version.
 */
export const contentKey = (
  definition: AgentDefinition,
  manifest: ToolManifest,
  skills: SkillManifest | null = null,
): string =>
  canonicalJson({
    frontmatter: definition.frontmatter,
    prompt: definition.prompt,
    manifest,
    ...(skills ? { skills } : {}),
  });

/**
 * Whether `definition` + `manifest` (+ memory setting) equal the agent's current version (an
 * unreadable one never does).
 */
async function sameAsCurrent(
  tx: KobeTx,
  location: AgentLocation,
  agent: AgentRecord,
  definition: AgentDefinition,
  manifest: ToolManifest,
  skills: SkillManifest | null,
  memory: AgentMemorySetting,
): Promise<boolean> {
  if (agent.currentVersion === null) return false;
  try {
    const current = await readVersion(tx, location.scope, agent.id, agent.currentVersion);
    return (
      current !== null &&
      current.memory === memory &&
      contentKey(current.definition, current.toolManifest, current.skillManifest) ===
        contentKey(definition, manifest, skills)
    );
  } catch (err) {
    if (err instanceof UnreadableVersionError) return false;
    throw err;
  }
}

/**
 * Inserts the next version of the locked `agent` and points `current_version` at it. Refuses a
 * version identical to the current one (same definition and manifest: a republish that only picks
 * up a changed floor is not identical) and agents at the version cap.
 */
export async function insertVersion(
  tx: KobeTx,
  location: AgentLocation,
  agent: AgentRecord,
  input: NewVersion,
): Promise<Result<Published, "unchanged" | "version_limit" | "eval_stale">> {
  const now = new Date();
  const floor = await readPublishFloor(tx, location.scope === "team" ? "team" : "site");
  const manifest = computeToolManifest(input.definition.frontmatter, floor, now);
  if (input.expectedManifest && canonicalJson(input.expectedManifest) !== canonicalJson(manifest)) {
    return { ok: false, error: "eval_stale" };
  }
  // Team versions freeze their named local skills at publish (KOBE-318); a rollback restores
  // the frozen versions of the version it republishes.
  const frozen =
    location.scope !== "team" || input.skillManifest
      ? { manifest: input.skillManifest ?? null, leftOut: [] }
      : await freezeLocalSkills(
          tx,
          location.teamId,
          agentSkills(input.definition.frontmatter).names,
        );
  const skillManifest = frozen.manifest;
  if (
    await sameAsCurrent(
      tx,
      location,
      agent,
      input.definition,
      manifest,
      skillManifest,
      input.memory,
    )
  ) {
    return { ok: false, error: "unchanged" };
  }
  if ((agent.currentVersion ?? 0) >= input.limits.maxVersions) {
    return { ok: false, error: "version_limit" };
  }
  const values = {
    agentId: agent.id,
    version: (agent.currentVersion ?? 0) + 1,
    frontmatter: input.definition.frontmatter,
    prompt: input.definition.prompt,
    toolManifest: manifest,
    publishedBy: input.publishedBy,
    publishedAt: now,
    draftRevision: input.draftRevision,
    republishedFrom: input.republishedFrom,
    memory: input.memory,
  };
  let row: FullRow | undefined;
  let updated: Row | undefined;
  if (location.scope === "team") {
    if (values.publishedBy === null) throw new Error("team agent versions need a publisher");
    [row] = await tx
      .insert(teamAgentVersions)
      .values({
        ...values,
        publishedBy: values.publishedBy,
        teamId: location.teamId,
        skillManifest: skillManifest ?? { skills: [] },
      })
      .returning(TEAM_FULL_COLUMNS);
    [updated] = await tx
      .update(teamAgents)
      .set({ currentVersion: values.version, updatedAt: now })
      .where(eq(teamAgents.id, agent.id))
      .returning(TEAM);
  } else {
    [row] = await tx
      .insert(siteAgentVersions)
      .values(values)
      .returning(FULL_COLUMNS(siteAgentVersions));
    [updated] = await tx
      .update(siteAgents)
      .set({ currentVersion: values.version, updatedAt: now })
      .where(and(siteWhere(location), eq(siteAgents.id, agent.id)))
      .returning(SITE);
  }
  if (!row || !updated) throw new Error("agent version insert returned no row");
  return {
    ok: true,
    value: {
      agent: toRecord(location.scope, updated),
      version: toVersion(row),
      skillsLeftOut: frozen.leftOut,
    },
  };
}

export interface PublishDraftInput {
  readonly publishedBy: string | null;
  /** Audit actor when there is no signed-in request (the gallery seeder, KOBE-87). */
  readonly actor?: AuditActor;
  readonly expectedRevision: number | undefined;
  readonly limits?: VersionLimits;
  /** Runs in the same transaction after a successful publish (KOBE-494: the Customized mark). */
  readonly afterWrite?: (tx: KobeTx) => Promise<void>;
  /**
   * The new version's memory setting instead of the current version's (KOBE-646): adopt copies
   * the adopted version's into the copy's v1.
   */
  readonly memory?: AgentMemorySetting;
}

/**
 * Publishes the agent's draft as its next version (D19). With `expectedRevision`, only if the
 * draft is still that revision (the publisher's If-Match): nobody publishes changes they haven't
 * seen. The draft is validated again, so a draft stored under an older schema can't be frozen.
 */
export async function publishAgent(
  db: KobeDb,
  location: AgentLocation,
  id: string,
  input: PublishDraftInput,
): Promise<Result<Published, PublishError>> {
  return inLocation(db, location, (tx) => publishDraftIn(tx, location, id, input));
}

/**
 * {@link publishAgent} inside the caller's transaction (KOBE-568: adopt creates the copy and
 * publishes it as v1 atomically). `tx` must be the location's transaction.
 */
export async function publishDraftIn(
  tx: KobeTx,
  location: AgentLocation,
  id: string,
  input: PublishDraftInput,
): Promise<Result<Published, PublishError>> {
  const agent = await lockAgent(tx, location, id);
  if (!agent) return { ok: false, error: "not_found" };
  if (agent.archivedAt) return { ok: false, error: "archived" };
  if (input.expectedRevision !== undefined && agent.revision !== input.expectedRevision) {
    return { ok: false, error: "revision_mismatch" };
  }
  const draft = validateAgentDefinition({
    frontmatter: agent.frontmatter,
    prompt: agent.prompt,
  });
  if (!draft.ok) return { ok: false, error: "invalid_draft" };
  const inserted = await insertVersion(tx, location, agent, {
    limits: input.limits ?? DEFAULT_VERSION_LIMITS,
    definition: draft.definition,
    publishedBy: input.publishedBy,
    draftRevision: agent.revision,
    republishedFrom: null,
    memory: input.memory ?? (await currentMemory(tx, location, agent)),
  });
  if (!inserted.ok) return inserted;
  const published = inserted.value;
  await recordAudit(tx, {
    ...(input.actor ? { actor: input.actor } : {}),
    action: "agent.published",
    teamId: auditTeam(location),
    target: {
      ...ref(location, agent),
      version: published.version.version,
      draftRevision: agent.revision,
    },
  });
  await input.afterWrite?.(tx);
  return { ok: true, value: published };
}

/**
 * Publishes a draft snapshot that has already been evaluated (KOBE-93): the eval gate froze the
 * definition when Publish was asked for, so what is published is exactly what was scored, even if
 * the draft changed since. Same locking, limits and audit as `publishAgent`.
 */
export async function publishEvaluated(
  db: KobeDb,
  location: AgentLocation,
  id: string,
  input: {
    readonly definition: AgentDefinition;
    readonly draftRevision: number;
    readonly publishedBy: string;
    readonly limits?: VersionLimits;
    readonly expectedManifest?: ToolManifest;
  },
): Promise<Result<Published, PublishError>> {
  return inLocation(db, location, async (tx) => {
    const agent = await lockAgent(tx, location, id);
    if (!agent) return { ok: false, error: "not_found" };
    if (agent.archivedAt) return { ok: false, error: "archived" };
    const draft = validateAgentDefinition(input.definition);
    if (!draft.ok) return { ok: false, error: "invalid_draft" };
    const inserted = await insertVersion(tx, location, agent, {
      limits: input.limits ?? DEFAULT_VERSION_LIMITS,
      definition: draft.definition,
      publishedBy: input.publishedBy,
      draftRevision: input.draftRevision,
      republishedFrom: null,
      memory: await currentMemory(tx, location, agent),
      ...(input.expectedManifest ? { expectedManifest: input.expectedManifest } : {}),
    });
    if (!inserted.ok) return inserted;
    await recordAudit(tx, {
      action: "agent.published",
      teamId: auditTeam(location),
      target: {
        ...ref(location, agent),
        version: inserted.value.version.version,
        draftRevision: input.draftRevision,
      },
    });
    return inserted;
  });
}

/**
 * Rolls back (D19 "rollback republishes an older version"): `fromVersion`'s content becomes a new
 * version, with its manifest recomputed against today's floor. The draft is left alone (it may
 * hold the fix in progress). Threads keep their pins; new threads get the new version.
 */
export async function rollbackAgent(
  db: KobeDb,
  location: AgentLocation,
  id: string,
  input: {
    readonly publishedBy: string;
    readonly fromVersion: number;
    readonly limits?: VersionLimits;
    readonly expectedManifest?: ToolManifest;
    /** Runs in the same transaction after a successful rollback (KOBE-494). */
    readonly afterWrite?: (tx: KobeTx) => Promise<void>;
  },
): Promise<Result<Published, PublishError>> {
  return inLocation(db, location, async (tx) => {
    const agent = await lockAgent(tx, location, id);
    if (!agent) return { ok: false, error: "not_found" };
    if (agent.archivedAt) return { ok: false, error: "archived" };
    if (agent.currentVersion === input.fromVersion) return { ok: false, error: "already_current" };
    const source = await readVersion(tx, location.scope, id, input.fromVersion);
    if (!source) return { ok: false, error: "version_not_found" };
    const inserted = await insertVersion(tx, location, agent, {
      limits: input.limits ?? DEFAULT_VERSION_LIMITS,
      definition: source.definition,
      publishedBy: input.publishedBy,
      draftRevision: null,
      republishedFrom: source.version,
      skillManifest: source.skillManifest,
      memory: source.memory,
      ...(input.expectedManifest ? { expectedManifest: input.expectedManifest } : {}),
    });
    if (!inserted.ok) return inserted;
    const published = inserted.value;
    await recordAudit(tx, {
      action: "agent.rolled_back",
      teamId: auditTeam(location),
      target: {
        ...ref(location, agent),
        version: published.version.version,
        fromVersion: source.version,
      },
    });
    await input.afterWrite?.(tx);
    return { ok: true, value: published };
  });
}
