"use client";

import { useMemo } from "react";
import {
  createQualityApi,
  formatDuration,
  isSitePasses,
  type PassSignals,
  type QualityApi,
  type QualityLevel,
  type QueueHealthList,
  type QueueName,
  type SitePassSignals,
  type WorkspacePassSignals,
} from "../../../lib/memory/quality-api";
import { ResourceView } from "../../admin/parts";
import { useResource } from "../../admin/use-resource";
import {
  EmptyState,
  Section,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
} from "../../ui/console";
import { ItemFlags } from "./item-flags";

const QUEUE_LABELS: Readonly<Record<QueueName, string>> = {
  workspace_proposals: "Proposals to this workspace",
  project_suggestions: "Readers' project note suggestions",
  site_proposals: "Proposals waiting for the Site",
};

const SIGNALS: readonly (readonly [keyof PassSignals, string])[] = [
  ["passes", "Passes"],
  ["failed", "Failed"],
  ["shown", "Shown"],
  ["saved", "Saved"],
  ["editedBeforeSave", "Edited before save"],
  ["proposed", "Proposed"],
  ["suggested", "Suggested to editors"],
  ["dismissed", "Dismissed"],
  ["expired", "Expired"],
  ["open", "Still in To review"],
];

const ageOf = (iso: string | null) =>
  iso === null ? "None" : formatDuration((Date.now() - new Date(iso).getTime()) / 1000);

/**
 * Memory › Quality (KOBE-411, SM22, SM30) for curators: queue health, how each memory is used
 * (with Check this and Not used lately flags and a filter), and Learn's numbers. `workspace`:
 * the active Workspace; `site`: Site memories, the Site's proposal queue and Learn's numbers per
 * Workspace (numbers only: nothing from a conversation crosses to the Site). Read only.
 */
export function MemoryQuality({
  level,
  teamId,
  api: givenApi,
}: {
  readonly level: QualityLevel;
  readonly teamId?: string | undefined;
  readonly api?: QualityApi;
}) {
  const api = useMemo(() => givenApi ?? createQualityApi(level, teamId), [givenApi, level, teamId]);
  return (
    <>
      <QueueHealthSection api={api} />
      <ItemFlags api={api} {...(level === "workspace" ? { scope: "team" as const } : {})} />
      <PassSignalsSection api={api} level={level} />
    </>
  );
}

function QueueHealthSection({ api }: { readonly api: Pick<QualityApi, "queues"> }) {
  const { state } = useResource(() => api.queues());
  return (
    <Section
      title="Queue health"
      level={3}
      description="What waits for a decision now, and how long decisions took over the last 30 days (expired items are not decisions)."
    >
      <ResourceView state={state} label="queue health">
        {(q: QueueHealthList) => (
          <Table caption="Review queues">
            <TableHead>
              <TableRow>
                <TableHeader>Queue</TableHeader>
                <TableHeader numeric>Pending</TableHeader>
                <TableHeader>Oldest waiting</TableHeader>
                <TableHeader numeric>Decided</TableHeader>
                <TableHeader>Median time to decision</TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {q.queues.map((x) => (
                <TableRow key={x.queue}>
                  <TableRowHeader>{QUEUE_LABELS[x.queue]}</TableRowHeader>
                  <TableCell numeric>{x.pending}</TableCell>
                  <TableCell>{ageOf(x.oldestPendingAt)}</TableCell>
                  <TableCell numeric>{x.decided}</TableCell>
                  <TableCell>
                    {x.medianDecisionSeconds === null
                      ? "—"
                      : formatDuration(x.medianDecisionSeconds)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </ResourceView>
    </Section>
  );
}

function PassSignalsSection({
  api,
  level,
}: {
  readonly api: Pick<QualityApi, "passes">;
  readonly level: QualityLevel;
}) {
  const { state } = useResource(() => api.passes());
  return (
    <Section
      title="Learn from this chat"
      level={3}
      description={
        level === "site"
          ? "Learning passes that finished in the last 30 days, per workspace: numbers only, nothing from a conversation."
          : "Learning passes that finished in the last 30 days, and what people did with the memories they suggested."
      }
    >
      <ResourceView state={state} label="learning numbers">
        {(p: WorkspacePassSignals | SitePassSignals) =>
          isSitePasses(p) ? (
            <SitePasses p={p} />
          ) : (
            <SignalsTable rows={[{ key: "workspace", name: "This workspace", s: p.signals }]} />
          )
        }
      </ResourceView>
    </Section>
  );
}

function SitePasses({ p }: { readonly p: SitePassSignals }) {
  if (p.workspaces.length === 0)
    return (
      <EmptyState title="No learning passes">
        No workspace ran Learn in the last 30 days.
      </EmptyState>
    );
  return (
    <SignalsTable
      rows={[
        { key: "all", name: "All workspaces", s: p.totals },
        ...p.workspaces.map((w) => ({ key: w.teamId, name: w.name, s: w })),
      ]}
    />
  );
}

function SignalsTable({
  rows,
}: {
  readonly rows: readonly {
    readonly key: string;
    readonly name: string;
    readonly s: PassSignals;
  }[];
}) {
  return (
    <Table caption="Learning pass numbers">
      <TableHead>
        <TableRow>
          <TableHeader>Where</TableHeader>
          {SIGNALS.map(([key, label]) => (
            <TableHeader key={key} numeric>
              {label}
            </TableHeader>
          ))}
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.map(({ key: rowKey, name, s }) => (
          <TableRow key={rowKey}>
            <TableRowHeader>{name}</TableRowHeader>
            {SIGNALS.map(([key]) => (
              <TableCell key={key} numeric>
                {s[key]}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
