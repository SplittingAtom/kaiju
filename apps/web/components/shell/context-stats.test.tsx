// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ThreadStats } from "@kaiju/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contextOf, section } from "../../lib/chat/testing/context-fixtures";
import { FakeKaiju } from "../../lib/chat/testing/fake-kaiju";
import { emptyStats } from "../../lib/chat/testing/fake/thread-settings";
import { must } from "../../lib/testing/must";
import { openApp } from "../chat/testing";
import { ContextStats } from "./context-stats";

/**
 * KOBE-842: the Context panel's conversation stats, under the gauge and its legend: grouped
 * definition lists, a tooltip per figure, "Not recorded" for what the server does not have, and a
 * new read with every Refresh.
 */
const T = "00000000-0000-4000-8000-0000000000c1";

function statsOf(over: Partial<ThreadStats> = {}): ThreadStats {
  const base = emptyStats(T) as unknown as ThreadStats;
  return { ...base, ...over };
}

const FULL = statsOf({
  conversation: {
    turns: 7,
    outcomes: {
      completed: 5,
      failed: 1,
      interrupted: 0,
      cancelled: 1,
      budget_stopped: 0,
      in_progress: 0,
    },
    retries: 1,
    compactions: 2,
    branch_summaries: 1,
    failures_by_code: [{ name: "model_error", count: 1 }],
    models: [{ name: "ollama/kimi", count: 12 }],
  },
  tools: {
    calls: 30,
    failed: 4,
    refused: 2,
    approvals: { asked: 3, allowed: 2, denied: 1, expired: 0, pending: 0 },
    skills: {
      uses: 3,
      names: [
        { name: "xlsx", count: 2 },
        { name: "pdf", count: 1 },
      ],
    },
    mcp: [{ name: "jira", count: 5 }],
  },
  tokens: {
    calls: 12,
    input: 12_000,
    output: 3_400,
    cache_read: 150_000,
    cache_write: 2_000,
    reasoning: 800,
    reasoning_estimated: true,
    runs_with_reasoning: 4,
    thinking_levels: [{ level: "high", count: 4 }],
    cost_usd: 0.42,
    unpriced_calls: 0,
  },
  performance: {
    first_token: { median_ms: 640, p95_ms: 2_100, samples: 6 },
    duration: { median_ms: 12_000, p95_ms: 75_000, samples: 7 },
  },
  events: { kept: 6, folded: 1 },
});

const value = (id: string) =>
  must(document.querySelector(`[data-stat="${id}"] [data-stat-value]`)).textContent;

afterEach(() => cleanup());

