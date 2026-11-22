import { suspendedInTeam } from "../inventory.js";
import { validateAgentDefinition } from "@kobe/agent-file";
import {
  and,
  eq,
  siteAgents,
  teamAgents,
  teamMembers,
  type AgentScope,
  type KobeTx,
} from "@kobe/db";
import { agentAccess, type AgentActor } from "../access.js";
import { readPublishFloor } from "../floor.js";
import {
  isLentAgent,
  keptLentAgent,
  lentAgent,
  siteVisibleIn,
  switchTarget,
} from "../roster-resolution.js";
import { computeToolManifest } from "../manifest.js";
import { SITE, TEAM, toRecord, type AgentRecord, type Result, type Row } from "../store.js";
import {
  currentMemory,
  readVersion,
  UnreadableVersionError,
  type AgentVersionRecord,
} from "./records.js";

// --- Thread pins (D19: threads pin the version they started on) ------------------------------

/** What a thread stores to pin an agent version. */
export interface AgentPin {
  readonly agentScope: AgentScope;
  readonly agentId: string;
  readonly agentVersion: number;
}

/** A test thread's pin (KOBE-85): the agent, with no version: it runs the draft as it is. */
export interface DraftPin {
  readonly agentScope: AgentScope;
  readonly agentId: string;
  readonly agentVersion: null;
}

/** Who is asking, inside the thread's `withTeam` transaction. */
export interface PinViewer {
  readonly teamId: string;
  readonly userId: string;
}

export type PinError = "agent_not_found" | "agent_unavailable" | "version_not_found";

/**
 * The agent `agentId` as the user sees it from the active team: a team agent of that team (RLS),
 * one of the user's own personal agents, or a gallery agent. Anything else is "not found".
 * `lock` takes `FOR SHARE` on the agent row for the rest of `tx`, so a concurrent archive, suspend
 * or publish can't commit between this check and the pin being written. Lock order: thread row
 * (if any) before agent row; agent changes (`lockAgent`) never lock threads.
 */
export async function findPinnableAgent(
  tx: KobeTx,
  viewer: PinViewer,
  agentId: string,
  options: { lock?: boolean } = {},
): Promise<AgentRecord | null> {
  const teamQuery = tx
    .select(TEAM)
    .from(teamAgents)
    .where(and(eq(teamAgents.teamId, viewer.teamId), eq(teamAgents.id, agentId)));
  const [team]: Row[] = await (options.lock ? teamQuery.for("share") : teamQuery);
  if (team) return toRecord("team", team);
  const siteQuery = tx
    .select({ ...SITE, scope: siteAgents.scope })
    .from(siteAgents)
    .where(and(eq(siteAgents.id, agentId), siteVisibleIn(viewer)));
  const [own]: (Row & { scope: "personal" | "gallery" })[] = await (options.lock
    ? siteQuery.for("share")
    : siteQuery);
  if (!own) return lentAgent(tx, viewer, agentId, options);
  const { scope, ...row } = own;
  const record = toRecord(scope, row);
  // A team can suspend a site-wide agent for itself (KOBE-86): effective status here.
  return record.status === "active" && (await suspendedInTeam(tx, viewer.teamId, agentId))
    ? { ...record, status: "suspended" }
    : record;
}

/** An agent's effective state in the viewer's team, for display (KOBE-122). */
export function agentStatusOf(agent: AgentRecord): "active" | "suspended" | "archived" {
  if (agent.archivedAt !== null) return "archived";
  return agent.status === "suspended" ? "suspended" : "active";
}

/** Why an agent can't be pinned by a new thread or a switch, if it can't. */
function unavailable(agent: AgentRecord): boolean {
  return agent.status !== "active" || agent.archivedAt !== null || agent.currentVersion === null;
}

/** Whether a new thread may pin this agent (`status` already the team's effective one). */
export const canPinAgent = (agent: AgentRecord): boolean => !unavailable(agent);

/**
 * The pin a new thread takes for `agentId` (`POST /v1/threads`): the agent's current published
 * version. Null agent → null pin (the site default agent). Suspended, archived and never
 * published agents can't start threads.
 */
export async function resolveAgentPin(
  tx: KobeTx,
  viewer: PinViewer,
  agentId: string | null,
): Promise<Result<AgentPin | null, PinError>> {
  if (agentId === null) return { ok: true, value: null };
  const agent = await findPinnableAgent(tx, viewer, agentId, { lock: true });
  if (!agent) return { ok: false, error: "agent_not_found" };
  if (unavailable(agent) || agent.currentVersion === null) {
    return { ok: false, error: "agent_unavailable" };
  }
  return {
    ok: true,
    value: { agentScope: agent.scope, agentId: agent.id, agentVersion: agent.currentVersion },
  };
}

/**
 * The pin of a builder test thread (KOBE-85): the agent's draft, never a version. Only someone who
 * may edit the agent can test it (anything else is "not found"); suspended and archived agents
 * can't, like for any thread. A draft that was never published is fine.
 */
export async function resolveDraftPin(
  tx: KobeTx,
  viewer: PinViewer,
  actor: AgentActor,
  agentId: string,
): Promise<Result<DraftPin, PinError>> {
  const agent = await findPinnableAgent(tx, viewer, agentId, { lock: true });
  if (!agent || !agentAccess(actor, agent).edit) return { ok: false, error: "agent_not_found" };
  if (agent.status !== "active" || agent.archivedAt !== null) {
    return { ok: false, error: "agent_unavailable" };
  }
  return { ok: true, value: { agentScope: agent.scope, agentId: agent.id, agentVersion: null } };
}

