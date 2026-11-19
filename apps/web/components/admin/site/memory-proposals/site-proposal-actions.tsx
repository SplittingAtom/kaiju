"use client";

import { useId, useState, type ReactNode } from "react";
import type { ApiError, ApiResult } from "../../../../lib/api/client";
import type { MemoryItem, MemoryItemsApi, Overrides } from "../../../../lib/memory/items-api";
import {
  SITE_PROPOSAL_NOTE_MAX,
  SITE_PROPOSAL_REASON_MAX,
  SITE_PROPOSAL_ROUNDS_MAX,
  describeSiteProposalError,
  type SiteDecideBlocked,
  type SiteDecision,
  type SiteProposal,
  type SiteProposalChecks,
  type SiteProposalsApi,
} from "../../../../lib/memory/site-proposals-admin-api";
import { Button, Checkbox, Field, Notice, Textarea } from "../../../ui/console";
import { CheckProblem, useCheckedSave } from "../../../memory/item-checks";
import type { Decided } from "./site-proposal-detail";
import { MergePanel, type MergeChoice } from "./site-proposal-merge";

const NO_ITEMS: ReadonlyMap<string, MemoryItem> = new Map();
const OVERRIDABLE = new Set(["memory_lint_warning", "memory_policy_conflict"]);

type Mode = "merge" | "reject" | "request-changes" | null;

const BLOCKED_REASON: Readonly<Record<SiteDecideBlocked, string>> = {
  own_proposal: "You proposed this: another Site curator decides it.",
  confirmed: "You confirmed this for your workspace: another Site curator decides it.",
};

const asItem = (res: ApiResult<SiteDecision>): ApiResult<MemoryItem> =>
  res.ok ? { ok: true, status: res.status, data: res.data.item } : res;

/** A refused decision: the warnings to save over, or the error in words. */
function Refusal({ error, children }: { readonly error: ApiError; readonly children?: ReactNode }) {
  if (OVERRIDABLE.has(error.code)) return <>{children}</>;
  return (
    <Notice tone="error" role="alert">
      <p className="m-0">{describeSiteProposalError(error)}</p>
    </Notice>
  );
}

/**
 * The Site's decisions on a proposal waiting for it (KOBE-405): **Approve** (a Site admin can
 * make it Policy), **Merge into existing…** (a new version of a chosen Site memory), **Reject…**
 * (a reason the workspace reads) and **Request changes…** (a note of at most 500 characters,
 * back to the Team admins; off after three rounds). Approve and merge run the save checks:
 * warnings and Policy conflicts ask to save anyway; every refusal is shown. A curator who
 * proposed it, or confirmed it for their workspace as a Team admin (KOBE-666), sees the actions
 * disabled with the reason: another Site curator decides it.
 */
