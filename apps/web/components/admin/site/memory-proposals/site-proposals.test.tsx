// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "../../../../lib/api/client";
import type { MemoryItem } from "../../../../lib/memory/items-api";
import type {
  SiteProposal,
  SiteProposalDetail,
  SiteProposalsApi,
  SiteQueue,
  SiteQueueQuery,
} from "../../../../lib/memory/site-proposals-api";
import { countsFromWire } from "../../../../lib/memory/site-proposals-api";
import { SiteProposals } from "./site-proposals";

/** KOBE-405: Site console › Memory › Proposals (the client side of KOBE-403's Site API). */
const ME = "00000000-0000-4000-8000-000000000001";
const MEMBER = "00000000-0000-4000-8000-000000000002";
const WS = "00000000-0000-4000-8000-0000000000aa";
const ok = <T,>(data: T) => Promise.resolve({ ok: true as const, status: 200, data });
const refused = (status: number, code: string, message: string) =>
  Promise.resolve({ ok: false as const, error: { status, code, message } });

const proposal = (over: Partial<SiteProposal> = {}): SiteProposal => ({
  id: "p1",
  statement: "We deploy from the main branch",
  kind: "fact",
  justification: "Every workspace asks where deploys come from.",
  endorsed: true,
  state: "awaiting_site",
  rounds: 1,
  proposer: { id: MEMBER, name: "Member One" },
  confirmedBy: { id: MEMBER, name: "Member One" },
  confirmedAt: "2026-11-15T00:00:00Z",
  reason: null,
  changesNote: null,
  decidedAt: null,
  decidedBy: null,
  mergedInto: null,
  expiresAt: new Date(Date.now() + 20 * 86_400_000).toISOString(),
  createdAt: "2026-11-14T00:00:00Z",
  updatedAt: "2026-11-15T00:00:00Z",
  fromWorkspace: { id: WS, name: "Platform" },
  ...over,
});

const detail = (over: Partial<SiteProposal> = {}, checks = {}): SiteProposalDetail => ({
  proposal: proposal(over),
  checks: {
    secret: false,
    warnings: [],
    nearDuplicates: [{ id: "d1", version: 2, statement: "We deploy from main", policy: false }],
    policyConflicts: [{ id: "x1", version: 1, statement: "We never deploy from the main branch" }],
    ...checks,
  },
});

const item = { id: "d1", version: 3 } as MemoryItem;

function fakeApi(list: SiteProposal[], one: SiteProposalDetail = detail()) {
  return {
    list: vi.fn((q: SiteQueueQuery): Promise<ApiResult<SiteQueue>> =>
      ok({
        proposals: list.filter((p) => p.state === q.state),
        counts: { awaiting_site: 2, approved: 5, rejected: 1 },
      }),
    ),
    get: vi.fn((_id: string) => ok(one)),
    approve: vi.fn((): Promise<ApiResult<{ proposal: SiteProposal; item: MemoryItem }>> =>
      ok({ proposal: proposal({ state: "approved" }), item }),
    ),
    merge: vi.fn((): Promise<ApiResult<{ proposal: SiteProposal; item: MemoryItem }>> =>
      ok({ proposal: proposal({ state: "merged" }), item }),
    ),
    reject: vi.fn((): Promise<ApiResult<{ proposal: SiteProposal }>> =>
      ok({ proposal: proposal({ state: "rejected" }) }),
    ),
    requestChanges: vi.fn((): Promise<ApiResult<{ proposal: SiteProposal }>> =>
      ok({ proposal: proposal({ state: "awaiting_team" }) }),
    ),
  } satisfies SiteProposalsApi;
}

const siteItems = {
  list: vi.fn(() =>
    ok({
      scope: "site" as const,
      items: [
        { id: "d1", version: 2, statement: "We deploy from main", policy: false },
        { id: "o1", version: 1, statement: "Office hours are 9 to 5", policy: false },
      ] as unknown as MemoryItem[],
      nextCursor: null,
      usage: { count: 2, max: 1000 },
    }),
  ),
};

function show(api: SiteProposalsApi, props: { focusId?: string; canSetPolicy?: boolean } = {}) {
  return render(
    <SiteProposals
      userId={ME}
      canSetPolicy={props.canSetPolicy ?? false}
      focusId={props.focusId ?? null}
      api={api}
      itemsApi={siteItems}
    />,
  );
}

