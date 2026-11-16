"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createProposalsApi,
  type ProposalsApi,
  type QueuedProposal,
} from "../../../lib/memory/proposals-api";
import { EmptyState, Notice } from "../../ui/console";
import { ProposalCard, type Outcome } from "./proposal-card";

const DONE: Readonly<Record<Outcome, string>> = {
  approved: "Approved: it is a Workspace memory now and reaches every member's next run.",
  changes_requested: "Sent back for changes. The proposer can edit it and propose it again.",
  dismissed: "Dismissed. The proposer reads your reason.",
};

/**
 * Workspace console › Memory › Proposals (KOBE-397, SM22): the pending proposals of this
 * Workspace, oldest first, for its curators. `focusId` (`?proposal=<id>` from the bell) takes
 * focus when it is in the list.
 */
export function ProposalQueue({
  teamId,
  userId,
  focusId,
  api: givenApi,
}: {
  readonly teamId: string;
  readonly userId: string;
  readonly focusId?: string | null;
  readonly api?: Pick<ProposalsApi, "queue" | "approve" | "turnDown">;
}) {
  const api = useMemo(() => givenApi ?? createProposalsApi(teamId), [givenApi, teamId]);
  const [list, setList] = useState<readonly QueuedProposal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  useEffect(() => {
    let current = true;
    void api.queue().then((res) => {
      if (!current) return;
      if (res.ok) setList(res.data.proposals);
      else setError(res.error.message);
    });
    return () => {
      current = false;
    };
  }, [api]);

  const focused = useRef(false);
  useEffect(() => {
    if (!focusId || !list || focused.current) return;
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-proposal="${CSS.escape(focusId)}"]`,
    );
    if (el) {
      focused.current = true;
      el.focus();
    }
  }, [focusId, list]);

  if (error)
    return (
      <Notice tone="error" role="alert">
        <p className="m-0">{error}</p>
      </Notice>
    );
  if (list === null) return <p role="status">Loading proposals…</p>;
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 text-console-muted">
        Members propose what everyone in this workspace should know. Approve to save it as a
        Workspace memory; nobody decides their own proposal. Proposals expire after 30 days.
      </p>
      {done && (
        <Notice tone="success" role="status">
          <p className="m-0">{done}</p>
        </Notice>
      )}
      {list.length === 0 ? (
        <EmptyState title="No proposals waiting" />
      ) : (
        <ul ref={listRef} aria-label="Proposals" className="m-0 flex list-none flex-col gap-3 p-0">
          {list.map((p) => (
            <li key={p.id}>
              <ProposalCard
                proposal={p}
                api={api}
                mine={p.proposer.id === userId}
                onDecided={(d, outcome) => {
                  setList((l) => (l ? l.filter((x) => x.id !== d.id) : l));
                  setDone(DONE[outcome]);
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
