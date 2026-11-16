"use client";

import type { Proposal } from "../../../lib/memory/proposals-api";
import { visible } from "../../../lib/security/visible";
import { InlineLink } from "../../shell/text-links";
import { Badge } from "../../ui/console";
import { KIND_LABELS } from "../item-fields";
import { daysLeft } from "../review/labels";

/** A proposal's state in words (KOBE-397). */
export const STATE_LABELS: Readonly<Record<Proposal["state"], string>> = {
  pending: "Waiting for a curator",
  approved: "Approved",
  rejected: "Not approved",
  expired: "Expired",
};

const day = (iso: string) => new Date(iso).toLocaleDateString();

/** Kind, proposer and date, and the days a pending proposal has left. */
export function ProposalLabels({
  proposal,
  showProposer,
}: {
  readonly proposal: Proposal;
  readonly showProposer: boolean;
}) {
  const left = daysLeft(proposal.expiresAt);
  return (
    <ul aria-label="About this proposal" className="m-0 flex list-none flex-wrap gap-2 p-0">
      <li>
        <Badge>{KIND_LABELS[proposal.kind]}</Badge>
      </li>
      {showProposer && (
        <li>
          <Badge>{`Proposed by ${visible(proposal.proposer.name)}`}</Badge>
        </li>
      )}
      <li>
        <Badge>{`Proposed ${day(proposal.createdAt)}`}</Badge>
      </li>
      {proposal.state === "pending" && (
        <li>
          <Badge>{left === 1 ? "1 day left" : `${left} days left`}</Badge>
        </li>
      )}
    </ul>
  );
}

/** The proposer's note, their words from the conversation, and a link to it. */
export function ProposalEvidence({ proposal }: { readonly proposal: Proposal }) {
  return (
    <div className="flex flex-col gap-2">
      {proposal.rationale && (
        <p className="m-0 text-sm [overflow-wrap:anywhere]">
          <span className="font-semibold">Note: </span>
          {visible(proposal.rationale)}
        </p>
      )}
      {proposal.evidence.length > 0 && (
        <div>
          <p className="m-0 text-sm font-semibold">In their words</p>
          <ul aria-label="Quotes" className="m-0 ps-5 text-sm">
            {proposal.evidence.map((e, i) => (
              <li key={`${e.entryId}-${i}`} className="[overflow-wrap:anywhere]">
                “{visible(e.quote)}”
              </li>
            ))}
          </ul>
        </div>
      )}
      {proposal.threadId ? (
        <p className="m-0 text-sm">
          <InlineLink href={`/?thread=${encodeURIComponent(proposal.threadId)}`}>
            Open the conversation
          </InlineLink>{" "}
          <span className="text-console-muted">(opens only if it is shared with you)</span>
        </p>
      ) : (
        <p className="m-0 text-sm text-console-muted">Its conversation is gone.</p>
      )}
    </div>
  );
}
