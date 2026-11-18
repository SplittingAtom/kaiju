// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProposalsApi } from "../../../lib/memory/proposals-api";
import type { Candidate, ReviewApi } from "../../../lib/memory/review-api";
import { ReviewSection } from "./review-section";

/** KOBE-397: Propose… on a To review card, for members who don't curate the Workspace. */
const THREAD = "00000000-0000-4000-8000-0000000000aa";

const cand: Candidate = {
  id: "c1",
  passId: "p1",
  statement: "We deploy from main",
  kind: "fact",
  destination: "team",
  scope: "team",
  allowedScopes: ["team", "user"],
  scopeLocked: false,
  saveAllMine: false,
  projectSpecific: false,
  source: "stated",
  operation: "add",
  target: null,
  confidence: 0.9,
  rationale: "You said so.",
  evidence: [{ entryId: "u1", quote: "we deploy from main" }],
  warnings: [],
  policyConflicts: [],
  nearDuplicates: [],
  expiresAt: new Date(Date.now() + 10 * 86_400_000).toISOString(),
};

const ok = <T,>(data: T) => Promise.resolve({ ok: true as const, status: 200, data });

function apis(canCurateWorkspace: boolean) {
  const review = {
    list: vi.fn(() =>
      ok({ threadId: THREAD, canCurateWorkspace, candidates: [cand], skillHints: [] }),
    ),
    save: vi.fn(),
    dismiss: vi.fn(),
    saveAll: vi.fn(),
    undo: vi.fn(),
    seen: vi.fn(),
  } as unknown as ReviewApi;
  const proposals = {
    propose: vi.fn(() => ok({ proposalId: "p9", candidateId: "c1", expiresAt: cand.expiresAt })),
  } satisfies Pick<ProposalsApi, "propose">;
  return { review, proposals };
}

afterEach(cleanup);

describe("Propose…", () => {
  it("sends the edited statement and a note to the curators, and the card leaves", async () => {
    const { review, proposals } = apis(false);
    render(<ReviewSection teamId="t1" threadId={THREAD} api={review} proposalsApi={proposals} />);
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const statement = screen.getByRole("textbox", { name: /Statement/ });
    await userEvent.clear(statement);
    await userEvent.type(statement, "We deploy from the main branch");
    await userEvent.click(screen.getByRole("button", { name: "Propose…" }));
    const note = screen.getByRole("textbox", { name: /Note for the curators/ });
    expect(document.activeElement).toBe(note);
    await userEvent.type(note, "Everyone asks.");
    await userEvent.click(screen.getByRole("button", { name: "Send to curators" }));
    expect(proposals.propose).toHaveBeenCalledWith("c1", {
      statement: "We deploy from the main branch",
      rationale: "Everyone asks.",
    });
    expect(await screen.findByText(/Proposed to the Workspace's curators/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("heading", { name: /We deploy/ })).toBeNull());
  });

  it("shows the server's refusal and keeps the card", async () => {
    const { review, proposals } = apis(false);
    proposals.propose.mockImplementationOnce(
      () =>
        Promise.resolve({
          ok: false as const,
          status: 403,
          error: { code: "memory_not_allowed", message: "Needs your own words." },
        }) as never,
    );
    render(<ReviewSection teamId="t1" threadId={THREAD} api={review} proposalsApi={proposals} />);
    await userEvent.click(await screen.findByRole("button", { name: "Propose…" }));
    await userEvent.click(screen.getByRole("button", { name: "Send to curators" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Needs your own words.");
    expect(screen.getByRole("heading", { name: "We deploy from main" })).toBeTruthy();
  });

  it("isn't offered to curators: they save to the Workspace directly (the Site stays)", async () => {
    const { review, proposals } = apis(true);
    render(<ReviewSection teamId="t1" threadId={THREAD} api={review} proposalsApi={proposals} />);
    await screen.findByRole("heading", { name: "We deploy from main" });
    // KOBE-404: Propose… stays for the Site only.
    await userEvent.click(screen.getByRole("button", { name: "Propose…" }));
    expect(screen.queryByRole("radio", { name: "This Workspace's curators" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send to curators" })).toBeNull();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});
