"use client";

import { useState } from "react";
import type { Suggestion, SuggestionsApi } from "../../../lib/memory/suggestions-api";
import { visible } from "../../../lib/security/visible";
import { Badge, Button, Card, Field, Textarea, useConfirm, type BadgeTone } from "../../ui/console";

export const APPROVE_LABEL = "Approve";
export const DISMISS_LABEL = "Dismiss";

const STATE_TONE: Readonly<Record<Suggestion["state"], BadgeTone>> = {
  pending: "running",
  approved: "done",
  dismissed: "neutral",
  expired: "neutral",
};
const STATE_LABEL: Readonly<Record<Suggestion["state"], string>> = {
  pending: "Waiting",
  approved: "Added to notes",
  dismissed: "Dismissed",
  expired: "Expired",
};

const day = (iso: string) => new Date(iso).toLocaleDateString();

function Quotes({ s }: { readonly s: Suggestion }) {
  return (
    <ul aria-label="Their words" className="m-0 mt-2 list-none p-0 text-sm">
      {s.evidence.map((e, i) => (
        <li
          key={`${e.entryId}-${i}`}
          className="border-0 border-l-4 border-solid border-console-border ps-3 text-console-muted [overflow-wrap:anywhere]"
        >
          “{visible(e.quote)}”
        </li>
      ))}
    </ul>
  );
}

/**
 * One reader's suggestion for a project's notes, as its editors, owners and Team admins decide it
 * (KOBE-652). **Approve** previews the exact change (the line under `## Learned` in `MEMORY.md`)
 * with its signed approval, the decider approves it in a dialog, and the server writes it after
 * checking everything again (their role included). **Dismiss** takes an optional reason the
 * suggester sees.
 */
export function SuggestionCard({
  suggestion: s,
  api,
  showProject = false,
  onDecided,
}: {
  readonly suggestion: Suggestion;
  readonly api: SuggestionsApi;
  /** In To review, which project it is for. */
  readonly showProject?: boolean;
  readonly onDecided: (id: string, message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState("");
  const [confirm, confirmDialog] = useConfirm();

  async function approve(trigger: HTMLElement) {
    setError(null);
    setBusy(true);
    const preview = await api.preview(s.id);
    if (!preview.ok) {
      setBusy(false);
      setError(preview.error.message);
      return;
    }
    const warnings = preview.data.warnings ?? [];
    const yes = await confirm(
      {
        title: "Add to the project's notes?",
        description: (
          <>
            <span className="block">
              Kobe adds this line under <code>## {preview.data.section}</code> in the project&apos;s{" "}
              <code>{preview.data.path}</code>. Everyone who can read the project sees its notes,
              and the agent reads them in its conversations.
            </span>
            <span className="mt-2 block border-0 border-l-4 border-solid border-console-border ps-3 font-mono [overflow-wrap:anywhere] whitespace-pre-wrap">
              {visible(preview.data.line)}
            </span>
            {warnings.length > 0 ? (
              <span role="note" className="mt-2 block text-xs text-console-warning">
                {warnings.map((w) => (
                  <span key={w.code} className="block">
                    {w.message}
                  </span>
                ))}
              </span>
            ) : null}
          </>
        ),
        confirmLabel: "Approve and add",
        tone: "primary",
      },
      trigger,
    );
    if (!yes) {
      setBusy(false);
      return;
    }
    const done = await api.approve(s.id, preview.data);
    setBusy(false);
    if (done.ok)
      onDecided(s.id, `Added to ${s.projectName}'s notes. ${s.suggestedBy.name} is told.`);
    else setError(done.error.message);
  }

  async function dismiss() {
    setError(null);
    setBusy(true);
    const why = reason.trim();
    const done = await api.dismiss(s.id, why === "" ? undefined : why);
    setBusy(false);
    if (done.ok) onDecided(s.id, `Suggestion dismissed. ${s.suggestedBy.name} is told.`);
    else setError(done.error.message);
  }

  return (
    <Card id={`suggestion-${s.id}`} tabIndex={-1} data-suggestion={s.id}>
      <p className="m-0 font-medium [overflow-wrap:anywhere] whitespace-pre-wrap">
        {visible(s.statement)}
      </p>
      <p className="m-0 mt-1 text-xs text-console-muted">
        {s.kind} · suggested by {visible(s.suggestedBy.name)} on {day(s.createdAt)}
        {showProject ? <> · for {visible(s.projectName)}</> : null}
      </p>
      <Quotes s={s} />
      {dismissing ? (
        <div className="mt-3 flex flex-col gap-2">
          <Field label="Reason (optional)" hint={`${s.suggestedBy.name} sees it.`}>
            <Textarea value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => void dismiss()}>
              Dismiss suggestion
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setDismissing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="primary" disabled={busy} onClick={(e) => void approve(e.currentTarget)}>
            {APPROVE_LABEL}
          </Button>
          <Button disabled={busy} onClick={() => setDismissing(true)}>
            {DISMISS_LABEL}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="m-0 mt-2 text-sm text-status-failed">
          {error}
        </p>
      )}
      {confirmDialog}
    </Card>
  );
}

/** The reader's view of one of their own suggestions: what happened to it. */
export function OwnSuggestion({ suggestion: s }: { readonly suggestion: Suggestion }) {
  return (
    <li className="flex flex-col gap-1">
      <span className="flex flex-wrap items-center gap-2">
        <Badge tone={STATE_TONE[s.state]}>{STATE_LABEL[s.state]}</Badge>
        <span className="[overflow-wrap:anywhere]">{visible(s.statement)}</span>
      </span>
      {s.reason !== null && (
        <span className="text-sm text-console-muted">Reason: {visible(s.reason)}</span>
      )}
    </li>
  );
}
