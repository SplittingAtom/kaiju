/**
 * Conversation stats (KOBE-842): `GET /v1/threads/{id}/stats` read for the Context panel and
 * turned into its rows, grouped Conversation, Tools, Tokens & reasoning and Performance. A figure
 * the server does not have (null) reads "Not recorded", never 0. Names (models, skills,
 * connectors, error codes) are shown as plain text.
 */
import {
  threadStatsSchema,
  type ThreadStats,
  type ThreadStatsNamedCount,
  type ThreadStatsSpread,
} from "@kaiju/protocol";
import { formatTokens, formatUsd } from "../admin/usage-format";
import { readWire } from "./wire-read";

export const NOT_RECORDED = "Not recorded";

/** One read, validated as sent. Never throws: null on any failure. */
export function readThreadStats(
  threadId: string,
  teamId: string,
  fetchFn: typeof fetch = fetch,
): Promise<ThreadStats | null> {
  return readWire(
    `/v1/threads/${encodeURIComponent(threadId)}/stats`,
    threadStatsSchema,
    teamId,
    fetchFn,
  );
}

export interface StatRow {
  readonly id: string;
  readonly term: string;
  /** null: not recorded. */
  readonly value: string | null;
  /** What the figure means (the row's tooltip and description). */
  readonly hint: string;
}

export interface StatGroup {
  readonly id: "conversation" | "tools" | "tokens" | "performance";
  readonly title: string;
  readonly rows: readonly StatRow[];
}

const n = (v: number) => v.toLocaleString("en-US");

/** "xlsx 2, pdf 1"; "None" for an empty list; null for null. */
export function namedList(list: readonly ThreadStatsNamedCount[] | null): string | null {
  if (list === null) return null;
  if (list.length === 0) return "None";
  return list.map((i) => `${i.name} ${n(i.count)}`).join(", ");
}