async function open(api: ReturnType<typeof fakeApi>) {
  show(api);
  await userEvent.click(
    await screen.findByRole("button", { name: /Review: We deploy from the main branch/ }),
  );
  return screen.findByRole("region", { name: "We deploy from the main branch" });
}

afterEach(cleanup);

describe("Site proposals queue", () => {
  it("shows counts per state and filters by state", async () => {
    const api = fakeApi([proposal(), proposal({ id: "p2", state: "approved", statement: "Old" })]);
    show(api);
    const counts = await screen.findByRole("list", { name: "Proposals by state" });
    expect(counts.textContent).toContain("Waiting for the Site: 2");
    expect(counts.textContent).toContain("Approved: 5");
    expect(api.list).toHaveBeenCalledWith({ state: "awaiting_site" });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "State" }), "approved");
    await waitFor(() =>
      expect(api.list).toHaveBeenLastCalledWith({ state: "approved", fromTeamId: undefined }),
    );
    expect(await screen.findByRole("button", { name: /Review: Old/ })).toBeTruthy();
  });

  it("filters by source Workspace", async () => {
    const api = fakeApi([proposal()]);
    show(api);
    await screen.findByRole("button", { name: /Review:/ });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Workspace" }), WS);
    await waitFor(() =>
      expect(api.list).toHaveBeenLastCalledWith({ state: "awaiting_site", fromTeamId: WS }),
    );
  });

  it("maps the camelized counts back to state names", () => {
    expect(countsFromWire({ awaitingSite: 2, changesRequested: 1, approved: 3 })).toEqual({
      awaiting_site: 2,
      changes_requested: 1,
      approved: 3,
    });
  });
});

