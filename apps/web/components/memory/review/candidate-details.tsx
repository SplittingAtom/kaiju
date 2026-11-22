"use client";

import { requestReveal } from "../../../lib/chat/reveal-request";
import type { Candidate } from "../../../lib/memory/review-api";
import { visible } from "../../../lib/security/visible";
import { Badge, Button, Notice } from "../../ui/console";
import { KIND_LABELS } from "../item-fields";
import { OPERATION_LABELS, PROJECT_LINE, SOURCE_LABELS, confidenceLabel, daysLeft } from "./labels";
import { StatementDiff } from "./statement-diff";

/** The card's labels: source, confidence, kind, what it does, days left. */
export function CandidateLabels({ candidate }: { readonly candidate: Candidate }) {
  const left = daysLeft(candidate.expiresAt);
  return (
    <ul aria-label="About this candidate" className="m-0 flex list-none flex-wrap gap-2 p-0">
      <li>
        <Badge tone={candidate.source === "inferred" ? "attention" : "neutral"}>
          {SOURCE_LABELS[candidate.source]}
        </Badge>
      </li>
      <li>
        <Badge>{confidenceLabel(candidate.confidence)}</Badge>
      </li>
      <li>
        <Badge>{KIND_LABELS[candidate.kind]}</Badge>
      </li>
      <li>
        <Badge>{OPERATION_LABELS[candidate.operation]}</Badge>
      </li>
      <li>
        <Badge>{left === 1 ? "1 day left" : `${left} days left`}</Badge>
      </li>
    </ul>
  );
}

/** Why Kobe suggests it, and the quotes it rests on (each scrolls to its message). */
export function CandidateWhy({
  candidate,
  threadId,
}: {
  readonly candidate: Candidate;
  readonly threadId: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 text-sm text-console-muted [overflow-wrap:anywhere]">
        <span className="font-semibold">Why: </span>
        {visible(candidate.rationale)}
      </p>
      <ul aria-label="Evidence" className="m-0 flex list-none flex-col gap-1 p-0">
        {candidate.evidence.map((e, i) => (
          <li key={`${e.entryId}-${i}`}>
            <Button
              variant="ghost"
              size="sm"
              className="text-start whitespace-normal"
              aria-label={`Show in the conversation: ${visible(e.quote)}`}
              onClick={() => requestReveal({ threadId, entryId: e.entryId })}
            >
              <q className="[overflow-wrap:anywhere]">{visible(e.quote)}</q>
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What it changes, conflicts with or repeats; the project line. */
export function CandidateContext({
  candidate,
  statement,
  saveAnyway,
  busy,
}: {
  readonly candidate: Candidate;
  /** The statement as edited now (the diff follows the edit). */
  readonly statement: string;
  /** Saves over the Policy conflict (audited); absent when there is none. */
  readonly saveAnyway?: () => void;
  readonly busy: boolean;
}) {
  const { target } = candidate;
  return (
    <>
      {candidate.operation !== "add" && target !== null && (
        <div className="rounded border border-solid border-console-border p-2">
          <p className="m-0 mb-1 text-sm font-semibold">
            {candidate.operation === "conflict"
              ? "Saving replaces the memory it contradicts:"
              : "Changes to your saved memory:"}
          </p>
          {candidate.targetChanged && (
            <p className="m-0 mb-1 text-sm text-console-muted">
              This memory was changed since Kobe suggested this: the comparison shows it as it is
              now. Check it before you save.
            </p>
          )}
          <StatementDiff before={target.statement} after={statement} />
        </div>
      )}
      {candidate.operation !== "add" && target === null && (
        <p className="m-0 text-sm text-console-muted">The memory it changes is no longer saved.</p>
      )}
      {candidate.policyConflicts.length > 0 && (
        <Notice
          tone="warn"
          title="This may contradict Site Policy"
          actions={
            saveAnyway && (
              <Button size="sm" disabled={busy} onClick={saveAnyway}>
                Not a conflict? Save anyway
              </Button>
            )
          }
        >
          <ul aria-label="Policy" className="m-0 ps-5">
            {candidate.policyConflicts.map((p) => (
              <li key={p.id} className="[overflow-wrap:anywhere]">
                {visible(p.statement)}
              </li>
            ))}
          </ul>
          <p className="m-0 mt-1">Saving anyway is recorded.</p>
        </Notice>
      )}
      {candidate.nearDuplicates.length > 0 && (
        <Notice tone="info" title="You may have this already">
          <ul aria-label="Similar memories" className="m-0 ps-5">
            {candidate.nearDuplicates.map((d) => (
              <li key={d.id} className="[overflow-wrap:anywhere]">
                {visible(d.statement)}
              </li>
            ))}
          </ul>
        </Notice>
      )}
      {candidate.projectSpecific && (
        <p className="m-0 text-sm text-console-muted">{PROJECT_LINE}</p>
      )}
    </>
  );
}
