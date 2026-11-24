import { sql, type KaijuTx, type SiteMemoryProposalState } from "@kaiju/db";
import type { SemanticMemoryKind } from "@kaiju/protocol";
import { MemoryItemError, inactive } from "../../items/errors.js";

/**
 * Site proposals as stored (`site_memory_proposals`, KOBE-402; KOBE-403, SM19/SM20). The table is
 * site-wide (no RLS), so every read here names what the caller may see: a Workspace's rows by
 * `from_team_id`, the Site's by a Team admin's confirmation (`team_confirmed_by IS NOT NULL`).
 * Role checks are the callers' (`access.ts`); unseen rows answer 404 like missing ones.
 */

export interface Person {
  readonly id: string;
  readonly name: string;
}

export interface SiteProposalRow {
  readonly id: string;
  readonly fromTeamId: string;
  readonly fromTeamName: string;
  readonly statement: string;
  readonly kind: SemanticMemoryKind;
  readonly justification: string;
  readonly endorsed: boolean;
  readonly state: SiteMemoryProposalState;
  /** Open past its expiry: treated as expired (the sweep that marks it is KOBE-653). */
  readonly lapsed: boolean;
  readonly rounds: number;
  readonly proposer: Person;
  readonly confirmedBy: Person | null;
  readonly confirmedAt: string | null;
  /**
   * Every Team admin who confirmed it, in any round (KOBE-666): `team_confirmed_by` keeps only the
   * last, so earlier rounds come from the Workspace's `memory.site_proposal.confirmed` audit events.
   */
  readonly confirmerIds: readonly string[];
  readonly decidedBy: Person | null;
  readonly decidedAt: string | null;
  readonly reason: string | null;
  readonly mergedInto: string | null;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

type Raw = {
  id: string;
  from_team_id: string;
  team_name: string;
  statement: string;
  kind: SemanticMemoryKind;
  justification: string;
  endorsed: boolean;
  state: SiteMemoryProposalState;
  lapsed: boolean;
  rounds: number;
  proposer_id: string;
  proposer_name: string | null;
  team_confirmed_by: string | null;
  confirmer_name: string | null;
  team_confirmed_at: string | Date | null;
  confirmer_ids: string[] | null;
  decided_by: string | null;
  decider_name: string | null;
  decided_at: string | Date | null;
  reason: string | null;
  merged_into: string | null;
  expires_at: string | Date;
  created_at: string | Date;
  updated_at: string | Date;
};

const iso = (v: string | Date) => new Date(v).toISOString();
const isoOrNull = (v: string | Date | null) => (v === null ? null : iso(v));
const person = (id: string | null, name: string | null): Person | null =>
  id === null ? null : { id, name: name ?? "A member" };

function toRow(r: Raw): SiteProposalRow {
  return {
    id: r.id,
    fromTeamId: r.from_team_id,
    fromTeamName: r.team_name,
    statement: r.statement,
    kind: r.kind,
    justification: r.justification,
    endorsed: r.endorsed,
    state: r.state,
    lapsed: r.lapsed,
    rounds: r.rounds,
    proposer: person(r.proposer_id, r.proposer_name) as Person,
    confirmedBy: person(r.team_confirmed_by, r.confirmer_name),
    confirmedAt: isoOrNull(r.team_confirmed_at),
    confirmerIds: r.confirmer_ids ?? [],
    decidedBy: person(r.decided_by, r.decider_name),
    decidedAt: isoOrNull(r.decided_at),
    reason: r.reason,
    mergedInto: r.merged_into,
    expiresAt: iso(r.expires_at),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

/** States a proposal can still be acted on in (`changes_requested` is unused: see the ledger). */
export const OPEN_STATES: readonly SiteMemoryProposalState[] = ["awaiting_team", "awaiting_site"];

const SELECT = sql`
  SELECT p.id, p.from_team_id, t.name AS team_name, p.statement, p.kind, p.justification,
         p.endorsed, p.state,
         (p.state IN ('awaiting_team', 'awaiting_site', 'changes_requested')
           AND p.expires_at <= now()) AS lapsed,
         p.rounds, p.proposer_id, pu.name AS proposer_name, p.team_confirmed_by,
         cu.name AS confirmer_name, p.team_confirmed_at,
         ARRAY(SELECT p.team_confirmed_by::text WHERE p.team_confirmed_by IS NOT NULL
               UNION
               SELECT a.actor_id::text FROM audit_log a
                WHERE a.action = 'memory.site_proposal.confirmed' AND a.team_id = p.from_team_id
                  AND a.target ->> 'proposalId' = p.id::text AND a.actor_id IS NOT NULL)
           AS confirmer_ids,
         p.decided_by, du.name AS decider_name,
         p.decided_at, p.reason, p.merged_into, p.expires_at, p.created_at, p.updated_at
    FROM site_memory_proposals p
    JOIN teams t ON t.id = p.from_team_id
    JOIN users pu ON pu.id = p.proposer_id
    LEFT JOIN users cu ON cu.id = p.team_confirmed_by
    LEFT JOIN users du ON du.id = p.decided_by`;

/** What a caller may see: one Workspace's proposals, or the Site's (confirmed by a Team admin). */
export type Audience =
  { readonly side: "workspace"; readonly teamId: string } | { readonly side: "site" };

const visible = (a: Audience) =>
  a.side === "workspace" ? sql`p.from_team_id = ${a.teamId}` : sql`p.team_confirmed_by IS NOT NULL`;

export const siteProposalNotFound = () =>
  new MemoryItemError("memory_item_not_found", "No such Site proposal.");

/** One proposal the audience may see, or 404. */
export async function readSiteProposal(
  tx: KaijuTx,
  audience: Audience,
  id: string,
  lock = false,
): Promise<SiteProposalRow> {
  const { rows } = await tx.execute<Raw>(sql`${SELECT}
    WHERE p.id = ${id} AND ${visible(audience)} ${lock ? sql`FOR UPDATE OF p` : sql``}`);
  const raw = rows[0];
  if (!raw) throw siteProposalNotFound();
  return toRow(raw);
}

/** Row-locks an open, unexpired proposal in `want` (default: any open state) for an action. */
export async function lockOpen(
  tx: KaijuTx,
  audience: Audience,
  id: string,
  want: readonly SiteMemoryProposalState[] = OPEN_STATES,
): Promise<SiteProposalRow> {
  const row = await readSiteProposal(tx, audience, id, true);
  if (!OPEN_STATES.includes(row.state)) throw inactive("This Site proposal was already decided.");
  if (row.lapsed) throw inactive("This Site proposal expired: proposals wait 30 days.");
  if (!want.includes(row.state))
    throw inactive(
      row.state === "awaiting_team"
        ? "This Site proposal waits for a Team admin's confirmation."
        : "This Site proposal already waits for the Site.",
    );
  return row;
}

/** Most proposals one list returns. */
export const SITE_PROPOSALS_LIST_MAX = 100;

export interface ListFilter {
  readonly state?: SiteMemoryProposalState | undefined;
  readonly fromTeamId?: string | undefined;
  /** Only this person's proposals (a member's own list). */
  readonly proposerId?: string | undefined;
  readonly limit?: number | undefined;
}

const stateMatch = (state: SiteMemoryProposalState) =>
  state === "expired"
    ? sql`(p.state = 'expired' OR (p.state IN ('awaiting_team', 'awaiting_site') AND p.expires_at <= now()))`
    : OPEN_STATES.includes(state)
      ? sql`(p.state = ${state} AND p.expires_at > now())`
      : sql`p.state = ${state}`;

function where(audience: Audience, f: ListFilter) {
  const parts = [visible(audience)];
  if (f.state) parts.push(stateMatch(f.state));
  if (f.fromTeamId) parts.push(sql`p.from_team_id = ${f.fromTeamId}`);
  if (f.proposerId) parts.push(sql`p.proposer_id = ${f.proposerId}`);
  return sql.join(parts, sql` AND `);
}

/** Open proposals oldest first (a queue); decided ones newest first. */
export async function listSiteProposals(
  tx: KaijuTx,
  audience: Audience,
  f: ListFilter,
): Promise<SiteProposalRow[]> {
  const order =
    f.state && OPEN_STATES.includes(f.state) ? sql`p.created_at ASC` : sql`p.created_at DESC`;
  const limit = Math.min(f.limit ?? SITE_PROPOSALS_LIST_MAX, SITE_PROPOSALS_LIST_MAX);
  const { rows } = await tx.execute<Raw>(sql`${SELECT}
    WHERE ${where(audience, f)} ORDER BY ${order}, p.id LIMIT ${limit}`);
  return rows.map(toRow);
}

/** How many proposals per state the audience sees (open ones past expiry count as expired). */
export async function countSiteProposals(
  tx: KaijuTx,
  audience: Audience,
  f: Omit<ListFilter, "state" | "limit">,
): Promise<Record<string, number>> {
  const { rows } = await tx.execute<{ state: string; n: number }>(sql`
    SELECT CASE WHEN p.state IN ('awaiting_team', 'awaiting_site') AND p.expires_at <= now()
                THEN 'expired' ELSE p.state END AS state, count(*)::int AS n
      FROM site_memory_proposals p WHERE ${where(audience, f)} GROUP BY 1`);
  return Object.fromEntries(rows.map((r) => [r.state, r.n]));
}
