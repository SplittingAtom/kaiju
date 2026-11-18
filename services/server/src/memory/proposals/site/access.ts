import { siteMemoryAllows } from "../../../authz/permissions.js";
import { notAllowed } from "../../items/errors.js";
import { curates, type MemoryWho } from "../../items/who.js";
import { siteProposalNotFound, type SiteProposalRow } from "./rows.js";

/**
 * Who may do what with a Site proposal (KOBE-403, SM19). The table has no RLS, so these checks
 * are the only wall: every read and action calls one of them.
 *
 * - Workspace side (the active Workspace only): its Team admins confirm, edit and withdraw; its
 *   curators (Team admins + Workspace memory stewards) read all its proposals, endorse and propose
 *   existing Workspace memories; a member reads and withdraws their own.
 * - Site side: Site admins and Site memory stewards (`site.memory.site_proposals.decide`) read
 *   proposals a Team admin confirmed and decide them, never their own.
 * - Everyone else: 404, as if it didn't exist.
 */

export const isTeamAdmin = (who: MemoryWho): boolean => who.teamRole === "team_admin";

/** Team admins and Workspace memory stewards of the active Workspace. */
export const curatesWorkspace = (who: MemoryWho): boolean => curates(who, "team");

/** Site admins and Site memory stewards. */
export const decidesForSite = (who: MemoryWho): boolean =>
  siteMemoryAllows(who, "site.memory.site_proposals.decide");

/** The Workspace side may read this proposal: its curators, or its proposer. */
export function assertWorkspaceReads(who: MemoryWho, p: SiteProposalRow): void {
  if (p.fromTeamId !== who.teamId) throw siteProposalNotFound();
  if (!curatesWorkspace(who) && p.proposer.id !== who.userId) throw siteProposalNotFound();
}

export function assertSiteCurator(who: MemoryWho): void {
  if (!decidesForSite(who))
    throw notAllowed("Only Site admins and Site memory stewards review Site proposals.");
}

/** Step 2: a Site curator who did not propose it. */
export function assertSiteDecider(who: MemoryWho, p: SiteProposalRow): void {
  if (!decidesForSite(who)) throw siteProposalNotFound();
  if (p.proposer.id === who.userId)
    throw notAllowed("You can't decide your own Site proposal: another Site curator does.");
}
