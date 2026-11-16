// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MyProposal, ProposalsApi, QueuedProposal } from "../../../lib/memory/proposals-api";
import { MyProposals } from "./my-proposals";
import { ProposalQueue } from "./proposal-queue";

/** KOBE-397: the curators' Proposals tab and a member's own proposals (the client side). */
const ME = "00000000-0000-4000-8000-000000000001";
const MEMBER = "00000000-0000-4000-8000-000000000002";
const THREAD = "00000000-0000-4000-8000-0000000000aa";
const ok = <T,>(data: T) => Promise.resolve({ ok: true as const, status: 200, data });

const queued = (over: Partial<QueuedProposal> = {}): QueuedProposal => ({
  id: "p1",
  statement: "We deploy from main",
  kind: "fact",
  rationale: "Everyone asks.",
  state: "pending",
  proposer: { id: MEMBER, name: "Member One" },
  threadId: THREAD,
  evidence: [{ entryId: "u1", quote: "we deploy from main" }],
  reason: null,
  decidedAt: null,
  expiresAt: new Date(Date.now() + 20 * 86_400_000).toISOString(),
  createdAt: "2026-11-15T00:00:00Z",
  warnings: [],
  nearDuplicates: [],
  policyConflicts: [],
  ...over,
});

function queueApi(list: QueuedProposal[]) {
  return {
    queue: vi.fn(() => ok({ proposals: list })),
    approve: vi.fn((id: string) => ok({ proposalId: id, item: {} as never })),
    turnDown: vi.fn((id: string) => ok({ proposalId: id, backInReview: true })),
  } satisfies Pick<ProposalsApi, "queue" | "approve" | "turnDown">;
}

afterEach(cleanup);

describe("Proposals (curators)", () => {
  it("shows the proposal, its proposer, note, quotes and conversation, and approves it", async () => {
    const api = queueApi([queued()]);
    render(<ProposalQueue teamId="t1" userId={ME} api={api} />);
    expect(await screen.findByRole("heading", { name: "We deploy from main" })).toBeTruthy();
    expect(screen.getByText("Proposed by Member One")).toBeTruthy();
    expect(screen.getByText("Everyone asks.")).toBeTruthy();
    expect(screen.getByRole("list", { name: "Quotes" }).textContent).toContain(
      "we deploy from main",
    );
    expect(screen.getByRole("link", { name: "Open the conversation" }).getAttribute("href")).toBe(
      `/?thread=${THREAD}`,
    );
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(api.approve).toHaveBeenCalledWith("p1", {}, {});
    expect(await screen.findByText(/reaches every member's next run/)).toBeTruthy();
    expect(screen.getByText("No proposals waiting")).toBeTruthy();
  });

  it("edits and approves", async () => {
    const api = queueApi([queued()]);
    render(<ProposalQueue teamId="t1" userId={ME} api={api} />);
    await userEvent.click(await screen.findByRole("button", { name: "Edit and approve…" }));
    const statement = screen.getByRole("textbox", { name: /Statement/ });
    await userEvent.clear(statement);
    await userEvent.type(statement, "We deploy from the main branch");
    await userEvent.click(screen.getByRole("button", { name: "Approve edited" }));
    expect(api.approve).toHaveBeenCalledWith(
      "p1",
      { statement: "We deploy from the main branch" },
      {},
    );
  });

  it("needs a reason to send back or dismiss", async () => {
    const api = queueApi([queued()]);
    render(<ProposalQueue teamId="t1" userId={ME} api={api} />);
    await userEvent.click(await screen.findByRole("button", { name: "Request changes…" }));
    await userEvent.click(screen.getByRole("button", { name: "Send back for changes" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Give a reason/);
    expect(api.turnDown).not.toHaveBeenCalled();
    await userEvent.type(
      screen.getByRole("textbox", { name: /What should change/ }),
      "Which repo?",
    );
    await userEvent.click(screen.getByRole("button", { name: "Send back for changes" }));
    expect(api.turnDown).toHaveBeenCalledWith("p1", "request-changes", "Which repo?");
    expect(await screen.findByText(/Sent back for changes/)).toBeTruthy();
  });

  it("offers no decision on the curator's own proposal and shows Policy conflicts", async () => {
    const api = queueApi([
      queued({
        proposer: { id: ME, name: "Me" },
        policyConflicts: [{ id: "x", version: 1, statement: "Never deploy on Fridays" }],
      }),
    ]);
    render(<ProposalQueue teamId="t1" userId={ME} api={api} />);
    expect(await screen.findByText(/another curator decides it/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.getByText("Never deploy on Fridays")).toBeTruthy();
  });

  it("focuses the proposal the bell links to", async () => {
    render(
      <ProposalQueue
        teamId="t1"
        userId={ME}
        focusId="p2"
        api={queueApi([queued(), queued({ id: "p2", statement: "Second" })])}
      />,
    );
    const second = await screen.findByRole("heading", { name: "Second" });
    await waitFor(() => expect(document.activeElement).toBe(second));
  });
});

const mine = (over: Partial<MyProposal> = {}): MyProposal => ({
  ...queued(),
  backInReview: false,
  mayRepropose: false,
  ...over,
});

describe("Your Workspace proposals", () => {
  it("shows outcomes and reasons, links back to To review, and proposes an expired one again", async () => {
    const api = {
      mine: vi.fn(() =>
        ok({
          proposals: [
            mine({
              id: "a",
              state: "rejected",
              reason: "Which repo?",
              backInReview: true,
              statement: "Sent back",
            }),
            mine({ id: "b", state: "expired", mayRepropose: true, statement: "Lapsed" }),
          ],
        }),
      ),
      repropose: vi.fn(() => ok({ proposalId: "c", candidateId: "x", expiresAt: "" })),
    } satisfies Pick<ProposalsApi, "mine" | "repropose">;
    render(<MyProposals teamId="t1" api={api} />);
    expect(await screen.findByText("Sent back for changes")).toBeTruthy();
    expect(screen.getByText("Which repo?")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open To review" }).getAttribute("href")).toBe(
      `/me/memory?review=1&thread=${THREAD}`,
    );
    expect(screen.getByText("Expired")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Propose again" }));
    expect(api.repropose).toHaveBeenCalledWith("b");
    expect(await screen.findByText(/Proposed again/)).toBeTruthy();
  });

  it("is hidden when there are none", async () => {
    const api = {
      mine: vi.fn(() => ok({ proposals: [] })),
      repropose: vi.fn(),
    } as unknown as Pick<ProposalsApi, "mine" | "repropose">;
    const { container } = render(<MyProposals teamId="t1" api={api} />);
    await waitFor(() => expect(api.mine).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });
});