export function SiteProposalActions({
  proposal,
  checks,
  api,
  itemsApi,
  blocked,
  canSetPolicy,
  onDecided,
}: {
  readonly proposal: SiteProposal;
  readonly checks: SiteProposalChecks;
  readonly api: SiteProposalsApi;
  readonly itemsApi: Pick<MemoryItemsApi, "list">;
  readonly blocked: SiteDecideBlocked | null;
  readonly canSetPolicy: boolean;
  readonly onDecided: (outcome: Decided) => void;
}) {
  const roundsId = useId();
  const blockedId = useId();
  const [mode, setMode] = useState<Mode>(null);
  const [policy, setPolicy] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const { busy, problem, save, clear } = useCheckedSave();

  if (proposal.state !== "awaiting_site") return null;
  if (blocked !== null)
    return (
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          {["Approve", "Merge into existing…", "Reject…", "Request changes…"].map((label) => (
            <Button key={label} variant="ghost" disabled aria-describedby={blockedId}>
              {label}
            </Button>
          ))}
        </div>
        <p id={blockedId} className="m-0 text-sm text-console-muted">
          {BLOCKED_REASON[blocked]}
        </p>
      </div>
    );

  const roundsUsed = proposal.rounds >= SITE_PROPOSAL_ROUNDS_MAX;

  function choose(next: Mode) {
    clear();
    setError(null);
    setText("");
    setMode(next);
  }

  function approve() {
    setError(null);
    void save(
      async (o) => asItem(await api.approve(proposal.id, policy ? { policy: true } : {}, o)),
      () => onDecided("approved"),
    );
  }

  function merge(choice: MergeChoice) {
    setError(null);
    const into = {
      itemId: choice.itemId,
      expectedVersion: choice.version,
      ...(choice.statement === proposal.statement ? {} : { statement: choice.statement }),
    };
    void save(
      async (o: Overrides) => asItem(await api.merge(proposal.id, into, o)),
      () => onDecided("merged"),
    );
  }

  async function send(kind: "reject" | "request-changes") {
    const value = text.trim();
    if (value === "") {
      setError(
        kind === "reject"
          ? "Give a reason: the workspace reads it."
          : "Say what to change: the workspace reads it.",
      );
      return;
    }
    setError(null);
    setSending(true);
    const res =
      kind === "reject"
        ? await api.reject(proposal.id, value)
        : await api.requestChanges(proposal.id, value);
    setSending(false);
    if (res.ok) onDecided(kind === "reject" ? "rejected" : "changes_requested");
    else setError(describeSiteProposalError(res.error));
  }

  const problemView = problem && (
    <Refusal error={problem.error}>
      <CheckProblem problem={problem} known={NO_ITEMS} busy={busy} onReload={clear} />
    </Refusal>
  );

  return (
    <div className="flex flex-col gap-3">
      {problemView}
      {error && (
        <p role="alert" className="m-0 text-sm text-status-failed">
          {error}
        </p>
      )}
      {mode === "merge" ? (
        <MergePanel
          proposal={proposal}
          checks={checks}
          itemsApi={itemsApi}
          canSetPolicy={canSetPolicy}
          busy={busy}
          onMerge={merge}
          onCancel={() => choose(null)}
        />
      ) : mode !== null ? (
        <div role="group" aria-label={mode === "reject" ? "Reject" : "Request changes"}>
          <Field
            label={mode === "reject" ? "Why it is rejected" : "What should change"}
            hint={
              mode === "reject"
                ? "The workspace's Team admins and the proposer read this."
                : `The workspace's Team admins and the proposer read this; at most ${SITE_PROPOSAL_NOTE_MAX} characters.`
            }
            required
          >
            <Textarea
              value={text}
              rows={2}
              maxLength={mode === "reject" ? SITE_PROPOSAL_REASON_MAX : SITE_PROPOSAL_NOTE_MAX}
              autoFocus
              onChange={(e) => setText(e.target.value)}
            />
          </Field>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button variant="primary" disabled={sending} onClick={() => void send(mode)}>
              {mode === "reject" ? "Reject proposal" : "Send back for changes"}
            </Button>
            <Button variant="ghost" onClick={() => choose(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <>
          {canSetPolicy && (
            <Checkbox
              label="Make it Policy"
              hint="Policy reaches every run in every workspace, even where memory is off; it is small (25 items, 2 KiB)."
              checked={policy}
              onChange={(e) => setPolicy(e.target.checked)}
            />
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" disabled={busy} onClick={approve}>
              Approve
            </Button>
            <Button variant="ghost" onClick={() => choose("merge")}>
              Merge into existing…
            </Button>
            <Button variant="ghost" onClick={() => choose("reject")}>
              Reject…
            </Button>
            <Button
              variant="ghost"
              disabled={roundsUsed}
              aria-describedby={roundsUsed ? roundsId : undefined}
              onClick={() => choose("request-changes")}
            >
              Request changes…
            </Button>
          </div>
          {roundsUsed && (
            <p id={roundsId} className="m-0 text-sm text-console-muted">
              {`This proposal has had ${SITE_PROPOSAL_ROUNDS_MAX} rounds of changes, the most allowed: approve, merge or reject it.`}
            </p>
          )}
        </>
      )}
    </div>
  );
}
