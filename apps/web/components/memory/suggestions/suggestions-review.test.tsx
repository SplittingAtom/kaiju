// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Suggestion,
  SuggestionList,
  SuggestionsApi,
} from "../../../lib/memory/suggestions-api";
import { SuggestionsReview } from "./suggestions-review";

/** KOBE-652: editors decide readers' suggestions (project Memory → Suggestions, To review). */
const PROJECT = "00000000-0000-4000-8000-0000000000cc";

const sug: Suggestion = {
  id: "00000000-0000-4000-8000-000000000001",
  projectId: PROJECT,
  projectName: "Atlas",
  threadId: "00000000-0000-4000-8000-0000000000aa",
  statement: "Deploys happen on Fridays",
  kind: "fact",
  evidence: [{ entryId: "u1", quote: "we deploy on Fridays" }],
  suggestedBy: { id: "r1", name: "Riley Reader" },
  state: "pending",
  reason: null,
  createdAt: "2026-11-16T10:00:00.000Z",
  expiresAt: "2026-12-16T10:00:00.000Z",
  decidedAt: null,
};

const ok = <T,>(data: T) => Promise.resolve({ ok: true as const, status: 200, data });

function apiWith(list: SuggestionList) {
  const preview = {
    suggestionId: sug.id,
    projectId: PROJECT,
    path: "MEMORY.md",
    section: "Learned",
    baseVersion: 4,
    line: "- Deploys happen on Fridays",
    approval: "signed",
  };
  return {
    preview,
    api: {
      suggest: vi.fn(),
      list: vi.fn(() => ok(list)),
      preview: vi.fn(() => ok(preview)),
      approve: vi.fn(() =>
        ok({ suggestionId: sug.id, projectId: PROJECT, version: 5, line: preview.line }),
      ),
      dismiss: vi.fn(() => ok({ suggestionId: sug.id, state: "dismissed" as const })),
    } satisfies SuggestionsApi,
  };
}

const decider: SuggestionList = {
  projectId: PROJECT,
  canDecide: true,
  suggestions: [sug],
  mine: [],
};

afterEach(cleanup);

describe("project Memory → Suggestions", () => {
  it("shows the statement, who suggested it and their words; Approve adds after the dialog", async () => {
    const a = apiWith(decider);
    render(<SuggestionsReview teamId="t1" projectId={PROJECT} api={a.api} />);
    expect(await screen.findByText("Deploys happen on Fridays")).toBeTruthy();
    expect(screen.getByText(/suggested by Riley Reader/)).toBeTruthy();
    expect(screen.getByText(/we deploy on Fridays/)).toBeTruthy();
    expect(a.api.list).toHaveBeenCalledWith(PROJECT);
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("- Deploys happen on Fridays")).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Approve and add" }));
    await waitFor(() => expect(a.api.approve).toHaveBeenCalledWith(sug.id, a.preview));
    expect(await screen.findByText(/Added to Atlas's notes/)).toBeTruthy();
    expect(screen.queryByText("Deploys happen on Fridays")).toBeNull();
  });

  it("dismisses with an optional reason", async () => {
    const a = apiWith(decider);
    render(<SuggestionsReview teamId="t1" projectId={PROJECT} api={a.api} />);
    await userEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    await userEvent.type(screen.getByRole("textbox", { name: /Reason/ }), "Already in the README");
    await userEvent.click(screen.getByRole("button", { name: "Dismiss suggestion" }));
    await waitFor(() =>
      expect(a.api.dismiss).toHaveBeenCalledWith(sug.id, "Already in the README"),
    );
    expect(await screen.findByText(/Suggestion dismissed/)).toBeTruthy();
  });

  it("shows the server's refusal and keeps the card", async () => {
    const a = apiWith(decider);
    a.api.preview.mockReturnValueOnce(
      Promise.resolve({
        ok: false as const,
        status: 403,
        error: { code: "memory_not_allowed", message: "Only the project's editors decide." },
      }) as never,
    );
    render(<SuggestionsReview teamId="t1" projectId={PROJECT} api={a.api} />);
    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect((await screen.findByRole("alert")).textContent).toContain("editors decide");
    expect(screen.getByText("Deploys happen on Fridays")).toBeTruthy();
  });

  it("readers see no queue and no Approve, only their own suggestions with the reason", async () => {
    const a = apiWith({
      projectId: PROJECT,
      canDecide: false,
      suggestions: [],
      mine: [{ ...sug, state: "dismissed", reason: "Covered elsewhere" }],
    });
    render(<SuggestionsReview teamId="t1" projectId={PROJECT} api={a.api} />);
    expect(await screen.findByText("Dismissed")).toBeTruthy();
    expect(screen.getByText(/Covered elsewhere/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.getByText(/editors, owners and Team admins decide/)).toBeTruthy();
  });

  it("focuses the suggestion the bell named", async () => {
    const a = apiWith(decider);
    render(<SuggestionsReview teamId="t1" projectId={PROJECT} focusId={sug.id} api={a.api} />);
    await screen.findByText("Deploys happen on Fridays");
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("data-suggestion")).toBe(sug.id),
    );
  });
});

describe("To review", () => {
  it("lists every project's waiting suggestions with the project, and hides when none", async () => {
    const a = apiWith({ ...decider, projectId: null });
    render(<SuggestionsReview teamId="t1" api={a.api} />);
    expect(await screen.findByText(/Suggested for project notes \(1\)/)).toBeTruthy();
    expect(screen.getByText(/for Atlas/)).toBeTruthy();
    expect(a.api.list).toHaveBeenCalledWith(undefined);
    cleanup();
    const none = apiWith({ projectId: null, canDecide: false, suggestions: [], mine: [] });
    const { container } = render(<SuggestionsReview teamId="t1" api={none.api} />);
    await waitFor(() => expect(none.api.list).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });
});
