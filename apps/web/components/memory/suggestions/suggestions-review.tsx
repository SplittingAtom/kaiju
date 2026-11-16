"use client";

import { useEffect, useMemo, useState } from "react";
import {
  createSuggestionsApi,
  type SuggestionList,
  type SuggestionsApi,
} from "../../../lib/memory/suggestions-api";
import { Notice, Section } from "../../ui/console";
import { OwnSuggestion, SuggestionCard } from "./suggestion-card";

export const SUGGESTIONS_HEADING = "project-note-suggestions";

/**
 * Readers' suggestions for project notes (KOBE-652), in two places:
 *
 * - With `projectId` (the project's Memory tab → Suggestions): the open suggestions when the
 *   person decides the project (owner, editor, Team admin), else a line saying who does; and the
 *   person's own suggestions there with what happened to them (a dismissal's reason included).
 * - Without (To review on the Memory page): the open suggestions of every project the person
 *   decides; nothing shows when there are none.
 *
 * `focusId` (the bell's `?suggestion=`): that card takes focus once it shows.
 */
export function SuggestionsReview({
  teamId,
  projectId,
  focusId,
  api: givenApi,
}: {
  readonly teamId: string;
  readonly projectId?: string;
  readonly focusId?: string | null;
  readonly api?: SuggestionsApi;
}) {
  const api = useMemo(() => givenApi ?? createSuggestionsApi(teamId), [givenApi, teamId]);
  const [list, setList] = useState<SuggestionList | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void api.list(projectId).then((res) => {
      if (!current) return;
      if (res.ok) setList(res.data);
      else setFailed(res.error.message);
    });
    return () => {
      current = false;
    };
  }, [api, projectId]);

  const count = list?.suggestions.length ?? 0;
  useEffect(() => {
    if (!focusId || count === 0) return;
    document.getElementById(`suggestion-${focusId}`)?.focus();
  }, [focusId, count]);

  const toReview = projectId === undefined;
  if (failed !== null)
    return toReview ? null : (
      <Notice tone="error" role="alert">
        <p className="m-0">{failed}</p>
      </Notice>
    );
  if (list === null || (toReview && count === 0 && done === null)) return null;

  const decided = (id: string, message: string) => {
    setList((l) => (l ? { ...l, suggestions: l.suggestions.filter((s) => s.id !== id) } : l));
    setDone(message);
  };

  return (
    <>
      {(list.canDecide || toReview) && (
        <Section
          id={SUGGESTIONS_HEADING}
          title={toReview ? `Suggested for project notes (${count})` : `Suggestions (${count})`}
          description="Readers of the project suggested these for its notes. Approve adds one under ## Learned in MEMORY.md; suggestions you leave expire after 30 days."
        >
          {done && (
            <Notice tone="success" role="status">
              <p className="m-0">{done}</p>
            </Notice>
          )}
          {count === 0 ? (
            <p className="m-0 text-console-muted">No suggestions are waiting.</p>
          ) : (
            <ul aria-label="Suggestions" className="m-0 flex list-none flex-col gap-3 p-0">
              {list.suggestions.map((s) => (
                <li key={s.id}>
                  <SuggestionCard
                    suggestion={s}
                    api={api}
                    showProject={toReview}
                    onDecided={decided}
                  />
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
      {!toReview && !list.canDecide && (
        <p className="m-0 text-sm text-console-muted">
          The project&apos;s editors, owners and Team admins decide what goes into its notes. As a
          reader, use Suggest to editors on a memory Kobe found in a conversation of this project.
        </p>
      )}
      {!toReview && list.mine.length > 0 && (
        <Section title="Your suggestions">
          <ul aria-label="Your suggestions" className="m-0 flex list-none flex-col gap-2 p-0">
            {list.mine.map((s) => (
              <OwnSuggestion key={s.id} suggestion={s} />
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}
