"use client";

import { useId, useState } from "react";
import type { ItemKind } from "../../../lib/memory/items-api";
import type { Candidate } from "../../../lib/memory/review-api";
import type { ProjectNotesStatus } from "../../../lib/memory/project-notes-api";
import type { Suggested, SuggestionsApi } from "../../../lib/memory/suggestions-api";
import { visible } from "../../../lib/security/visible";
import { Button, useConfirm } from "../../ui/console";

export const SUGGEST_LABEL = "Suggest to editors";

/**
 * A project reader's **Suggest to editors** on a candidate card (KOBE-652, SM7/Q2): readers can't
 * write the project's notes, so the statement (as edited) and its kind go to the project's
 * editors, owners and Team admins with the quotes of the reader's own messages (the server keeps
 * only those, and refuses when there are none). They approve it into the project's notes or
 * dismiss it; the reader is told either way. Disabled with the server's reason when project
 * memory is off.
 */
export function SuggestAction({
  candidate,
  statement,
  kind,
  status,
  api,
  onSuggested,
}: {
  readonly candidate: Candidate;
  readonly statement: string;
  readonly kind: ItemKind;
  readonly status: ProjectNotesStatus;
  readonly api: SuggestionsApi;
  readonly onSuggested: (s: Suggested) => void;
}) {
  const reasonId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();

  if (!status.available)
    return (
      <span className="flex max-w-xs flex-col gap-1">
        <Button disabled aria-describedby={reasonId}>
          {SUGGEST_LABEL}
        </Button>
        <span id={reasonId} className="text-xs text-console-muted">
          {status.reason}
        </span>
      </span>
    );

  async function start(trigger: HTMLElement) {
    setError(null);
    const yes = await confirm(
      {
        title: "Suggest to the project's editors?",
        description: (
          <>
            <span className="block">
              The project&apos;s editors, owners and Team admins see this statement and the quotes
              from your own messages in this conversation. They can add it to the project&apos;s
              notes or dismiss it, and you&apos;ll hear which. Suggestions wait 30 days.
            </span>
            <span className="mt-2 block border-0 border-l-4 border-solid border-console-border ps-3 [overflow-wrap:anywhere] whitespace-pre-wrap">
              {visible(statement)}
            </span>
            <span className="mt-1 block text-xs text-console-muted">Kind: {kind}</span>
          </>
        ),
        confirmLabel: "Suggest",
        tone: "primary",
      },
      trigger,
    );
    if (!yes) return;
    setBusy(true);
    const res = await api.suggest(candidate.id, {
      ...(statement === candidate.statement ? {} : { statement }),
      ...(kind === candidate.kind ? {} : { kind }),
    });
    setBusy(false);
    if (res.ok) onSuggested(res.data);
    else setError(res.error.message);
  }

  return (
    <>
      <Button disabled={busy} onClick={(e) => void start(e.currentTarget)}>
        {SUGGEST_LABEL}
      </Button>
      {error && (
        <p role="alert" className="m-0 basis-full text-sm text-status-failed">
          {error}
        </p>
      )}
      {confirmDialog}
    </>
  );
}
