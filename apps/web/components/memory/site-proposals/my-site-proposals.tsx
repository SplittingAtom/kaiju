"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createSiteProposalsApi,
  loadSiteProposals,
  type SiteProposal,
  type SiteProposalsApi,
} from "../../../lib/memory/site-proposals-api";
import { Notice, Section } from "../../ui/console";
import { SiteProposalCard, type SiteAction } from "./site-proposal-card";

const LIST_MAX = 100;
const DONE: Readonly<Record<SiteAction, string>> = {
  confirmed: "Confirmed: it waits for the Site's admins and memory stewards.",
  endorsed: "Endorsed.",
  withdrawn: "Withdrawn. It won't reach the Site.",
};

/**
 * Your Site proposals (KOBE-404), on My memory: what you proposed to the Site from this
 * workspace, where each waits (a Team admin, then the Site), the Site's note when it asked for
 * changes, its reason when it said no, and Withdraw while it is open. The bell's notices about
 * your Site proposals open here (`?site_proposal=<id>`, which takes focus). Hidden when there are
 * none.
 */
export function MySiteProposals({
  teamId,
  userId,
  focusId,
  api: givenApi,
}: {
  readonly teamId: string;
  readonly userId: string;
  readonly focusId?: string | null;
  readonly api?: Pick<SiteProposalsApi, "list" | "confirm" | "endorse" | "withdraw">;
}) {
  const api = useMemo(() => givenApi ?? createSiteProposalsApi(teamId), [givenApi, teamId]);
  const [list, setList] = useState<readonly SiteProposal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void loadSiteProposals(api).then((res) => {
      if (!current) return;
      // Curators get the Workspace's list: keep their own here.
      if (res.ok) setList(res.data.proposals.filter((p) => p.proposer.id === userId));
      // A Site link that fails says so; otherwise the section stays hidden.
      else if (focusId) setError(res.error.message);
    });
    return () => {
      current = false;
    };
  }, [api, userId, focusId]);

  const focused = useRef(false);
  useEffect(() => {
    if (!focusId || focused.current) return;
    const el = document.querySelector<HTMLElement>(
      `[data-my-site-proposal="${CSS.escape(focusId)}"]`,
    );
    if (el) {
      focused.current = true;
      el.focus();
    }
  }, [focusId, list]);

  if (list.length === 0 && error === null) return null;
  return (
    <Section id="memory-my-site-proposals" title="Your Site proposals">
      <p className="m-0 mb-3 text-console-muted">
        What you proposed for every workspace to know. A Team admin confirms each one, then the
        Site&apos;s admins and memory stewards decide.
      </p>
      {error && (
        <Notice tone="error" role="alert">
          <p className="m-0">{error}</p>
        </Notice>
      )}
      <div role="status">
        {done && (
          <Notice tone="success">
            <p className="m-0">{done}</p>
          </Notice>
        )}
      </div>
      {list.length >= LIST_MAX && (
        <p className="m-0 mb-2 text-sm text-console-muted">
          Showing your newest proposals (at most {LIST_MAX} per list).
        </p>
      )}
      <ul aria-label="Your Site proposals" className="m-0 flex list-none flex-col gap-3 p-0">
        {list.map((p) => (
          <li key={p.id} data-my-site-proposal={p.id} tabIndex={-1}>
            <SiteProposalCard
              proposal={p}
              api={api}
              onChanged={(next, action) => {
                setList((l) => l.map((x) => (x.id === next.id ? next : x)));
                setDone(DONE[action]);
              }}
            />
          </li>
        ))}
      </ul>
    </Section>
  );
}