describe("ContextStats", () => {
  it("shows the groups as definition lists with each figure and a tooltip", () => {
    render(<ContextStats stats={FULL} />);
    const region = screen.getByRole("region", { name: "Conversation stats" });
    for (const name of ["Conversation", "Tools", "Tokens & reasoning", "Performance"]) {
      expect(within(region).getByRole("heading", { name })).toBeTruthy();
    }
    expect(region.querySelectorAll("dl")).toHaveLength(4);
    expect(value("turns")).toBe("7");
    expect(value("outcomes")).toBe("5 completed, 1 failed, 1 stopped");
    expect(value("failures")).toBe("model_error 1");
    expect(value("tool_calls")).toBe("30");
    expect(value("tool_failed")).toBe("4");
    expect(value("tool_refused")).toBe("2");
    expect(value("approvals")).toBe("3 (2 allowed, 1 denied)");
    expect(value("skills")).toBe("3 (xlsx 2, pdf 1)");
    expect(value("mcp")).toBe("jira 5");
    expect(value("input")).toBe("12k");
    expect(value("cached")).toBe("150k read · 2k written");
    expect(value("output")).toBe("3.4k");
    expect(value("reasoning")).toBe("≈800");
    expect(value("thinking")).toBe("4 of 7 (high 4)");
    expect(value("cost")).toBe("$0.42");
    expect(value("first_token")).toBe("median 640 ms · p95 2.1 s");
    expect(value("duration")).toBe("median 12 s · p95 1 min 15 s");
    const term = must(document.querySelector('[data-stat="tool_refused"] dt'));
    expect(term.getAttribute("title")).toContain("policy refused");
    // The meaning is read out after the value too.
    expect(must(document.querySelector('[data-stat="tool_refused"] dd')).textContent).toContain(
      "policy refused",
    );
    expect(screen.getByRole("note").textContent).toContain("1 older turn were cleared");
  });

  it("says Not recorded for null figures, never 0", () => {
    render(
      <ContextStats
        stats={statsOf({
          conversation: { ...FULL.conversation, failures_by_code: null },
          tools: { ...FULL.tools, refused: null },
          tokens: { ...FULL.tokens, reasoning: null, cost_usd: null, unpriced_calls: 12 },
        })}
      />,
    );
    for (const id of ["failures", "tool_refused", "reasoning", "cost", "first_token", "duration"]) {
      expect(value(id), id).toBe("Not recorded");
      expect(
        must(document.querySelector(`[data-stat="${id}"] dd`)).hasAttribute("data-not-recorded"),
      ).toBe(true);
    }
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("says when the stats are being read or could not be read", () => {
    const { rerender } = render(<ContextStats stats={undefined} />);
    expect(screen.getByRole("status").textContent).toBe("Reading the stats…");
    rerender(<ContextStats stats={null} />);
    expect(screen.getByRole("status").textContent).toContain("could not be read");
  });
});

describe("stats in the Context panel", () => {
  let fake: FakeKaiju;
  beforeEach(() => {
    sessionStorage.clear();
    fake = new FakeKaiju();
    fake.teamModels.push({
      alias: "kimi",
      label: "Kimi K2.7 Code",
      enabled: true,
      is_default: true,
      context_window: 200_000,
    });
    vi.stubGlobal("fetch", fake.fetch);
  });
  afterEach(() => vi.unstubAllGlobals());

  const statsReads = (t: string) =>
    fake.requests.filter((r) => r.method === "GET" && r.path === `/v1/threads/${t}/stats`);

  async function open(t: string) {
    openApp(fake, t);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("meter", { name: "Context used" }));
    return { user, dialog: await screen.findByRole("dialog", { name: "Context" }) };
  }

  function thread(): string {
    const t = fake.addThread("Report");
    fake.threadLatestCall.set(t, {
      run_id: "00000000-0000-4000-8000-0000000000aa",
      at: "2026-10-21T10:00:00.000Z",
      model: "ollama/kimi",
      input_tokens: 1_000,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    });
    return t;
  }

  it("sits under the gauge's legend and reads again with Refresh", async () => {
    const t = thread();
    fake.threadContext.set(t, [
      { status: 200, body: contextOf([section("user_message", 100, "Hi")], { thread_id: t }) },
    ]);
    fake.threadStats.set(t, { conversation: { ...FULL.conversation } });
    const { user, dialog } = await open(t);
    const region = await within(dialog).findByRole("region", { name: "Conversation stats" });
    await waitFor(() => expect(value("turns")).toBe("7"));
    const legend = within(dialog).getByRole("list", { name: "Context by kind" });
    // Same column as the legend, after it.
    expect(legend.closest("[data-context-stats]")).toBeNull();
    expect(legend.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(region.parentElement).toBe(must(legend.parentElement).parentElement);
    expect(statsReads(t)).toHaveLength(1);
    await user.click(within(dialog).getByRole("button", { name: "Refresh the context" }));
    await waitFor(() => expect(statsReads(t)).toHaveLength(2));
  });

  it("shows the stats even when the context cannot be read", async () => {
    const t = thread();
    const { dialog } = await open(t);
    const region = await within(dialog).findByRole("region", { name: "Conversation stats" });
    await waitFor(() => expect(value("turns")).toBe("0"));
    expect(within(region).getByRole("heading", { name: "Tools" })).toBeTruthy();
  });
});