/**
 * The pin for switching an existing thread (one-click switch, D19): `version` (default: the
 * agent's current version) of the agent the thread is already pinned to, in the same scope.
 */
export async function resolveSwitchPin(
  tx: KobeTx,
  viewer: PinViewer,
  current: Pick<AgentPin, "agentScope" | "agentId">,
  version: number | undefined,
): Promise<Result<AgentPin, PinError>> {
  const agent = await findPinnableAgent(tx, viewer, current.agentId, { lock: true });
  if (!agent || agent.scope !== current.agentScope) return { ok: false, error: "agent_not_found" };
  if (unavailable(agent) || agent.currentVersion === null) {
    return { ok: false, error: "agent_unavailable" };
  }
  const target = switchTarget(isLentAgent(agent, viewer), agent.currentVersion, version);
  if (target !== agent.currentVersion && !(await readVersion(tx, agent.scope, agent.id, target))) {
    return { ok: false, error: "version_not_found" };
  }
  return { ok: true, value: { agentScope: agent.scope, agentId: agent.id, agentVersion: target } };
}

/**
 * The newest version of a thread's pinned agent ("v3 available", D19), looked up as the thread's
 * owner sees it. Null when the thread has no agent or the agent is gone from the owner's view.
 */
export async function latestPinnedVersion(
  tx: KobeTx,
  thread: { teamId: string; ownerUserId: string; agentId: string | null },
): Promise<number | null> {
  if (thread.agentId === null) return null;
  const agent = await findPinnableAgent(
    tx,
    { teamId: thread.teamId, userId: thread.ownerUserId },
    thread.agentId,
  );
  return agent?.currentVersion ?? null;
}

export type PinnedAgent =
  | {
      readonly ok: true;
      readonly agent: AgentRecord;
      /** `version.version` is null for a test thread's draft (KOBE-85). */
      readonly version: Omit<AgentVersionRecord, "version"> & { readonly version: number | null };
    }
  | {
      readonly ok: false;
      readonly error:
        "agent_not_found" | "version_not_found" | "version_unreadable" | "agent_suspended";
    };

/**
 * **Seam for run-time resolution (KOBE-47).** The exact agent version a thread is pinned to, for
 * the thread's owner, inside the run's `withTeam` transaction. Never falls back: a pinned agent or
 * version that is missing or unreadable is an error for the run, never the default agent or
 * another version. Suspended agents are refused (`agent_suspended`); archived agents still serve
 * the threads already pinned to them; a version whose manifest doesn't parse is
 * `version_unreadable`. The caller then intersects the version with the team
 * (`effectiveApprovalMode`, the team's models and connectors; per call `loadRunAgentTools`).
 */
export async function resolvePinnedAgent(
  tx: KobeTx,
  owner: PinViewer,
  pin: AgentPin,
): Promise<PinnedAgent> {
  const agent =
    (await findPinnableAgent(tx, owner, pin.agentId)) ?? (await keptLentAgent(tx, owner, pin));
  if (!agent || agent.scope !== pin.agentScope) return { ok: false, error: "agent_not_found" };
  if (agent.status === "suspended") return { ok: false, error: "agent_suspended" };
  try {
    const version = await readVersion(tx, agent.scope, agent.id, pin.agentVersion);
    if (!version) return { ok: false, error: "version_not_found" };
    return { ok: true, agent, version };
  } catch (err) {
    if (err instanceof UnreadableVersionError) return { ok: false, error: "version_unreadable" };
    throw err;
  }
}

/**
 * The builder test pane's counterpart of `resolvePinnedAgent` (KOBE-85): the agent's draft as it
 * is at this run start, shaped like a version so everything after it (resolver, approval floor,
 * budgets, policy) is the same path as a published run. The manifest is computed exactly as at
 * publish, against today's floor. An invalid draft is `version_unreadable` (the run fails).
 */
export async function resolveDraftAgent(
  tx: KobeTx,
  owner: PinViewer,
  pin: Pick<DraftPin, "agentScope" | "agentId">,
): Promise<PinnedAgent> {
  const agent = await findPinnableAgent(tx, owner, pin.agentId);
  if (!agent || agent.scope !== pin.agentScope) return { ok: false, error: "agent_not_found" };
  if (agent.status === "suspended") return { ok: false, error: "agent_suspended" };
  // Not just at thread creation: the owner must still be allowed to edit the agent now (demoted,
  // removed from the team, or the agent changed hands), and an archived agent's draft never runs.
  if (agent.archivedAt !== null) return { ok: false, error: "agent_not_found" };
  const [member] = await tx
    .select({ role: teamMembers.role })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, owner.teamId), eq(teamMembers.userId, owner.userId)));
  if (!member || !agentAccess({ userId: owner.userId, role: member.role }, agent).edit) {
    return { ok: false, error: "agent_not_found" };
  }
  const draft = validateAgentDefinition({ frontmatter: agent.frontmatter, prompt: agent.prompt });
  if (!draft.ok) return { ok: false, error: "version_unreadable" };
  const now = new Date();
  const floor = await readPublishFloor(tx, agent.scope === "team" ? "team" : "site");
  return {
    ok: true,
    agent,
    version: {
      version: null,
      agentId: agent.id,
      publishedBy: owner.userId,
      publishedAt: now,
      draftRevision: agent.revision,
      republishedFrom: null,
      definition: draft.definition,
      toolManifest: computeToolManifest(draft.definition.frontmatter, floor, now),
      // A draft freezes nothing: the test pane runs today's newest approved versions.
      skillManifest: null,
      // The draft has no memory setting (KOBE-646): a test chat runs with the current version's.
      memory: await currentMemory(tx, agent, agent),
    },
  };
}
