"use client";

import { useId, useState } from "react";
import type { MemoryItem } from "../../../lib/memory/items-api";
import type { ProposalsApi, QueuedProposal } from "../../../lib/memory/proposals-api";
import { visible } from "../../../lib/security/visible";
import { Button, Card, Field, Notice, Textarea } from "../../ui/console";
import { CheckProblem, useCheckedSave } from "../item-checks";
import { DraftFields, draftError, type Draft } from "../item-fields";
import { ProposalEvidence, ProposalLabels } from "./proposal-parts";

const NO_ITEMS: ReadonlyMap<string, MemoryItem> = new Map();
const REASON_MAX = 1000;

type TurnDown = "request-changes" | "dismiss";
export type Outcome = "approved" | "changes_requested" | "dismissed";

/**
 * One pending proposal in Workspace console › Memory › Proposals (KOBE-397): what the member
 * proposed and why, their words, what the memory checks find now (warnings, similar memories,
 * Policy it may contradict), and Approve, Edit and approve, Request changes and Dismiss (both with
 * a reason the proposer reads). The server refuses a curator's own proposal.
 */
export function ProposalCard({
  proposal,
  api,
  mine,
  onDecided,
}: {
  readonly proposal: QueuedProposal;
  readonly api: Pick<ProposalsApi, "approve" | "turnDown">;
  /** The caller proposed it: they can't decide it. */
  readonly mine: boolean;
  readonly onDecided: (proposal: QueuedProposal, outcome: Outcome) => void;
}) {
  const headingId = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>({
    statement: proposal.statement,
    kind: proposal.kind,
    tags: "",
  });
  const [turnDown, setTurnDown] = useState<TurnDown | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { busy, problem, save, clear } = useCheckedSave();

  function approve(policyConflict = false) {
    const bad = editing ? draftError(draft) : null;
    setError(bad);
    if (bad) return;
    const edit = editing
      ? {
          ...(draft.statement === proposal.statement ? {} : { statement: draft.statement }),
          ...(draft.kind === proposal.kind ? {} : { kind: draft.kind }),
        }
      : {};
    void save(
      async (o) => {
        const res = await api.approve(proposal.id, edit, o);
        return res.ok ? { ok: true, status: res.status, data: res.data.item } : res;
      },
      () => onDecided(proposal, "approved"),
      policyConflict ? { policyConflict: true } : {},
    );
  }

  async function sendTurnDown(kind: TurnDown) {
    if (reason.trim() === "") {
      setError("Give a reason: the proposer reads it.");
      return;
    }
    setError(null);
    const res = await api.turnDown(proposal.id, kind, reason.trim());
    if (res.ok) onDecided(proposal, kind === "dismiss" ? "dismissed" : "changes_requested");
    else setError(res.error.message);
  }

  return (
    <Card aria-labelledby={headingId} className="flex flex-col gap-3">
      <h3
        id={headingId}
        tabIndex={-1}
        data-proposal={proposal.id}
        className="m-0 text-base font-semibold [overflow-wrap:anywhere]"
      >
        {visible(editing ? draft.statement : proposal.statement)}
      </h3>
      <ProposalLabels proposal={proposal} showProposer />
      {editing && <DraftFields draft={draft} label="Statement" autoFocus onChange={setDraft} />}
      <ProposalEvidence proposal={proposal} />
      <ProposalFindings proposal={proposal} onSaveAnyway={() => approve(true)} busy={busy} />
      {problem && (
        <CheckProblem problem={problem} known={NO_ITEMS} busy={busy} onReload={() => clear()} />
      )}
      {error && (
        <p role="alert" className="m-0 text-sm text-status-failed">
          {error}
        </p>
      )}
      {mine ? (
        <p className="m-0 text-sm text-console-muted">
          You proposed this: another curator decides it.
        </p>
      ) : turnDown ? (
        <div role="group" aria-label={turnDown === "dismiss" ? "Dismiss" : "Request changes"}>
          <Field
            label={turnDown === "dismiss" ? "Why it won't be saved" : "What should change"}
            hint="The proposer reads this."
            required
          >
            <Textarea
              value={reason}
              rows={2}
              maxLength={REASON_MAX}
              autoFocus
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => void sendTurnDown(turnDown)}>
              {turnDown === "dismiss" ? "Dismiss proposal" : "Send back for changes"}
            </Button>
            <Button variant="ghost" onClick={() => setTurnDown(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={busy} onClick={() => approve()}>
            {editing ? "Approve edited" : "Approve"}
          </Button>
          <Button variant="ghost" aria-expanded={editing} onClick={() => setEditing((v) => !v)}>
            {editing ? "Cancel edit" : "Edit and approve…"}
          </Button>
          <Button variant="ghost" onClick={() => setTurnDown("request-changes")}>
            Request changes…
          </Button>
          <Button variant="ghost" onClick={() => setTurnDown("dismiss")}>
            Dismiss…
          </Button>
        </div>
      )}
    </Card>
  );
}

/** What the memory checks find now: Policy it may contradict, similar memories, warnings. */
function ProposalFindings({
  proposal,
  busy,
  onSaveAnyway,
}: {
  readonly proposal: QueuedProposal;
  readonly busy: boolean;
  readonly onSaveAnyway: () => void;
}) {
  const { policyConflicts, nearDuplicates, warnings } = proposal;
  if (policyConflicts.length === 0 && nearDuplicates.length === 0 && warnings.length === 0)
    return null;
  return (
    <Notice
      tone="warn"
      actions={
        policyConflicts.length > 0 ? (
          <Button size="sm" disabled={busy} onClick={onSaveAnyway}>
            Approve anyway
          </Button>
        ) : undefined
      }
    >
      {policyConflicts.length > 0 && (
        <>
          <p className="m-0 font-semibold">It may contradict Site Policy:</p>
          <ul className="m-0 ps-5">
            {policyConflicts.map((p) => (
              <li key={p.id}>{visible(p.statement)}</li>
            ))}
          </ul>
        </>
      )}
      {nearDuplicates.length > 0 && (
        <>
          <p className="m-0 font-semibold">Similar Workspace memories:</p>
          <ul className="m-0 ps-5">
            {nearDuplicates.map((d) => (
              <li key={d.id}>{visible(d.statement)}</li>
            ))}
          </ul>
        </>
      )}
      {warnings.length > 0 && policyConflicts.length === 0 && nearDuplicates.length === 0 && (
        <p className="m-0">The memory checks have warnings: approving shows them.</p>
      )}
    </Notice>
  );
}
