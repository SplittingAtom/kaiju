// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProposalsApi } from "../../../lib/memory/proposals-api";
import type { Candidate, ReviewApi } from "../../../lib/memory/review-api";
import type { SiteProposalsApi } from "../../../lib/memory/site-proposals-api";
import { ReviewSection } from "./review-section";

/** KOBE-404: Propose… → Site on a To review card (stated or confirmed only, with a justification). */
const THREAD = "00000000-0000-4000-8000-0000000000aa";

const base: Candidate = {
  id: "c1",
  passId: "p1",
  statement: "Expense reports are due on the 5th",
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
  evidence: [{ entryId: "u1", quote: "expense reports are due on the 5th" }],
  warnings: [],
  policyConflicts: [],
  nearDuplicates: [],
  expiresAt: new Date(Date.now() + 10 * 86_400_000).toISOString(),
};

const ok = <T,>(data: T) => Promise.resolve({ ok: true as const, status: 201, data });

const proposal = {
  id: "sp1",
  statement: base.statement,
  kind: "fact" as const,
  justification: "Every workspace files expenses.",
  endorsed: false,
  state: "awaiting_team" as const,
  rounds: 0,
  proposer: { id: "u1", name: "Ada" },
  confirmedBy: null,
  confirmedAt: null,
  reason: null,
  changesNote: null,
  decidedAt: null,
  mergedInto: null,
  expiresAt: base.expiresAt,
  createdAt: base.expiresAt,
  updatedAt: base.expiresAt,
  may: { confirm: false, endorse: false, withdraw: true },
};

function apis(candidate: Candidate, canCurateWorkspace = false) {
  const review = {
    list: vi.fn(() =>
      ok({ threadId: THREAD, canCurateWorkspace, candidates: [candidate], skillHints: [] }),
    ),
    save: vi.fn(),
    dismiss: vi.fn(),
    saveAll: vi.fn(),
    undo: vi.fn(),
    seen: vi.fn(),
  } as unknown as ReviewApi;
  const proposals = { propose: vi.fn() } as unknown as Pick<ProposalsApi, "propose">;
  const site = {
    proposeCandidate: vi.fn(() =>
      ok({ proposal, checks: { warnings: [], policyConflicts: [{ id: "x", version: 1 }] } }),
    ),
  } satisfies Pick<SiteProposalsApi, "proposeCandidate">;
  return { review, proposals, site };
}

function show(a: ReturnType<typeof apis>) {
  render(
    <ReviewSection
      teamId="t1"
      threadId={THREAD}
      api={a.review}
      proposalsApi={a.proposals}
      siteProposalsApi={a.site}
    />,
  );
}

afterEach(cleanup);

describe("Propose… → Site", () => {
  it("sends the statement with a required justification; the card leaves with a notice", async () => {
    const a = apis(base);
    show(a);
    await userEvent.click(await screen.findByRole("button", { name: "Propose…" }));
    await userEvent.click(screen.getByRole("radio", { name: "The Site (every workspace)" }));
    const why = screen.getByRole("textbox", { name: /Why every workspace should know this/ });
    expect(why.getAttribute("maxlength")).toBe("1000");
    expect(why.hasAttribute("required")).toBe(true);
    // Required: nothing is sent without it.
    await userEvent.click(screen.getByRole("button", { name: "Propose to the Site" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Say why every workspace/);
    expect(a.site.proposeCandidate).not.toHaveBeenCalled();
    await userEvent.type(why, "Every workspace files expenses.");
    await userEvent.click(screen.getByRole("button", { name: "Propose to the Site" }));
    expect(a.site.proposeCandidate).toHaveBeenCalledWith("c1", {
      justification: "Every workspace files expenses.",
    });
    const notice = await screen.findByText(/Proposed to the Site/);
    expect(notice.textContent).toMatch(/Team admin confirms/);
    expect(notice.textContent).toMatch(/Site Policy/);
    await waitFor(() => expect(screen.queryByRole("heading", { name: /Expense/ })).toBeNull());
  });

  it("is offered to curators too, for the Site only", async () => {
    const a = apis(base, true);
    show(a);
    await userEvent.click(await screen.findByRole("button", { name: "Propose…" }));
    expect(screen.queryByRole("radio", { name: /Workspace's curators/ })).toBeNull();
    // The only target: the form opens on it.
    expect(document.activeElement).toBe(
      screen.getByRole("textbox", { name: /Why every workspace/ }),
    );
  });

  it("is disabled for inferred candidates, with the reason (ac-3)", async () => {
    const a = apis({
      ...base,
      source: "inferred",
      scope: "user",
      allowedScopes: ["user"],
      scopeLocked: true,
    });
    show(a);
    await userEvent.click(await screen.findByRole("button", { name: "Propose…" }));
    const site = screen.getByRole("radio", { name: "The Site (every workspace)" });
    expect((site as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/only what you said or confirmed goes to the Site/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Propose to the Site" })).toBeNull();
    expect(a.site.proposeCandidate).not.toHaveBeenCalled();
  });

  it("shows the server's refusal (switch off) and keeps the card", async () => {
    const a = apis(base);
    a.site.proposeCandidate.mockImplementationOnce(
      () =>
        Promise.resolve({
          ok: false as const,
          status: 403,
          error: {
            status: 403,
            code: "memory_disabled",
            message: "This workspace doesn't propose memories to the Site.",
          },
        }) as never,
    );
    show(a);
    await userEvent.click(await screen.findByRole("button", { name: "Propose…" }));
    await userEvent.click(screen.getByRole("radio", { name: "The Site (every workspace)" }));
    await userEvent.type(screen.getByRole("textbox", { name: /Why every workspace/ }), "Because.");
    await userEvent.click(screen.getByRole("button", { name: "Propose to the Site" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/doesn't propose memories/);
    expect(screen.getByRole("heading", { name: base.statement })).toBeTruthy();
  });
});
