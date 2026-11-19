import { sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import { evaluateMemoryWrite } from "../../checks.js";
import { openOp, type Op } from "../../items/context.js";
import { notFound } from "../../items/errors.js";
import { readItem } from "../../items/rows.js";
import type { MemoryWho } from "../../items/who.js";
import { workspaceOf } from "../../review/ids.js";
import { policyStatements } from "../../review/list.js";
import {
  assertSiteCurator,
  assertWorkspaceReads,
  curatesWorkspace,
  decidesForSite,
} from "./access.js";
import {
  countSiteProposals,
  listSiteProposals,
  readSiteProposal,
  siteProposalNotFound,
  type SiteProposalRow,
} from "./rows.js";
import type { SiteProposalListQuery } from "./schemas.js";
import { siteView, workspaceView } from "./views.js";

/**
 * Reading Site proposals (KOBE-403) for the two consoles: the Workspace side (KOBE-404: its
 * curators see all of the Workspace's proposals, the confirmation queue is `awaiting_team`; a
 * member sees their own) and the Site side (KOBE-405: Site curators see what a Team admin
 * confirmed, with counts per state and, on one proposal, what the shared checks find against
 * Site memory and Policy now). Plus where a Site memory came from ({@link siteItemProvenance}).
 */

const ws = (teamId: string) => ({ side: "workspace", teamId }) as const;
const SITE = { side: "site" } as const;

export function listWorkspaceSiteProposals(db: KobeDb, who: MemoryWho, q: SiteProposalListQuery) {
  const teamId = workspaceOf(who);
  // A member's list is their own; curators see the Workspace's.
  const proposerId = curatesWorkspace(who) ? undefined : who.userId;
  return withTeam(db, teamId, async (tx) => {
    const rows = await listSiteProposals(tx, ws(teamId), {
      state: q.state,
      limit: q.limit,
      proposerId,
    });
    return {
      proposals: rows.map((p) => workspaceView(who, p)),
      counts: await countSiteProposals(tx, ws(teamId), { proposerId }),
    };
  });
}

export function getWorkspaceSiteProposal(db: KobeDb, who: MemoryWho, id: string) {
  const teamId = workspaceOf(who);
  return withTeam(db, teamId, async (tx) => {
    const p = await readSiteProposal(tx, ws(teamId), id);
    assertWorkspaceReads(who, p);
    return { proposal: workspaceView(who, p) };
  });
}

export async function listSiteQueue(db: KobeDb, who: MemoryWho, q: SiteProposalListQuery) {
  assertSiteCurator(who);
  const filter = { fromTeamId: q.from_team_id };
  return db.transaction(async (tx) => {
    const rows = await listSiteProposals(tx, SITE, {
      ...filter,
      state: q.state ?? "awaiting_site",
      limit: q.limit,
    });
    return {
      proposals: rows.map((r) => siteView(who, r)),
      counts: await countSiteProposals(tx, SITE, filter),
    };
  });
}

async function related(op: Op, refs: readonly { id: string }[]) {
  const out: { id: string; version: number; statement: string; policy: boolean }[] = [];
  for (const r of refs.slice(0, 5)) {
    const row = await readItem(op.tx, op.loc, r.id);
    if (row && row.status === "active")
      out.push({
        id: row.id,
        version: row.current_version,
        statement: row.statement,
        policy: row.policy,
      });
  }
  return out;
}

/** What the shared checks find for the proposal against Site memory and Policy now. */
async function checksFor(tx: KobeTx, who: MemoryWho, p: SiteProposalRow) {
  const op = await openOp(tx, who, "site");
  const found = await evaluateMemoryWrite(op, {
    scope: "site",
    policy: false,
    statement: p.statement,
    justification: p.justification,
  });
  return {
    secret: found.secret !== null,
    warnings: found.warnings.map((w) => w.code),
    near_duplicates: await related(op, found.duplicates),
    policy_conflicts: await policyStatements(tx, found.policyConflicts),
  };
}

export function getSiteProposal(db: KobeDb, who: MemoryWho, id: string) {
  if (!decidesForSite(who)) throw siteProposalNotFound();
  return db.transaction(async (tx) => {
    const p = await readSiteProposal(tx, SITE, id);
    return { proposal: siteView(who, p), checks: await checksFor(tx, who, p) };
  });
}

/**
 * Where a Site memory came from (ac-2): Site curators see each version a proposal wrote with its
 * source Workspace; everyone else sees only that the Site set it.
 */
export async function siteItemProvenance(db: KobeDb, who: MemoryWho, itemId: string) {
  return db.transaction(async (tx) => {
    const { rows: exists } = await tx.execute(sql`
      SELECT 1 FROM site_memory_items WHERE id = ${itemId}`);
    if (exists.length === 0) throw notFound();
    if (!decidesForSite(who)) return { set_by: "site" as const };
    const { rows } = await tx.execute<{
      version: number;
      proposal_id: string;
      from_team_id: string | null;
      team_name: string | null;
    }>(sql`
      SELECT v.version, v.proposal_id, p.from_team_id, t.name AS team_name
        FROM site_memory_item_versions v
        LEFT JOIN site_memory_proposals p ON p.id = v.proposal_id
        LEFT JOIN teams t ON t.id = p.from_team_id
       WHERE v.item_id = ${itemId} AND v.proposal_id IS NOT NULL
       ORDER BY v.version`);
    return {
      set_by: rows.length > 0 ? ("workspace" as const) : ("site" as const),
      from_proposals: rows.map((r) => ({
        version: r.version,
        proposal_id: r.proposal_id,
        // Null once the Workspace (and with it the proposal) was deleted.
        from_workspace: r.from_team_id ? { id: r.from_team_id, name: r.team_name } : null,
      })),
    };
  });
}