describe("Site proposal detail", () => {
  it("shows the statement, kind, justification, Workspace, date, endorsement and round", async () => {
    const api = fakeApi([proposal()]);
    const region = await open(api);
    const about = within(region).getByRole("list", { name: "About this proposal" });
    expect(about.textContent).toContain("Fact");
    expect(about.textContent).toContain("From Platform");
    expect(about.textContent).toContain("Endorsed by a workspace curator");
    expect(about.textContent).toContain("Round 2 (changes requested 1 of 3 times)");
    expect(about.textContent).toContain("Proposed by Member One");
    expect(within(region).getByText(/Every workspace asks/)).toBeTruthy();
  });

  it("shows near-duplicates and Policy conflicts with diffs", async () => {
    const api = fakeApi([proposal()]);
    const region = await open(api);
    const dupes = within(region).getByRole("list", { name: "Similar Site memories" });
    expect(dupes.querySelector("ins")?.textContent).toContain("the");
    const policy = within(region).getByRole("list", { name: "Site Policy it may contradict" });
    expect(policy.querySelector("del")?.textContent).toContain("never");
  });

  it("opens the proposal the bell links to", async () => {
    const api = fakeApi([]);
    show(api, { focusId: "p9" });
    const heading = await screen.findByRole("heading", { name: "We deploy from the main branch" });
    expect(api.get).toHaveBeenCalledWith("p9");
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it("offers no decision on the curator's own proposal", async () => {
    const api = fakeApi([proposal()], detail({ proposer: { id: ME, name: "Me" } }));
    const region = await open(api);
    expect(within(region).getByText(/another Site curator decides it/)).toBeTruthy();
    expect(within(region).queryByRole("button", { name: "Approve" })).toBeNull();
  });
});

describe("Site proposal actions", () => {
  it("approves, and saves over a Policy conflict when asked", async () => {
    const api = fakeApi([proposal()]);
    api.approve.mockImplementationOnce(() =>
      refused(409, "memory_policy_conflict", "It may contradict Policy."),
    );
    const region = await open(api);
    await userEvent.click(within(region).getByRole("button", { name: "Approve" }));
    expect(api.approve).toHaveBeenCalledWith("p1", {}, {});
    api.list.mockImplementation(() => ok({ proposals: [], counts: { approved: 6 } }));
    await userEvent.click(await screen.findByRole("button", { name: "Save anyway" }));
    expect(api.approve).toHaveBeenLastCalledWith("p1", {}, { policyConflict: true });
    expect(await screen.findByText(/Approved: it is a Site memory now/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("button", { name: /Review:/ })).toBeNull());
  });

  it("approves as Policy for a Site admin", async () => {
    const api = fakeApi([proposal()]);
    show(api, { canSetPolicy: true });
    await userEvent.click(await screen.findByRole("button", { name: /Review:/ }));
    await userEvent.click(await screen.findByRole("checkbox", { name: /Make it Policy/ }));
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(api.approve).toHaveBeenCalledWith("p1", { policy: true }, {});
  });

  it("merges into a chosen Site memory with a diff", async () => {
    const api = fakeApi([proposal()]);
    const region = await open(api);
    await userEvent.click(within(region).getByRole("button", { name: "Merge into existing…" }));
    const target = await within(region).findByRole("combobox", { name: "Site memory" });
    await waitFor(() => expect(within(target).getAllByRole("option").length).toBeGreaterThan(2));
    await userEvent.selectOptions(target, "d1");
    const group = within(region).getByRole("group", { name: "Merge into existing" });
    expect(within(group).getByLabelText("Changes").querySelector("ins")).toBeTruthy();
    await userEvent.click(within(region).getByRole("button", { name: "Merge" }));
    expect(api.merge).toHaveBeenCalledWith("p1", { itemId: "d1", expectedVersion: 2 }, {});
    expect(await screen.findByText(/Merged: the Site memory has a new version/)).toBeTruthy();
  });

  it("needs a reason to reject", async () => {
    const api = fakeApi([proposal()]);
    const region = await open(api);
    await userEvent.click(within(region).getByRole("button", { name: "Reject…" }));
    await userEvent.click(within(region).getByRole("button", { name: "Reject proposal" }));
    expect((await within(region).findByRole("alert")).textContent).toMatch(/Give a reason/);
    expect(api.reject).not.toHaveBeenCalled();
    await userEvent.type(within(region).getByRole("textbox", { name: /Why/ }), "Duplicate");
    await userEvent.click(within(region).getByRole("button", { name: "Reject proposal" }));
    expect(api.reject).toHaveBeenCalledWith("p1", "Duplicate");
    expect(await screen.findByText(/Rejected. The workspace reads your reason/)).toBeTruthy();
  });

  it("requests changes with a note", async () => {
    const api = fakeApi([proposal()]);
    const region = await open(api);
    await userEvent.click(within(region).getByRole("button", { name: "Request changes…" }));
    const note = within(region).getByRole("textbox", { name: /What should change/ });
    expect(note.getAttribute("maxlength")).toBe("500");
    await userEvent.type(note, "Name the repository");
    await userEvent.click(within(region).getByRole("button", { name: "Send back for changes" }));
    expect(api.requestChanges).toHaveBeenCalledWith("p1", "Name the repository");
    expect(await screen.findByText(/Sent back to the workspace's Team admins/)).toBeTruthy();
  });

  it("turns off Request changes at round 3, saying why", async () => {
    const api = fakeApi([proposal({ rounds: 3 })], detail({ rounds: 3 }));
    const region = await open(api);
    const button = within(region).getByRole("button", { name: "Request changes…" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    const why = document.getElementById(button.getAttribute("aria-describedby") ?? "");
    expect(why?.textContent).toMatch(/3 rounds of changes/);
  });

  it("shows the switch-off and changed-state refusals", async () => {
    const api = fakeApi([proposal()]);
    api.approve.mockImplementationOnce(() => refused(403, "memory_disabled", "Off."));
    api.reject.mockImplementationOnce(() =>
      refused(409, "memory_item_inactive", "This Site proposal was already decided."),
    );
    const region = await open(api);
    await userEvent.click(within(region).getByRole("button", { name: "Approve" }));
    expect((await within(region).findByRole("alert")).textContent).toMatch(
      /turned off Members may propose to the Site/,
    );
    await userEvent.click(within(region).getByRole("button", { name: "Reject…" }));
    await userEvent.type(within(region).getByRole("textbox", { name: /Why/ }), "No");
    await userEvent.click(within(region).getByRole("button", { name: "Reject proposal" }));
    await waitFor(() =>
      expect(
        within(region)
          .getAllByRole("alert")
          .some((a) => /already decided\. Reload the queue/.test(a.textContent ?? "")),
      ).toBe(true),
    );
  });
});
