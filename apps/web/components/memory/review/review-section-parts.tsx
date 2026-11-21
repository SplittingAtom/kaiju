"use client";

import type { ReactNode } from "react";
import type { ReviewList } from "../../../lib/memory/review-api";
import type { ProjectNotesApi } from "../../../lib/memory/project-notes-api";
import type { SuggestionsApi } from "../../../lib/memory/suggestions-api";
import { visible } from "../../../lib/security/visible";
import { InlineLink } from "../../shell/text-links";
import { Button, Notice } from "../../ui/console";
import type { CardSeams } from "./candidate-card";
import { ProjectNotesAction } from "./project-notes-action";
import { SuggestAction } from "./suggest-action";

const WORKBENCH_HREF = "/me/skills?tab=workbench";

/** The section's notices: the last save with its Undo, what was added or proposed, an error. */
export function ReviewNotices({
  undoable,
  added,
  proposed,
  error,
  busy,
  undo,
}: {
  readonly undoable: { readonly message: string } | null;
  readonly added: string | null;
  readonly proposed: string | null;
  readonly error: string | null;
  readonly busy: boolean;
  undo(): Promise<void>;
}) {
  return (
    <>
      {undoable && (
        <Notice
          tone="success"
          role="status"
          actions={
            <Button size="sm" disabled={busy} onClick={() => void undo()}>
              Undo
            </Button>
          }
        >
          <p className="m-0">{undoable.message}</p>
        </Notice>
      )}
      {added && (
        <Notice tone="success" role="status">
          <p className="m-0">{added}</p>
        </Notice>
      )}
      {proposed && (
        <Notice tone="success" role="status">
          <p className="m-0">{proposed}</p>
        </Notice>
      )}
      {error && (
        <Notice tone="error" role="alert">
          <p className="m-0">{error}</p>
        </Notice>
      )}
    </>
  );
}

/** Skill ideas from the pass, each with a link to the Skill Workbench. */
export function SkillHints({ hints }: { readonly hints: ReviewList["skillHints"] }) {
  if (hints.length === 0) return null;
  return (
    <div className="mt-3">
      <p className="m-0 font-semibold">This could be a skill</p>
      <ul aria-label="Skill ideas" className="m-0 ps-5">
        <div className="mt-3">
          <p className="m-0 font-semibold">This could be a skill</p>
          <ul aria-label="Skill ideas" className="m-0 ps-5">
            {hints.map((h, i) => (
              <li key={i}>
                <span className="font-semibold">{visible(h.title)}</span>: {visible(h.summary)}{" "}
                <InlineLink href={WORKBENCH_HREF}>Open the Skill Workbench</InlineLink>
              </li>
            ))}
          </ul>
        </div>
      </ul>
    </div>
  );
}

/**
 * The cards' project-notes action (KOBE-398, KOBE-652): Suggest to editors for a reader, Add to
 * project notes for an editor; each drops its card and says what happened.
 */
export function projectNotesSeam({
  notes,
  suggestionsApi,
  notesApi,
  drop,
  setAdded,
}: {
  readonly notes: NonNullable<ReviewList["projectNotes"]>;
  readonly suggestionsApi: SuggestionsApi;
  readonly notesApi: ProjectNotesApi;
  drop(ids: readonly string[]): void;
  setAdded(message: string): void;
}): NonNullable<CardSeams["projectNotes"]> {
  return (c, statement, kind): ReactNode =>
    notes.access === "read" ? (
      <SuggestAction
        candidate={c}
        statement={statement}
        kind={kind}
        status={notes}
        api={suggestionsApi}
        onSuggested={(sg) => {
          drop([sg.candidateId]);
          setAdded(
            "Suggested to the project's editors. You'll hear when they add it or dismiss it.",
          );
        }}
      />
    ) : (
      <ProjectNotesAction
        candidate={c}
        statement={statement}
        status={notes}
        api={notesApi}
        onAdded={(a) => {
          drop([a.candidateId]);
          setAdded("Added to the project's notes. Change or remove it in the project's Notes.");
        }}
      />
    );
}