/** "1.2 s" / "640 ms". */
export function formatMs(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1).replace(/\.0$/, "")} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`;
}

/** "median 1.2 s · p95 4 s"; null when there are no samples. */
export function formatSpread(s: ThreadStatsSpread | null): string | null {
  if (s === null) return null;
  return `median ${formatMs(s.median_ms)} · p95 ${formatMs(s.p95_ms)}`;
}

function outcomes(s: ThreadStats): string {
  const o = s.conversation.outcomes;
  const parts: [string, number][] = [
    ["completed", o.completed],
    ["failed", o.failed],
    ["interrupted", o.interrupted],
    ["stopped", o.cancelled],
    ["budget stopped", o.budget_stopped],
    ["in progress", o.in_progress],
  ];
  const shown = parts.filter(([, v]) => v > 0);
  return shown.length === 0 ? "None" : shown.map(([k, v]) => `${n(v)} ${k}`).join(", ");
}

function approvals(s: ThreadStats): string {
  const a = s.tools.approvals;
  if (a.asked === 0) return "0";
  const parts = [`${n(a.allowed)} allowed`, `${n(a.denied)} denied`];
  if (a.expired > 0) parts.push(`${n(a.expired)} expired`);
  if (a.pending > 0) parts.push(`${n(a.pending)} waiting`);
  return `${n(a.asked)} (${parts.join(", ")})`;
}

function reasoning(s: ThreadStats): string | null {
  const t = s.tokens;
  if (t.reasoning === null) return null;
  return `${t.reasoning_estimated ? "≈" : ""}${formatTokens(t.reasoning)}`;
}

function thinking(s: ThreadStats): string {
  const levels = s.tokens.thinking_levels;
  const on = `${n(s.tokens.runs_with_reasoning)} of ${n(s.conversation.turns)}`;
  if (levels.length === 0) return on;
  return `${on} (${levels.map((l) => `${l.level} ${n(l.count)}`).join(", ")})`;
}

function cost(s: ThreadStats): string | null {
  const t = s.tokens;
  if (t.cost_usd === null) return null;
  return t.unpriced_calls > 0
    ? `${formatUsd(t.cost_usd)} (${n(t.unpriced_calls)} unpriced)`
    : formatUsd(t.cost_usd);
}

const EVENTS_NOTE = "Kept for 7 days after a turn ends.";

/** The panel's rows; `refused`, failure codes and first token cover kept events only. */
export function statGroups(s: ThreadStats): StatGroup[] {
  return [
    {
      id: "conversation",
      title: "Conversation",
      rows: [
        {
          id: "turns",
          term: "Turns",
          value: n(s.conversation.turns),
          hint: "Messages Kaiju answered, on every branch (retries included).",
        },
        {
          id: "outcomes",
          term: "Outcomes",
          value: outcomes(s),
          hint: "How each turn ended. Stopped: you pressed Stop.",
        },
        {
          id: "failures",
          term: "Failures by code",
          value: namedList(s.conversation.failures_by_code),
          hint: `Why failed turns failed, by error code. ${EVENTS_NOTE}`,
        },
        {
          id: "retries",
          term: "Retries",
          value: n(s.conversation.retries),
          hint: "Turns that retried an interrupted one.",
        },
        {
          id: "compactions",
          term: "Compactions",
          value: n(s.conversation.compactions),
          hint: "Times the history was summarised to free context (automatic or Compact now).",
        },
        {
          id: "branch_summaries",
          term: "Branch summaries",
          value: n(s.conversation.branch_summaries),
          hint: "Summaries carried into a branch when you switched branches.",
        },
        {
          id: "models",
          term: "Models",
          value: namedList(s.conversation.models),
          hint: "Model calls the turns made, by model.",
        },
      ],
    },
    {
      id: "tools",
      title: "Tools",
      rows: [
        {
          id: "tool_calls",
          term: "Tool calls",
          value: n(s.tools.calls),
          hint: "Tools the agent called, on every branch.",
        },
        {
          id: "tool_failed",
          term: "Failed",
          value: n(s.tools.failed),
          hint: "Tool calls that returned an error, refused and denied ones included.",
        },
        {
          id: "tool_refused",
          term: "Refused by policy",
          value: s.tools.refused === null ? null : n(s.tools.refused),
          hint: `Calls Kaiju's tool policy refused without asking. ${EVENTS_NOTE}`,
        },
        {
          id: "approvals",
          term: "Approvals",
          value: approvals(s),
          hint: "Calls that asked for your approval, and what became of them.",
        },
        {
          id: "skills",
          term: "Skills used",
          value:
            s.tools.skills.uses === 0
              ? "0"
              : `${n(s.tools.skills.uses)} (${namedList(s.tools.skills.names) ?? ""})`,
          hint: "Times the agent read a skill's instructions, by skill.",
        },
        {
          id: "mcp",
          term: "Connector calls",
          value: namedList(s.tools.mcp),
          hint: "Calls to connector (MCP) tools, by connector.",
        },
      ],
    },
    {
      id: "tokens",
      title: "Tokens & reasoning",
      rows: [
        {
          id: "input",
          term: "Input",
          value: formatTokens(s.tokens.input),
          hint: "Input tokens not read from or written to the prompt cache.",
        },
        {
          id: "cached",
          term: "Cached input",
          value: `${formatTokens(s.tokens.cache_read)} read · ${formatTokens(s.tokens.cache_write)} written`,
          hint: "Input tokens read from, or written to, the provider's prompt cache.",
        },
        {
          id: "output",
          term: "Output",
          value: formatTokens(s.tokens.output),
          hint: "Tokens the model wrote, reasoning included.",
        },
        {
          id: "reasoning",
          term: "Reasoning",
          value: reasoning(s),
          hint: "Output tokens spent thinking. ≈ means estimated from the reasoning text.",
        },
        {
          id: "thinking",
          term: "Thinking on",
          value: thinking(s),
          hint: "Turns with thinking on, and the thinking level each turn used.",
        },
        {
          id: "cost",
          term: "Cost",
          value: cost(s),
          hint: "At the catalog's prices when each call was made. Not recorded: no call had a price.",
        },
      ],
    },
    {
      id: "performance",
      title: "Performance",
      rows: [
        {
          id: "first_token",
          term: "First token",
          value: formatSpread(s.performance.first_token),
          hint: `From a turn's start to its first streamed text or reasoning. ${EVENTS_NOTE}`,
        },
        {
          id: "duration",
          term: "Turn duration",
          value: formatSpread(s.performance.duration),
          hint: "From a turn's start to its end, over ended turns.",
        },
      ],
    },
  ];
}

/** A note when some figures cover only recent turns; null when nothing was folded away. */
export function eventsNote(s: ThreadStats): string | null {
  const { kept, folded } = s.events;
  if (folded === 0) return null;
  return `Failures by code, Refused by policy and First token cover the ${n(kept)} most recent ended turns; the details of ${n(folded)} older ${folded === 1 ? "turn were" : "turns were"} cleared after 7 days.`;
}
