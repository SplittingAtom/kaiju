"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createReviewApi,
  type Candidate,
  type ReviewApi,
  type ReviewList,
  type SavedCandidate,
} from "../../../lib/memory/review-api";
import { visible } from "../../../lib/security/visible";
import { InlineLink } from "../../shell/text-links";
import { Button, Notice, Section } from "../../ui/console";
import { createProjectNotesApi, type ProjectNotesApi } from "../../../lib/memory/project-notes-api";
import { CandidateCard, type CardSeams } from "./candidate-card";
import { ProjectNotesAction } from "./project-notes-action";

const WORKBENCH_HREF = "/me/skills?tab=workbench";
export const REVIEW_HEADING = "memory-to-review";

/** The last saves, announced with one Undo for all of them. */
interface Undoable {
  readonly message: string;
  readonly saved: readonly SavedCandidate[];
}

/**
 * To review (KOBE-396, SM16), atop the Memories tab: the open candidates of the thread on screen,
 * one card each, **Save all mine** (the new personal ones, one batch) and one Undo for the last
 * save or batch. Nothing shows when the thread has none. `autoFocus`: the panel opened for a
 * finished pass (the heading takes focus).
 */
export function ReviewSection({
  teamId,
  threadId,
  api: givenApi,
  autoFocus = false,
  seams,
  notesApi: givenNotesApi,
}: {
  readonly teamId: string;
  readonly threadId: string | undefined;
  readonly api?: ReviewApi;
  readonly autoFocus?: boolean;
  readonly seams?: CardSeams | undefined;
  /** Add to project notes (KOBE-398); defaults to the real client. */
  readonly notesApi?: ProjectNotesApi;
}) {
  const api = useMemo(() => givenApi ?? createReviewApi(teamId), [givenApi, teamId]);
  const notesApi = useMemo(
    () => givenNotesApi ?? createProjectNotesApi(teamId),
    [givenNotesApi, teamId],
  );
  const [added, setAdded] = useState<string | null>(null);
  const [list, setList] = useState<ReviewList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [undoable, setUndoable] = useState<Undoable | null>(null);
  const [busy, setBusy] = useState(false);
  const [generation, setGeneration] = useState(0);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const cardsRef = useRef<HTMLUListElement | null>(null);

  useEffect(() => {
    if (threadId === undefined) return;
    let current = true;
    void api.list(threadId).then((res) => {
      if (!current) return;
      if (res.ok) setList(res.data);
      // Not the author's thread (404) or none: To review stays hidden.
      else setList(null);
    });
    return () => {
      current = false;
    };
  }, [api, threadId, generation]);

  const count = list?.candidates.length ?? 0;
  // Opened for review: focus goes to the first card's statement (else the section's heading).
  const focused = useRef(false);
  useEffect(() => {
    if (!autoFocus || count === 0 || focused.current) return;
    focused.current = true;
    const first = cardsRef.current?.querySelector<HTMLElement>("[data-review-statement]");
    (first ?? heading.current)?.focus();
  }, [autoFocus, count]);

  if (
    threadId === undefined ||
    list === null ||
    (count === 0 && undoable === null && added === null)
  )
    return null;

  const drop = (ids: readonly string[]) =>
    setList((l) => (l ? { ...l, candidates: l.candidates.filter((c) => !ids.includes(c.id)) } : l));
  const mine = list.candidates.filter((c) => c.saveAllMine);
  const notes = list.projectNotes ?? null;
  const cardSeams: CardSeams | undefined = notes
    ? {
        ...seams,
        projectNotes: (c, statement) => (
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
        ),
      }
    : seams;

  const saveAll = async () => {
    setBusy(true);
    setError(null);
    const res = await api.saveAll(mine.map((c) => c.id));
    setBusy(false);
    if (!res.ok) {
      setError(`${res.error.message} Nothing was saved: check the cards and try again.`);
      return;
    }
    drop(res.data.saved.map((s) => s.candidateId));
    setUndoable({ message: `${res.data.saved.length} memories saved.`, saved: res.data.saved });
  };

  const undo = async () => {
    if (!undoable) return;
    setBusy(true);
    const res = await api.undo(undoable.saved.map((s) => s.candidateId));
    setBusy(false);
    if (!res.ok) {
      setError(res.error.message);
      return;
    }
    setUndoable(null);
    setGeneration((g) => g + 1);
  };

  return (
    <Section id={REVIEW_HEADING} title={`To review (${count})`}>
      <h3 ref={heading} tabIndex={-1} className="sr-only">
        {count === 1 ? "1 memory to review" : `${count} memories to review`}
      </h3>
      <p className="m-0 mb-3 text-console-muted">
        Kobe found these in this conversation. Nothing is saved until you choose. Candidates you
        leave expire after 14 days.
      </p>
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
      {error && (
        <Notice tone="error" role="alert">
          <p className="m-0">{error}</p>
        </Notice>
      )}
      {mine.length > 1 && (
        <div className="my-3">
          <Button variant="primary" disabled={busy} onClick={() => void saveAll()}>
            Save all mine ({mine.length})
          </Button>
        </div>
      )}
      <ul ref={cardsRef} aria-label="Candidates" className="m-0 flex list-none flex-col gap-3 p-0">
        {list.candidates.map((c: Candidate) => (
          <li key={c.id}>
            <CandidateCard
              candidate={c}
              api={api}
              threadId={threadId}
              canCurateWorkspace={list.canCurateWorkspace}
              seams={cardSeams}
              onSaved={(saved) => {
                drop([saved.candidateId]);
                setUndoable({ message: "Memory saved.", saved: [saved] });
              }}
              onDismissed={(d) => drop([d.id])}
            />
          </li>
        ))}
      </ul>
      {list.skillHints.length > 0 && (
        <div className="mt-3">
          <p className="m-0 font-semibold">This could be a skill</p>
          <ul aria-label="Skill ideas" className="m-0 ps-5">
            {list.skillHints.map((h, i) => (
              <li key={i}>
                <span className="font-semibold">{visible(h.title)}</span>: {visible(h.summary)}{" "}
                <InlineLink href={WORKBENCH_HREF}>Open the Skill Workbench</InlineLink>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}
