import { isDangerousMode } from "@kobe/agent-file";
import type { KobeDb, KobeTx } from "@kobe/db";
import type { AgentMemorySetting } from "@kobe/protocol";
import { recordAudit } from "../../audit/record.js";
import { auditTeam, inLocation, lockAgent, type AgentLocation, type Result } from "../store.js";
import {
  DEFAULT_VERSION_LIMITS,
  readVersion,
  ref,
  type Published,
  type PublishError,
  type VersionLimits,
} from "./records.js";
import { insertVersion } from "./publish.js";

/**
 * Changes the agent's memory setting (KOBE-646, Chris Q3): the current version's content
 * (definition, frozen skill versions; tool manifest recomputed against today's floor, as a
 * rollback) is republished as a new version with `memory`, so threads and pinned roster entries
 * keep the version they have and "follow latest" picks the change up (agents-roster version
 * rule). The draft is left alone. `unchanged` when the setting is already `memory`.
 */
export async function setAgentMemory(
  db: KobeDb,
  location: AgentLocation,
  id: string,
  input: {
    readonly publishedBy: string;
    readonly memory: AgentMemorySetting;
    /**
     * Whether the caller may republish a Dangerous version (AC1). Checked on the version read
     * under the agent's lock, so a Dangerous publish just before cannot slip through.
     */
    readonly mayUseDangerousMode: boolean;
    readonly limits?: VersionLimits;
    /** Runs in the same transaction after a successful change (KOBE-494). */
    readonly afterWrite?: (tx: KobeTx) => Promise<void>;
  },
): Promise<Result<Published, PublishError>> {
  return inLocation(db, location, async (tx) => {
    const agent = await lockAgent(tx, location, id);
    if (!agent) return { ok: false, error: "not_found" };
    if (agent.archivedAt) return { ok: false, error: "archived" };
    if (agent.currentVersion === null) return { ok: false, error: "not_published" };
    const source = await readVersion(tx, location.scope, id, agent.currentVersion);
    if (!source) return { ok: false, error: "version_not_found" };
    if (isDangerousMode(source.definition.frontmatter) && !input.mayUseDangerousMode) {
      return { ok: false, error: "dangerous_forbidden" };
    }
    if (source.memory === input.memory) return { ok: false, error: "unchanged" };
    const inserted = await insertVersion(tx, location, agent, {
      limits: input.limits ?? DEFAULT_VERSION_LIMITS,
      definition: source.definition,
      publishedBy: input.publishedBy,
      draftRevision: null,
      republishedFrom: source.version,
      skillManifest: source.skillManifest,
      memory: input.memory,
    });
    if (!inserted.ok) return inserted;
    const published = inserted.value;
    await recordAudit(tx, {
      action: "agent.memory_changed",
      teamId: auditTeam(location),
      target: {
        ...ref(location, agent),
        version: published.version.version,
        fromVersion: source.version,
        memory: input.memory,
      },
    });
    await input.afterWrite?.(tx);
    return { ok: true, value: published };
  });
}
