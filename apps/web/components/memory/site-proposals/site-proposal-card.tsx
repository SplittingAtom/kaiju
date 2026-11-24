"use client";

import { SEMANTIC_MEMORY_KINDS } from "@kaiju/protocol";
import { useId, useState } from "react";
import type { ItemKind } from "../../../lib/memory/items-api";
import {
  SITE_JUSTIFICATION_MAX,
  SITE_ROUNDS_MAX,
  SITE_STATE_LABELS,
  type SiteChecks,
  type SiteProposal,
  type SiteProposalsApi,
} from "../../../lib/memory/site-proposals-api";
import { visible } from "../../../lib/security/visible";
import { Badge, Button, Card, Field, Notice, Select, Textarea, useConfirm } from "../../ui/console";
import { KIND_LABELS } from "../item-fields";
import { daysLeft } from "../review/labels";

export type SiteCardApi = Pick<SiteProposalsApi, "confirm" | "endorse" | "withdraw">;

/** What a card did, for the queue's notice. */
export type SiteAction = "confirmed" | "endorsed" | "withdrawn";

interface EditDraft {
  readonly statement: string;
  readonly kind: ItemKind;
  readonly justification: string;
}

const day = (iso: string) => new Date(iso).toLocaleDateString();
const isOpen = (p: SiteProposal) => p.state === "awaiting_team" || p.state === "awaiting_site";

/**
 * One Site proposal of this Workspace (KOBE-404, SM19/SM20), in Workspace console › Memory › To
 * the Site: the statement, kind, justification, proposer, endorsement, the Site's request-changes
 * note and round. Actions follow the server's `may`: Team admins Confirm (or Edit and confirm) and
 * Withdraw; curators other than the proposer Endorse; the proposer withdraws their own. The server
 * checks every click again; a refusal shows in the card in its words.
 */
