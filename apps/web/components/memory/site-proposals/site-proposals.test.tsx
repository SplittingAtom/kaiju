// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryItem } from "../../../lib/memory/items-api";
import type { SiteProposal, SiteProposalsApi } from "../../../lib/memory/site-proposals-api";
import { answerConfirm, forbidNativeConfirm } from "../../admin/testing";
import { MySiteProposals } from "./my-site-proposals";
import { ProposeItemToSite } from "./propose-item";
import { WorkspaceSiteQueue } from "./site-queue";

/** KOBE-404: the Workspace's Site proposals (confirmation queue) and Propose to Site on an item. */
const ok = <T,>(data: T) => Promise.resolve({ ok: true as const, status: 200, data });
const refuse = (status: number, code: string, message: string) =>
  Promise.resolve({ ok: false as const, status, error: { status, code, message } }) as never;
const NO_CHECKS = { warnings: [], policyConflicts: [] };

const sp = (over: Partial<SiteProposal> = {}): SiteProposal => ({
  id: "sp1",
  statement: "Expense reports are due on the 5th",
  kind: "fact",
  justification: "Every workspace files expenses.",
  endorsed: false,
  state: "awaiting_team",
  rounds: 0,
  proposer: { id: "u-2", name: "Member One" },
  confirmedBy: null,
  confirmedAt: null,
  reason: null,
  changesNote: null,
  decidedAt: null,
  mergedInto: null,
  expiresAt: new Date(Date.now() + 20 * 86_400_000).toISOString(),
  createdAt: "2026-11-15T00:00:00Z",
  updatedAt: "2026-11-15T00:00:00Z",
  may: { confirm: true, endorse: true, withdraw: true },
  ...over,
});

function fakeApi(list: SiteProposal[]) {
  return {
    list: vi.fn(() => ok({ proposals: list, counts: {} })),
    confirm: vi.fn((id: string) =>
      ok({
        proposal: sp({
          id,
          state: "awaiting_site",
          confirmedBy: { id: "u-me", name: "Ada" },
          may: { confirm: false, endorse: false, withdraw: true },
        }),
        checks: { warnings: [], policyConflicts: [{ id: "pol", version: 2 }] },
      }),
    ),
    endorse: vi.fn((id: string) =>
      ok({
        proposal: sp({
          id,
          endorsed: true,
          may: { confirm: false, endorse: false, withdraw: false },
        }),
      }),
    ),
    withdraw: vi.fn((id: string) =>
      ok({
        proposal: sp({
          id,
          state: "withdrawn",
          may: { confirm: false, endorse: false, withdraw: false },
        }),
      }),
    ),
    proposeItem: vi.fn(() => ok({ proposal: sp({ id: "sp9" }), checks: NO_CHECKS })),
  } satisfies Omit<SiteProposalsApi, "proposeCandidate">;
}

