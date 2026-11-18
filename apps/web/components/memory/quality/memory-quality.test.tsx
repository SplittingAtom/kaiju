// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ItemSignalsList,
  PassSignals,
  QualityApi,
  QualityFilter,
} from "../../../lib/memory/quality-api";
import { formatDuration } from "../../../lib/memory/quality-api";
import { MemoryQuality } from "./memory-quality";

/** KOBE-411: the Quality tab shows queue health, item flags with a filter, and Learn's numbers. */
afterEach(cleanup);

const ok = <T,>(data: T) => Promise.resolve({ ok: true as const, status: 200, data });
const signals = (n: number): PassSignals => ({
  passes: n,
  failed: 0,
  shown: 5,
  saved: 2,
  proposed: 1,
  suggested: 0,
  dismissed: 1,
  expired: 0,
  open: 1,
  editedBeforeSave: 1,
});
const flagged = {
  id: "a",
  statement: "Deploys happen on Friday.",
  kind: "fact" as const,
  pinned: false,
  policy: false,
  runs: 12,
  downRuns: 5,
  lastReceivedAt: "2026-11-17T10:00:00Z",
  flags: { checkThis: true, unused: false },
};
const idle = {
  ...flagged,
  id: "b",
  statement: "The wiki moved.",
  runs: 0,
  downRuns: 0,
  lastReceivedAt: null,
  flags: { checkThis: false, unused: true },
};
const list = (filter: QualityFilter): ItemSignalsList => ({
  thresholds: { checkMinRuns: 10, checkDownRatio: 0.3, unusedAfterDays: 90 },
  counts: { all: 2, checkThis: 1, unused: 1 },
  items: filter === "all" ? [flagged, idle] : filter === "check_this" ? [flagged] : [idle],
});

function api(site = false): QualityApi {
  return {
    items: vi.fn((filter: QualityFilter) => ok(list(filter))),
    queues: () =>
      ok({
        windowDays: 30,
        queues: [
          {
            queue: site ? ("site_proposals" as const) : ("workspace_proposals" as const),
            pending: 3,
            oldestPendingAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
            decided: 4,
            medianDecisionSeconds: 7200,
          },
        ],
      }),
    passes: () =>
      site
        ? ok({
            windowDays: 30,
            totals: signals(3),
            workspaces: [{ teamId: "t1", name: "Finance", ...signals(3) }],
          })
        : ok({ windowDays: 30, signals: signals(2) }),
  };
}

describe("MemoryQuality", () => {
  it("Workspace: queue health, flags and pass signals; the filter narrows the list", async () => {
    const a = api();
    render(<MemoryQuality level="workspace" teamId="t" api={a} />);
    const queues = await screen.findByRole("table", { name: "Review queues" });
    const row = within(queues).getByRole("row", { name: /Proposals to this workspace/ });
    expect(row.textContent).toContain("3");
    expect(row.textContent).toContain("2 h");
    const items = await screen.findByRole("table", { name: /Memories with how often/ });
    expect(within(items).getByText("Check this")).toBeTruthy();
    expect(within(items).getByText("Not used lately")).toBeTruthy();
    expect(within(items).getByText("Never")).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText("Show"), "check_this");
    expect(a.items).toHaveBeenLastCalledWith("check_this", "team");
    await screen.findByRole("table", { name: /Memories with how often/ });
    expect(screen.queryByText("The wiki moved.")).toBeNull();
    const passes = await screen.findByRole("table", { name: "Learning pass numbers" });
    expect(within(passes).getByRole("columnheader", { name: "Edited before save" })).toBeTruthy();
    expect(within(passes).getByRole("row", { name: /This workspace/ })).toBeTruthy();
  });

  it("Site: the Site queue and per-workspace numbers with a total", async () => {
    render(<MemoryQuality level="site" api={api(true)} />);
    expect(await screen.findByText("Proposals waiting for the Site")).toBeTruthy();
    const passes = await screen.findByRole("table", { name: "Learning pass numbers" });
    expect(within(passes).getByRole("row", { name: /All workspaces/ })).toBeTruthy();
    expect(within(passes).getByRole("row", { name: /Finance/ })).toBeTruthy();
  });

  it("formats durations", () => {
    expect(formatDuration(600)).toBe("10 min");
    expect(formatDuration(7200)).toBe("2 h");
    expect(formatDuration(5 * 86_400)).toBe("5 days");
  });
});