export function SiteProposalCard({
  proposal,
  api,
  onChanged,
}: {
  readonly proposal: SiteProposal;
  readonly api: SiteCardApi;
  readonly onChanged: (proposal: SiteProposal, action: SiteAction, checks?: SiteChecks) => void;
}) {
  const headingId = useId();
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const { may } = proposal;

  async function run<T extends { readonly proposal: SiteProposal }>(
    call: () => Promise<{ ok: true; data: T } | { ok: false; error: { readonly message: string } }>,
    action: SiteAction,
    checksOf?: (data: T) => SiteChecks,
  ) {
    setBusy(true);
    setError(null);
    const res = await call();
    setBusy(false);
    if (!res.ok) return setError(res.error.message);
    setDraft(null);
    onChanged(res.data.proposal, action, checksOf?.(res.data));
  }

  function sendConfirm() {
    const edit: { statement?: string; kind?: ItemKind; justification?: string } = {};
    if (draft) {
      if (draft.statement.trim() === "") return setError("Write the memory first.");
      if (draft.justification.trim() === "")
        return setError("Say why every workspace should know this.");
      if (draft.statement !== proposal.statement) edit.statement = draft.statement;
      if (draft.kind !== proposal.kind) edit.kind = draft.kind;
      if (draft.justification.trim() !== proposal.justification)
        edit.justification = draft.justification.trim();
    }
    void run(
      () => api.confirm(proposal.id, edit),
      "confirmed",
      (d) => d.checks,
    );
  }

  async function sendWithdraw(trigger: HTMLElement) {
    const yes = await confirm(
      {
        title: "Withdraw this Site proposal?",
        description: "It won't reach the Site. Nothing in this workspace changes.",
        confirmLabel: "Withdraw",
      },
      trigger,
    );
    if (yes) void run(() => api.withdraw(proposal.id), "withdrawn");
  }

  const left = daysLeft(proposal.expiresAt);
  return (
    <Card role="article" aria-labelledby={headingId} className="flex flex-col gap-3">
      <h4 id={headingId} className="m-0 text-base font-semibold [overflow-wrap:anywhere]">
        {visible(draft ? draft.statement : proposal.statement)}
      </h4>
      <ul aria-label="About this proposal" className="m-0 flex list-none flex-wrap gap-2 p-0">
        <li>
          <Badge>{KIND_LABELS[proposal.kind]}</Badge>
        </li>
        <li>
          <Badge>{`Proposed by ${visible(proposal.proposer.name)}`}</Badge>
        </li>
        <li>
          <Badge>{`Proposed ${day(proposal.createdAt)}`}</Badge>
        </li>
        {!isOpen(proposal) && (
          <li>
            <Badge>{SITE_STATE_LABELS[proposal.state]}</Badge>
          </li>
        )}
        {isOpen(proposal) && (
          <li>
            <Badge>{left === 1 ? "1 day left" : `${left} days left`}</Badge>
          </li>
        )}
        {proposal.endorsed && (
          <li>
            <Badge tone="accent">Endorsed by a curator</Badge>
          </li>
        )}
        {proposal.rounds > 0 && (
          <li>
            <Badge>{`Round ${proposal.rounds + 1}`}</Badge>
          </li>
        )}
        {proposal.confirmedBy && proposal.state !== "awaiting_team" && (
          <li>
            <Badge>{`Confirmed by ${visible(proposal.confirmedBy.name)}`}</Badge>
          </li>
        )}
      </ul>
      {!draft && (
        <p className="m-0 text-sm [overflow-wrap:anywhere]">
          <span className="font-semibold">Why: </span>
          {visible(proposal.justification)}
        </p>
      )}
      {proposal.changesNote && (
        <Notice tone="info">
          <p className="m-0 [overflow-wrap:anywhere]">
            <span className="font-semibold">
              {`The Site asked for changes (${proposal.rounds} of at most ${SITE_ROUNDS_MAX} times): `}
            </span>
            {visible(proposal.changesNote)}
          </p>
        </Notice>
      )}
      {proposal.state === "rejected" && proposal.reason && (
        <p className="m-0 text-sm [overflow-wrap:anywhere]">
          <span className="font-semibold">The Site&apos;s reason: </span>
          {visible(proposal.reason)}
        </p>
      )}
      {draft && <EditFields draft={draft} onChange={setDraft} />}
      {error && (
        <p role="alert" className="m-0 text-sm text-status-failed">
          {error}
        </p>
      )}
      {proposal.state === "awaiting_team" && !may.confirm && (
        <p className="m-0 text-sm text-console-muted">
          A Team admin confirms it before it goes to the Site.
        </p>
      )}
      {(may.confirm || may.endorse || may.withdraw) && (
        <div className="flex flex-wrap gap-2">
          {may.confirm && (
            <>
              <Button variant="primary" disabled={busy} onClick={sendConfirm}>
                {draft ? "Confirm edited" : "Confirm"}
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                aria-expanded={draft !== null}
                onClick={() =>
                  setDraft((d) =>
                    d
                      ? null
                      : {
                          statement: proposal.statement,
                          kind: proposal.kind,
                          justification: proposal.justification,
                        },
                  )
                }
              >
                {draft ? "Cancel edit" : "Edit and confirm…"}
              </Button>
            </>
          )}
          {may.endorse && (
            <Button
              disabled={busy}
              onClick={() => void run(() => api.endorse(proposal.id), "endorsed")}
            >
              Endorse
            </Button>
          )}
          {may.withdraw && (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={(e) => void sendWithdraw(e.currentTarget)}
            >
              Withdraw…
            </Button>
          )}
        </div>
      )}
      {confirmDialog}
    </Card>
  );
}

/** Edit and confirm: the statement, kind and justification that will go to the Site. */
function EditFields({
  draft,
  onChange,
}: {
  readonly draft: EditDraft;
  readonly onChange: (d: EditDraft) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <Field label="Statement" hint="A short statement, not an instruction.">
        <Textarea
          rows={3}
          autoFocus
          value={draft.statement}
          className="w-full"
          onChange={(e) => onChange({ ...draft, statement: e.target.value })}
        />
      </Field>
      <Field label="Kind" className="w-fit">
        <Select
          value={draft.kind}
          onChange={(e) => onChange({ ...draft, kind: e.target.value as ItemKind })}
        >
          {SEMANTIC_MEMORY_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k]}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        label="Justification"
        hint={`Why every workspace should know this. At most ${SITE_JUSTIFICATION_MAX} characters.`}
        required
      >
        <Textarea
          rows={2}
          maxLength={SITE_JUSTIFICATION_MAX}
          value={draft.justification}
          className="w-full"
          onChange={(e) => onChange({ ...draft, justification: e.target.value })}
        />
      </Field>
    </div>
  );
}