beforeEach(forbidNativeConfirm);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Confirmation queue (Team admins, ac-1)", () => {
  it("shows statement, kind, justification, proposer, endorsement and the Site's note", async () => {
    const api = fakeApi([
      sp({ endorsed: true, rounds: 1, changesNote: "Say which day of the month." }),
    ]);
    render(<WorkspaceSiteQueue teamId="t1" api={api} />);
    const card = await screen.findByRole("article", { name: /Expense reports/ });
    const c = within(card);
    expect(c.getByText("Fact")).toBeTruthy();
    expect(c.getByText("Proposed by Member One")).toBeTruthy();
    expect(c.getByText("Endorsed by a curator")).toBeTruthy();
    expect(c.getByText("Round 2")).toBeTruthy();
    expect(c.getByText("Every workspace files expenses.")).toBeTruthy();
    expect(c.getByText(/Say which day of the month\./)).toBeTruthy();
    expect(api.list).toHaveBeenCalledWith();
  });

  it("confirms with an edit, and the proposal moves on to the Site", async () => {
    const api = fakeApi([sp()]);
    render(<WorkspaceSiteQueue teamId="t1" api={api} />);
    await userEvent.click(await screen.findByRole("button", { name: "Edit and confirm…" }));
    const statement = screen.getByRole("textbox", { name: /^Statement/ });
    expect(document.activeElement).toBe(statement);
    await userEvent.clear(statement);
    await userEvent.type(statement, "Expense reports are due on the 5th of each month");
    const why = screen.getByRole("textbox", { name: /^Justification/ });
    expect(why.getAttribute("maxlength")).toBe("1000");
    await userEvent.click(screen.getByRole("button", { name: "Confirm edited" }));
    expect(api.confirm).toHaveBeenCalledWith("sp1", {
      statement: "Expense reports are due on the 5th of each month",
    });
    const done = await screen.findByText(/Confirmed: it waits for the Site/);
    expect(done.textContent).toMatch(/Site Policy/);
    const waiting = screen.getByRole("region", { name: /Waiting for the Site/ });
    expect(within(waiting).getByText("Confirmed by Ada")).toBeTruthy();
  });

  it("refuses an empty justification before sending", async () => {
    const api = fakeApi([sp()]);
    render(<WorkspaceSiteQueue teamId="t1" api={api} />);
    await userEvent.click(await screen.findByRole("button", { name: "Edit and confirm…" }));
    await userEvent.clear(screen.getByRole("textbox", { name: /^Justification/ }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm edited" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Say why every workspace/);
    expect(api.confirm).not.toHaveBeenCalled();
  });

  it("withdraws after asking", async () => {
    const api = fakeApi([sp()]);
    render(<WorkspaceSiteQueue teamId="t1" api={api} />);
    await userEvent.click(await screen.findByRole("button", { name: "Withdraw…" }));
    await answerConfirm(/Withdraw this Site proposal/, "Withdraw");
    expect(api.withdraw).toHaveBeenCalledWith("sp1");
    expect(await screen.findByText(/Withdrawn\. It won't reach the Site/)).toBeTruthy();
    const closed = screen.getByRole("region", { name: /Closed/ });
    expect(within(closed).getByText("Withdrawn")).toBeTruthy();
  });

  it("shows the server's 409 and switch-off refusals in the card", async () => {
    const api = fakeApi([sp()]);
    api.confirm.mockImplementationOnce(() =>
      refuse(409, "memory_item_inactive", "This Site proposal expired: proposals wait 30 days."),
    );
    api.confirm.mockImplementationOnce(() =>
      refuse(403, "memory_disabled", "This workspace doesn't propose memories to the Site."),
    );
    render(<WorkspaceSiteQueue teamId="t1" api={api} />);
    await userEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/expired/);
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/doesn't propose memories/);
  });
});

describe("Stewards (ac-2)", () => {
  it("endorse but see no Confirm", async () => {
    const api = fakeApi([sp({ may: { confirm: false, endorse: true, withdraw: false } })]);
    render(<WorkspaceSiteQueue teamId="t1" api={api} />);
    await screen.findByRole("article", { name: /Expense reports/ });
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit and confirm…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Withdraw…" })).toBeNull();
    expect(screen.getByText(/A Team admin confirms it/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Endorse" }));
    expect(api.endorse).toHaveBeenCalledWith("sp1");
    expect(await screen.findByText("Endorsed by a curator")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Endorse" })).toBeNull();
  });
});

describe("Propose to Site on a Workspace memory (curators)", () => {
  const item = {
    id: "i1",
    scope: "team",
    statement: "Invoices are approved by the finance lead.",
  } as unknown as MemoryItem;

  it("needs a justification and sends it with the item", async () => {
    const api = fakeApi([]);
    render(<ProposeItemToSite item={item} api={api} />);
    await userEvent.click(screen.getByRole("button", { name: /^Propose to Site:/ }));
    const why = screen.getByRole("textbox", { name: /Why every workspace should know this/ });
    expect(document.activeElement).toBe(why);
    await userEvent.click(screen.getByRole("button", { name: "Propose to the Site" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Say why/);
    await userEvent.type(why, "All workspaces pay invoices.");
    await userEvent.click(screen.getByRole("button", { name: "Propose to the Site" }));
    expect(api.proposeItem).toHaveBeenCalledWith("i1", {
      justification: "All workspaces pay invoices.",
    });
    expect(await screen.findByText(/Proposed to the Site/)).toBeTruthy();
  });

  it("shows a refusal", async () => {
    const api = fakeApi([]);
    api.proposeItem.mockImplementationOnce(() =>
      refuse(403, "memory_disabled", "This workspace doesn't propose memories to the Site."),
    );
    render(<ProposeItemToSite item={item} api={api} />);
    await userEvent.click(screen.getByRole("button", { name: /^Propose to Site:/ }));
    await userEvent.type(screen.getByRole("textbox", { name: /Why every/ }), "Because.");
    await userEvent.click(screen.getByRole("button", { name: "Propose to the Site" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/doesn't propose/);
  });
});

describe("Lists hold at most 100 (no cursor)", () => {
  it("says when a group shows fewer than there are", async () => {
    const api = fakeApi([sp()]);
    api.list.mockImplementation(() =>
      ok({ proposals: [sp()], counts: { awaiting_team: 1, rejected: 140 } }),
    );
    render(<WorkspaceSiteQueue teamId="t1" api={api} />);
    expect(await screen.findByText(/Showing 0 of 140 closed proposals/)).toBeTruthy();
    expect(screen.queryByText(/proposals waiting for a Team admin \(at most/)).toBeNull();
    // Open ones are read separately, so a long closed list never hides them.
    expect(api.list).toHaveBeenCalledWith("awaiting_team");
    expect(api.list).toHaveBeenCalledWith("awaiting_site");
  });
});

describe("Your Site proposals (My memory)", () => {
  it("lists only your own, with the Site's note, and focuses the bell's one", async () => {
    const api = fakeApi([
      sp({
        id: "00000000-0000-4000-8000-0000000000b1",
        proposer: { id: "u-me", name: "Ada" },
        changesNote: "Name the month.",
        rounds: 1,
        may: { confirm: false, endorse: false, withdraw: true },
      }),
      sp({ id: "sp-other", statement: "Someone else's" }),
    ]);
    render(
      <MySiteProposals
        teamId="t1"
        userId="u-me"
        focusId="00000000-0000-4000-8000-0000000000b1"
        api={api}
      />,
    );
    expect(await screen.findByRole("region", { name: "Your Site proposals" })).toBeTruthy();
    expect(screen.getByText(/Name the month\./)).toBeTruthy();
    expect(screen.queryByText("Someone else's")).toBeNull();
    expect(document.activeElement?.getAttribute("data-my-site-proposal")).toBe(
      "00000000-0000-4000-8000-0000000000b1",
    );
    expect(screen.getByRole("button", { name: "Withdraw…" })).toBeTruthy();
  });

  it("stays hidden when you have none", async () => {
    const api = fakeApi([sp()]);
    const { container } = render(<MySiteProposals teamId="t1" userId="u-me" api={api} />);
    await Promise.resolve();
    expect(container.textContent).toBe("");
  });
});
