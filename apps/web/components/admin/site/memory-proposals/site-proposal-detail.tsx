"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { MemoryItemsApi } from "../../../../lib/memory/items-api";
import type {
  RelatedSiteItem,
  SiteProposal,
  SiteProposalChecks,
  SiteProposalDetail,
  SiteProposalsApi,
} from "../../../../lib/memory/site-proposals-admin-api";
import { visible } from "../../../../lib/security/visible";
import { Button, Card, Notice } from "../../../ui/console";
import { StatementDiff } from "../../../memory/review/statement-diff";
import { day, SiteProposalLabels } from "./labels";
import { SiteProposalActions } from "./site-proposal-actions";

export type Decided = "approved" | "merged" | "rejected" | "changes_requested";

/**
 * One Site proposal (KOBE-405): statement, kind, justification, source Workspace, proposer, date,
 * endorsement and round; what the shared checks find against Site memory and Policy now, each
 * with a word diff against the proposal; and the decisions while it waits for the Site.
 */
export function SiteProposalDetailView({
  id,
  api,
  itemsApi,
  userId,
  canSetPolicy,
  onClose,
  onDecided,
}: {
  readonly id: string;
  readonly api: SiteProposalsApi;
  readonly itemsApi: Pick<MemoryItemsApi, "list">;
  readonly userId: string;
  readonly canSetPolicy: boolean;
  readonly onClose: () => void;
  readonly onDecided: (outcome: Decided) => void;
}) {
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement | null>(null);
  const [detail, setDetail] = useState<SiteProposalDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void api.get(id).then((res) => {
      if (!current) return;
      if (res.ok) setDetail(res.data);
      else
        setError(
          res.error.status === 404
            ? "This proposal no longer exists, or you can't review it."
            : res.error.message,
        );
    });
    return () => {
      current = false;
    };
  }, [api, id]);

  useEffect(() => {
    if (detail) heading.current?.focus();
  }, [detail]);

  if (error)
    return (
      <Notice tone="error" role="alert" actions={<Button onClick={onClose}>Close</Button>}>
        <p className="m-0">{error}</p>
      </Notice>
    );
  if (detail === null) return <p role="status">Loading the proposal…</p>;
  const { proposal, checks } = detail;
  return (
    <Card>
      <section aria-labelledby={headingId} className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h3
            id={headingId}
            ref={heading}
            tabIndex={-1}
            className="m-0 min-w-0 flex-1 text-base font-semibold [overflow-wrap:anywhere]"
          >
            {visible(proposal.statement)}
          </h3>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
        <SiteProposalLabels proposal={proposal} />
        <p className="m-0 text-sm [overflow-wrap:anywhere]">
          <span className="font-semibold">Why every workspace should know this: </span>
          {visible(proposal.justification)}
        </p>
        <Outcome proposal={proposal} />
        <Findings proposal={proposal} checks={checks} />
        <SiteProposalActions
          proposal={proposal}
          checks={checks}
          api={api}
          itemsApi={itemsApi}
          blocked={
            proposal.may?.decideBlocked ?? (proposal.proposer.id === userId ? "own_proposal" : null)
          }
          canSetPolicy={canSetPolicy}
          onDecided={onDecided}
        />
      </section>
    </Card>
  );
}

/** The decision so far: the Site's note while it is back with the Team admins, or the outcome. */
function Outcome({ proposal }: { readonly proposal: SiteProposal }) {
  const p = proposal;
  return (
    <>
      {p.changesNote && (
        <p className="m-0 text-sm [overflow-wrap:anywhere]">
          <span className="font-semibold">The Site asked for changes: </span>
          {visible(p.changesNote)}
        </p>
      )}
      {p.reason && (
        <p className="m-0 text-sm [overflow-wrap:anywhere]">
          <span className="font-semibold">Rejected because: </span>
          {visible(p.reason)}
        </p>
      )}
      {p.decidedAt && (
        <p className="m-0 text-sm text-console-muted">
          {`Decided ${day(p.decidedAt)}${p.decidedBy ? ` by ${visible(p.decidedBy.name)}` : ""}.`}
        </p>
      )}
      {(p.state === "awaiting_site" || p.state === "awaiting_team") && (
        <p className="m-0 text-sm text-console-muted">{`Expires ${day(p.expiresAt)}.`}</p>
      )}
    </>
  );
}

function RelatedList({
  label,
  items,
  statement,
}: {
  readonly label: string;
  readonly items: readonly RelatedSiteItem[];
  readonly statement: string;
}) {
  return (
    <>
      <p className="m-0 font-semibold">{label}</p>
      <ul aria-label={label} className="m-0 flex flex-col gap-2 ps-5">
        {items.map((r) => (
          <li key={r.id}>
            <p className="m-0 text-sm text-console-muted">
              {`Saved (version ${r.version}): ${visible(r.statement)}`}
            </p>
            <StatementDiff before={r.statement} after={statement} />
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * Policy the proposal may contradict, similar Site memories (each diffed: struck words are the
 * saved memory's, underlined ones the proposal's), warnings and a secret.
 */
function Findings({
  proposal,
  checks,
}: {
  readonly proposal: SiteProposal;
  readonly checks: SiteProposalChecks;
}) {
  const { policyConflicts, nearDuplicates, warnings, secret } = checks;
  if (
    !secret &&
    policyConflicts.length === 0 &&
    nearDuplicates.length === 0 &&
    warnings.length === 0
  )
    return <p className="m-0 text-sm text-console-muted">The memory checks found nothing.</p>;
  return (
    <Notice tone={secret ? "error" : "warn"} title="What the memory checks find">
      {secret && (
        <p className="m-0">
          It looks like it holds a password, key or token, so it can't be saved: reject it.
        </p>
      )}
      {policyConflicts.length > 0 && (
        <RelatedList
          label="Site Policy it may contradict"
          items={policyConflicts}
          statement={proposal.statement}
        />
      )}
      {nearDuplicates.length > 0 && (
        <RelatedList
          label="Similar Site memories"
          items={nearDuplicates}
          statement={proposal.statement}
        />
      )}
      {warnings.length > 0 && (
        <p className="m-0">
          The checks have other warnings (such as instructions, personal data or links); approving
          shows them and asks you to confirm.
        </p>
      )}
    </Notice>
  );
}
