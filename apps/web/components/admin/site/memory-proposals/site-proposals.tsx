"use client";

import { useEffect, useMemo, useState } from "react";
import type { MemoryItemsApi } from "../../../../lib/memory/items-api";
import { createMemoryItemsApi } from "../../../../lib/memory/items-api";
import {
  SITE_PROPOSAL_STATES,
  createSiteProposalsApi,
  type SiteProposalsApi,
  type SiteQueue,
  type SiteProposalState,
} from "../../../../lib/memory/site-proposals-api";
import { visible } from "../../../../lib/security/visible";
import { Badge, Button, EmptyState, Field, Notice, Select } from "../../../ui/console";
import { SITE_STATE_LABELS, SiteStateBadge, day, workspaceName } from "./labels";
import { SiteProposalDetailView, type Decided } from "./site-proposal-detail";

const DONE: Readonly<Record<Decided, string>> = {
  approved:
    "Approved: it is a Site memory now and reaches every workspace that has Site memories on.",
  merged: "Merged: the Site memory has a new version with the proposal's wording.",
  rejected: "Rejected. The workspace reads your reason.",
  changes_requested:
    "Sent back to the workspace's Team admins with your note. It returns here once they confirm it again.",
};

/**
 * Site console › Memory › Proposals (KOBE-405, SM20): what Team admins confirmed for the Site,
 * for Site admins and Site memory stewards. Counts per state, filters by state and source
 * Workspace, and one proposal open at a time with its checks and the four decisions. `focusId`
 * (`?site_proposal=<id>` from the bell) opens that proposal.
 */
export function SiteProposals({
  teamId,
  userId,
  canSetPolicy,
  focusId,
  api: givenApi,
  itemsApi: givenItems,
  onDecided,
}: {
  readonly teamId?: string | undefined;
  readonly userId: string;
  readonly canSetPolicy: boolean;
  readonly focusId?: string | null;
  readonly api?: SiteProposalsApi;
  readonly itemsApi?: Pick<MemoryItemsApi, "list">;
  /** A decision changed Site memory (approve, merge): the Memories tab reloads. */
  readonly onDecided?: () => void;
}) {
  const api = useMemo(() => givenApi ?? createSiteProposalsApi(teamId), [givenApi, teamId]);
  const itemsApi = useMemo(() => givenItems ?? createMemoryItemsApi(teamId), [givenItems, teamId]);
  const [state, setState] = useState<SiteProposalState>("awaiting_site");
  const [fromTeamId, setFromTeamId] = useState<string | undefined>(undefined);
  const [queue, setQueue] = useState<SiteQueue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const [openId, setOpenId] = useState<string | null>(focusId ?? null);
  const [done, setDone] = useState<string | null>(null);
  // Every Workspace seen in a list stays in the filter (Site stewards can't list the teams).
  const [workspaces, setWorkspaces] = useState<ReadonlyMap<string, string>>(new Map());

  useEffect(() => {
    let current = true;
    void api.list({ state, fromTeamId }).then((res) => {
      if (!current) return;
      if (!res.ok) {
        setError(res.error.message);
        return;
      }
      setError(null);
      setQueue(res.data);
      setWorkspaces((known) => {
        const next = new Map(known);
        for (const p of res.data.proposals) next.set(p.fromWorkspace.id, workspaceName(p));
        return next;
      });
    });
    return () => {
      current = false;
    };
  }, [api, state, fromTeamId, generation]);

  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 text-console-muted">
        Workspaces propose what every workspace should know. A Team admin confirmed each proposal
        here before it left its workspace; only its statement, kind and justification reach the
        Site, never the conversation it came from. Nobody decides their own proposal. Proposals
        expire 30 days after they were made.
      </p>
      {done && (
        <Notice tone="success" role="status">
          <p className="m-0">{done}</p>
        </Notice>
      )}
      {openId !== null && (
        <SiteProposalDetailView
          key={openId}
          id={openId}
          api={api}
          itemsApi={itemsApi}
          userId={userId}
          canSetPolicy={canSetPolicy}
          onClose={() => setOpenId(null)}
          onDecided={(outcome) => {
            setOpenId(null);
            setDone(DONE[outcome]);
            setGeneration((g) => g + 1);
            if (outcome === "approved" || outcome === "merged") onDecided?.();
          }}
        />
      )}
      {queue && <Counts counts={queue.counts} />}
      <div className="flex flex-wrap gap-3">
        <Field label="State" className="w-fit">
          <Select value={state} onChange={(e) => setState(e.target.value as SiteProposalState)}>
            {SITE_PROPOSAL_STATES.map((s) => (
              <option key={s} value={s}>
                {SITE_STATE_LABELS[s]}
                {queue ? ` (${queue.counts[s] ?? 0})` : ""}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Workspace" className="w-fit">
          <Select
            value={fromTeamId ?? ""}
            onChange={(e) => setFromTeamId(e.target.value === "" ? undefined : e.target.value)}
          >
            <option value="">All workspaces</option>
            {[...workspaces].map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {error ? (
        <Notice tone="error" role="alert">
          <p className="m-0">{error}</p>
        </Notice>
      ) : queue === null ? (
        <p role="status">Loading proposals…</p>
      ) : queue.proposals.length === 0 ? (
        <EmptyState title={`No proposals: ${SITE_STATE_LABELS[state].toLowerCase()}`} />
      ) : (
        <ul aria-label="Site proposals" className="m-0 flex list-none flex-col gap-2 p-0">
          {queue.proposals.map((p) => (
            <li
              key={p.id}
              className="flex flex-wrap items-center gap-2 rounded-md border border-solid border-console-border p-3"
            >
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                {visible(p.statement)}
              </span>
              <SiteStateBadge state={p.state} />
              <Badge>{workspaceName(p)}</Badge>
              <Badge>{day(p.createdAt)}</Badge>
              {p.endorsed && <Badge tone="done">Endorsed</Badge>}
              <Button
                size="sm"
                aria-label={`Review: ${visible(p.statement)}`}
                aria-pressed={openId === p.id}
                onClick={() => {
                  setDone(null);
                  setOpenId(p.id);
                }}
              >
                Review
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Counts({ counts }: { readonly counts: SiteQueue["counts"] }) {
  const shown = SITE_PROPOSAL_STATES.filter((s) => (counts[s] ?? 0) > 0 || s === "awaiting_site");
  return (
    <ul aria-label="Proposals by state" className="m-0 flex list-none flex-wrap gap-2 p-0">
      {shown.map((s) => (
        <li key={s}>
          <Badge tone={s === "awaiting_site" ? "accent" : "neutral"}>
            {`${SITE_STATE_LABELS[s]}: ${counts[s] ?? 0}`}
          </Badge>
        </li>
      ))}
    </ul>
  );
}
