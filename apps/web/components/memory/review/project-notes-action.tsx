"use client";

import { useId, useState } from "react";
import type { Candidate } from "../../../lib/memory/review-api";
import type {
  NotesAdded,
  ProjectNotesApi,
  ProjectNotesStatus,
} from "../../../lib/memory/project-notes-api";
import { visible } from "../../../lib/security/visible";
import { Button, useConfirm } from "../../ui/console";

export const ADD_LABEL = "Add to project notes";

/**
 * A candidate card's project action (KOBE-398, SM7) in a project thread. Editors, owners and
 * Team admins get **Add to project notes**: the server previews the exact change (the line under
 * `## Learned` in the project's `MEMORY.md`) with a signed approval, the person approves it in a
 * dialog, and the server writes it after checking everything again. Disabled with the server's
 * reason when project memory is off or the file is full. Readers never get Add: the card shows
 * **Suggest to editors** instead (`suggest-action.tsx`, KOBE-652).
 */
export function ProjectNotesAction({
  candidate,
  statement,
  status,
  api,
  onAdded,
}: {
  readonly candidate: Candidate;
  /** The card's statement as edited (sent only when it differs). */
  readonly statement: string;
  readonly status: ProjectNotesStatus;
  readonly api: ProjectNotesApi;
  readonly onAdded: (added: NotesAdded) => void;
}) {
  const reasonId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();

  if (!status.available)
    return (
      <span className="flex max-w-xs flex-col gap-1">
        <Button disabled aria-describedby={reasonId}>
          {ADD_LABEL}
        </Button>
        <span id={reasonId} className="text-xs text-console-muted">
          {status.reason}
        </span>
      </span>
    );

  async function start(trigger: HTMLElement) {
    setError(null);
    setBusy(true);
    const edited = statement === candidate.statement ? undefined : statement;
    const preview = await api.preview(candidate.id, edited);
    if (!preview.ok) {
      setBusy(false);
      setError(preview.error.message);
      return;
    }
    const yes = await confirm(
      {
        title: "Add to project notes?",
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
            {(preview.data.warnings ?? []).length > 0 ? (
              <span role="note" className="mt-2 block text-xs text-console-warning">
                {(preview.data.warnings ?? []).map((w) => (
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
    const added = await api.add(candidate.id, preview.data, edited);
    setBusy(false);
    if (added.ok) onAdded(added.data);
    else setError(added.error.message);
  }

  return (
    <>
      <Button disabled={busy} onClick={(e) => void start(e.currentTarget)}>
        {ADD_LABEL}
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
