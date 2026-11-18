"use client";

import type {
  SiteProposal,
  SiteProposalState,
} from "../../../../lib/memory/site-proposals-admin-api";
import { SITE_PROPOSAL_ROUNDS_MAX } from "../../../../lib/memory/site-proposals-admin-api";
import { visible } from "../../../../lib/security/visible";
import { Badge, type BadgeTone } from "../../../ui/console";
import { KIND_LABELS } from "../../../memory/item-fields";

/** A Site proposal's state in words, from the Site's side (KOBE-405). */
export const SITE_STATE_LABELS: Readonly<Record<SiteProposalState, string>> = {
  awaiting_site: "Waiting for the Site",
  awaiting_team: "Back with the Team admins",
  changes_requested: "Changes requested",
  approved: "Approved",
  merged: "Merged",
  rejected: "Rejected",
  expired: "Expired",
  withdrawn: "Withdrawn",
};

const TONES: Readonly<Partial<Record<SiteProposalState, BadgeTone>>> = {
  awaiting_site: "accent",
  awaiting_team: "attention",
  approved: "done",
  merged: "done",
  rejected: "failed",
};

export function SiteStateBadge({ state }: { readonly state: SiteProposalState }) {
  return <Badge tone={TONES[state] ?? "neutral"}>{SITE_STATE_LABELS[state]}</Badge>;
}

export const day = (iso: string) => new Date(iso).toLocaleDateString();

export const workspaceName = (p: SiteProposal) =>
  p.fromWorkspace.name === null ? "a deleted workspace" : visible(p.fromWorkspace.name);

/** "Round 2 (changes requested 1 of 3 times)": the review round the Site is in. */
export function roundLabel(rounds: number): string {
  const round = `Round ${rounds + 1}`;
  if (rounds === 0) return round;
  return `${round} (changes requested ${rounds} of ${SITE_PROPOSAL_ROUNDS_MAX} times)`;
}

/** Kind, source Workspace, proposer, date, endorsement, round and state. */
export function SiteProposalLabels({ proposal }: { readonly proposal: SiteProposal }) {
  return (
    <ul aria-label="About this proposal" className="m-0 flex list-none flex-wrap gap-2 p-0">
      <li>
        <SiteStateBadge state={proposal.state} />
      </li>
      <li>
        <Badge>{KIND_LABELS[proposal.kind]}</Badge>
      </li>
      <li>
        <Badge>{`From ${workspaceName(proposal)}`}</Badge>
      </li>
      <li>
        <Badge>{`Proposed by ${visible(proposal.proposer.name)}`}</Badge>
      </li>
      <li>
        <Badge>{`Proposed ${day(proposal.createdAt)}`}</Badge>
      </li>
      {proposal.confirmedBy && (
        <li>
          <Badge>{`Confirmed by ${visible(proposal.confirmedBy.name)}`}</Badge>
        </li>
      )}
      {proposal.endorsed && (
        <li>
          <Badge tone="done">Endorsed by a workspace curator</Badge>
        </li>
      )}
      <li>
        <Badge>{roundLabel(proposal.rounds)}</Badge>
      </li>
    </ul>
  );
}
