"use client";

import { useState } from "react";
import type { ItemKind } from "../../../lib/memory/items-api";
import type { ProposalsApi, Proposed } from "../../../lib/memory/proposals-api";
import { Button, Field, Textarea } from "../../ui/console";

const NOTE_MAX = 1000;

/**
 * Propose… on a To review card (KOBE-397, SM22), for a member who doesn't curate the Workspace:
 * sends the candidate as shown (with the card's edits) and an optional note to the Workspace's
 * curators (Team admins and memory stewards). The person's quotes go with it; nothing is saved
 * until a curator approves. Its own small component beside Save (KOBE-398 adds another there).
 */
export function ProposeAction({
  candidateId,
  original,
  draft,
  api,
  disabled = false,
  onProposed,
}: {
  readonly candidateId: string;
  readonly original: { readonly statement: string; readonly kind: ItemKind };
  readonly draft: { readonly statement: string; readonly kind: ItemKind };
  readonly api: Pick<ProposalsApi, "propose">;
  readonly disabled?: boolean;
  readonly onProposed: (proposed: Proposed) => void;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open)
    return (
      <Button disabled={disabled} aria-expanded={false} onClick={() => setOpen(true)}>
        Propose…
      </Button>
    );

  async function send() {
    if (draft.statement.trim() === "") {
      setError("Write the memory first.");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await api.propose(candidateId, {
      ...(draft.statement === original.statement ? {} : { statement: draft.statement }),
      ...(draft.kind === original.kind ? {} : { kind: draft.kind }),
      ...(note.trim() === "" ? {} : { rationale: note.trim() }),
    });
    setBusy(false);
    if (res.ok) onProposed(res.data);
    else setError(res.error.message);
  }

  return (
    <div
      role="group"
      aria-label="Propose to the Workspace"
      className="flex w-full flex-col gap-2 rounded border border-console-border p-3"
    >
      <p className="m-0 text-sm">
        Team admins and memory stewards decide. They see the statement, your note and your words
        from this conversation. Proposals wait up to 30 days.
      </p>
      <Field label="Note for the curators (optional)" hint={`At most ${NOTE_MAX} characters.`}>
        <Textarea
          value={note}
          maxLength={NOTE_MAX}
          rows={2}
          autoFocus
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
      {error && (
        <p role="alert" className="m-0 text-sm text-status-failed">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={busy} onClick={() => void send()}>
          Send to curators
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
