"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createSiteProposalsApi,
  describeSiteChecks,
  loadSiteProposals,
  moreThanShown,
  type SiteChecks,
  type SiteProposal,
  type SiteProposalsApi,
} from "../../../lib/memory/site-proposals-api";
import { EmptyState, Notice, Section } from "../../ui/console";
import { SiteProposalCard, type SiteAction } from "./site-proposal-card";

const DONE: Readonly<Record<SiteAction, string>> = {
  confirmed: "Confirmed: it waits for the Site's admins and memory stewards.",
  endorsed: "Endorsed. Team admins see your endorsement when they confirm.",
  withdrawn: "Withdrawn. It won't reach the Site.",
};

const GROUPS = [
  {
    key: "team",
    title: "Waiting for a Team admin",
    empty: "Nothing waits for a Team admin.",
    what: "proposals waiting for a Team admin",
    has: (p: SiteProposal) => p.state === "awaiting_team",
  },
  {
    key: "site",
    title: "Waiting for the Site",
    empty: "Nothing waits for the Site.",
    what: "proposals waiting for the Site",
    has: (p: SiteProposal) => p.state === "awaiting_site",
  },
  {
    key: "closed",
    title: "Closed",
    empty: "No decided, withdrawn or expired proposals yet.",
    what: "closed proposals, newest first",
    has: (p: SiteProposal) => p.state !== "awaiting_team" && p.state !== "awaiting_site",
  },
] as const;

/** How many proposals a group holds in all, from the list's counts per state. */
function totalOf(group: (typeof GROUPS)[number]["key"], counts: Readonly<Record<string, number>>) {
  const team = counts.awaiting_team ?? 0;
  const site = counts.awaiting_site ?? 0;
  if (group === "team") return team;
  if (group === "site") return site;
  return Object.values(counts).reduce((a, b) => a + b, 0) - team - site;
}

/**
 * Workspace console › Memory › To the Site (KOBE-404, SM19): this Workspace's proposals to the
 * Site for its curators (Team admins and memory stewards; KOBE-403 lists a member only their
 * own, and the console doesn't show members this tab). Grouped by where each waits: Team admins
 * confirm (with edits) or withdraw; other curators endorse. `focusId` (`?site_proposal=<id>`,
 * the bell) takes focus when it is listed.
 */
export function WorkspaceSiteQueue({
  teamId,
  focusId,
  api: givenApi,
}: {
  readonly teamId: string;
  readonly focusId?: string | null;
  readonly api?: Pick<SiteProposalsApi, "list" | "confirm" | "endorse" | "withdraw">;
}) {
  const api = useMemo(() => givenApi ?? createSiteProposalsApi(teamId), [givenApi, teamId]);
  const [list, setList] = useState<readonly SiteProposal[] | null>(null);
  const [counts, setCounts] = useState<Readonly<Record<string, number>>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let current = true;
    void loadSiteProposals(api).then((res) => {
      if (!current) return;
      if (res.ok) {
        setList(res.data.proposals);
        setCounts(res.data.counts);
      } else setError(res.error.message);
    });
    return () => {
      current = false;
    };
  }, [api]);

  const focused = useRef(false);
  useEffect(() => {
    if (!focusId || !list || focused.current) return;
    const el = root.current?.querySelector<HTMLElement>(
      `[data-site-proposal="${CSS.escape(focusId)}"]`,
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
  if (list === null) return <p role="status">Loading Site proposals…</p>;

  const changed = (p: SiteProposal, action: SiteAction, checks?: SiteChecks) => {
    setList((l) => (l ? l.map((x) => (x.id === p.id ? p : x)) : l));
    const note = checks ? describeSiteChecks(checks) : null;
    setDone(note ? `${DONE[action]} ${note}` : DONE[action]);
  };

  return (
    <div ref={root} className="flex flex-col gap-3">
      <p className="m-0 text-console-muted">
        What this workspace proposes for every workspace to know. A Team admin confirms each one
        (and may edit it) before the Site&apos;s admins and memory stewards decide; only the
        statement, its kind and the justification leave this workspace. Proposals expire after 30
        days.
      </p>
      <div role="status">
        {done && (
          <Notice tone="success">
            <p className="m-0">{done}</p>
          </Notice>
        )}
      </div>
      {list.length === 0 ? (
        <EmptyState title="No Site proposals">
          Propose a Workspace memory with Propose to Site, or from To review in a conversation.
        </EmptyState>
      ) : (
        GROUPS.map((g) => {
          const shown = list.filter(g.has);
          const more = moreThanShown(shown.length, totalOf(g.key, counts), g.what);
          return (
            <Section key={g.key} level={3} title={`${g.title} (${shown.length})`} className="mt-2">
              {more && <p className="m-0 mb-2 text-sm text-console-muted">{more}</p>}
              {shown.length === 0 ? (
                <p className="m-0 text-sm text-console-muted">{g.empty}</p>
              ) : (
                <ul aria-label={g.title} className="m-0 flex list-none flex-col gap-3 p-0">
                  {shown.map((p) => (
                    <li key={p.id} data-site-proposal={p.id} tabIndex={-1}>
                      <SiteProposalCard proposal={p} api={api} onChanged={changed} />
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          );
        })
      )}
    </div>
  );
}
