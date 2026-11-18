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

/** Decided by the Site (the only states whose `decided_*` and `reason` are a decision). */
const decided = (p: SiteProposalRow) =>
  p.state === "approved" || p.state === "merged" || p.state === "rejected";
const open = (p: SiteProposalRow) => p.state === "awaiting_team" || p.state === "awaiting_site";

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
    /** The Site's reason for a rejection (null otherwise). */
    reason: p.state === "rejected" ? p.reason : null,
    /** The Site's latest request-changes note while the proposal is still open (rounds > 0). */
    changes_note: open(p) && p.rounds > 0 ? p.reason : null,
    decided_at: decided(p) ? p.decidedAt : null,
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
    decided_by: decided(p) ? p.decidedBy : null,
  };
}
export type SiteProposalView = ReturnType<typeof siteView>;

export function workspaceView(who: MemoryWho, p: SiteProposalRow) {
  const actionable = stateOf(p) === "awaiting_team" || stateOf(p) === "awaiting_site";
  const own = p.proposer.id === who.userId;
  return {
    ...common(p),
    may: {
      confirm: actionable && p.state === "awaiting_team" && isTeamAdmin(who),
      endorse: actionable && !p.endorsed && !own && curatesWorkspace(who),
      withdraw: actionable && (own || isTeamAdmin(who)),
    },
  };
}
export type WorkspaceProposalView = ReturnType<typeof workspaceView>;
