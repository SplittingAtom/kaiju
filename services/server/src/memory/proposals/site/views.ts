import type { MemoryWho } from "../../items/who.js";
import { curatesWorkspace, isTeamAdmin } from "./access.js";
import type { SiteProposalRow } from "./rows.js";

/**
 * One serializer per audience (KOBE-403; the wall, SM20). A proposal carries only its statement,
 * kind and justification (the table has no evidence, quote, rationale, thread, entry or run
 * columns), so neither view can hold thread-derived data; KOBE-406 probes these two shapes.
 *
 * - {@link siteView}: Site curators. Names the source Workspace (provenance is theirs to see).
 * - {@link workspaceView}: the proposing Workspace (its curators, the proposer). Never names the
 *   Site curator who decided (Site authors stay with Site curators, contract wall M6).
 */

const stateOf = (p: SiteProposalRow) => (p.lapsed ? ("expired" as const) : p.state);

function common(p: SiteProposalRow) {
  return {
    id: p.id,
    statement: p.statement,
    kind: p.kind,
    justification: p.justification,
    endorsed: p.endorsed,
    state: stateOf(p),
    rounds: p.rounds,
    proposer: p.proposer,
    confirmed_by: p.confirmedBy,
    confirmed_at: p.confirmedAt,
    /** The Site's reason (rejected) or its request-changes note (back with the Workspace). */
    reason: p.reason,
    decided_at: p.decidedAt,
    merged_into: p.mergedInto,
    expires_at: p.expiresAt,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  };
}

export function siteView(p: SiteProposalRow) {
  return {
    ...common(p),
    from_workspace: { id: p.fromTeamId, name: p.fromTeamName },
    decided_by: p.decidedBy,
  };
}
export type SiteProposalView = ReturnType<typeof siteView>;

export function workspaceView(who: MemoryWho, p: SiteProposalRow) {
  const open = stateOf(p) === "awaiting_team" || stateOf(p) === "awaiting_site";
  const own = p.proposer.id === who.userId;
  return {
    ...common(p),
    may: {
      confirm: open && p.state === "awaiting_team" && isTeamAdmin(who),
      endorse: open && !p.endorsed && !own && curatesWorkspace(who),
      withdraw: open && (own || isTeamAdmin(who)),
    },
  };
}
export type WorkspaceProposalView = ReturnType<typeof workspaceView>;
