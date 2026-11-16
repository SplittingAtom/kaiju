// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectNotesApi, ProjectNotesStatus } from "../../../lib/memory/project-notes-api";
import type { Candidate, ReviewApi, ReviewList } from "../../../lib/memory/review-api";
import type { SuggestionsApi } from "../../../lib/memory/suggestions-api";
import { ReviewSection } from "./review-section";

/** KOBE-398: Add to project notes on a To review card (ac-1, ac-2, the client side). */
const THREAD = "00000000-0000-4000-8000-0000000000aa";
const PROJECT = "00000000-0000-4000-8000-0000000000cc";

const cand: Candidate = {
  id: "c1",
  passId: "p1",
  statement: "Deploys happen on Fridays",
  kind: "fact",
  destination: "project_notes",
  scope: "user",
  allowedScopes: ["user"],
  scopeLocked: false,
  saveAllMine: false,
  projectSpecific: true,
  source: "stated",
  operation: "add",
  target: null,
  confidence: 0.9,
  rationale: "You said so.",
  evidence: [{ entryId: "u1", quote: "deploys happen on Fridays" }],
  warnings: [],
  policyConflicts: [],
  nearDuplicates: [],
  expiresAt: new Date(Date.now() + 10 * 86_400_000).toISOString(),
};

const ok = <T,>(data: T) => Promise.resolve({ ok: true as const, status: 200, data });

function apis(projectNotes: ProjectNotesStatus | null) {
  const list: ReviewList = {
    threadId: THREAD,
    canCurateWorkspace: false,
    candidates: [cand],
    skillHints: [],
    projectNotes,
  };
  const review = {
    list: vi.fn(() => ok(list)),
    save: vi.fn(),
    dismiss: vi.fn(),
    saveAll: vi.fn(),
    undo: vi.fn(),
    seen: vi.fn(),
  } as unknown as ReviewApi;
  const preview = {
    candidateId: "c1",
    projectId: PROJECT,
    path: "MEMORY.md",
    section: "Learned",
    baseVersion: 2,
    line: "- Deploys happen on Fridays",
    approval: "signed",
  };
  const notes = {
    preview: vi.fn(() => ok(preview)),
    add: vi.fn(() =>
      ok({
        candidateId: "c1",
        projectId: PROJECT,
        memoryDocId: "d1",
        version: 3,
        line: preview.line,
      }),
    ),
  } satisfies ProjectNotesApi;
  const suggestions = {
    suggest: vi.fn(() =>
      ok({
        suggestionId: "s1",
        candidateId: "c1",
        projectId: PROJECT,
        expiresAt: new Date().toISOString(),
      }),
    ),
    list: vi.fn(),
    preview: vi.fn(),
    approve: vi.fn(),
    dismiss: vi.fn(),
  } as unknown as SuggestionsApi & { suggest: ReturnType<typeof vi.fn> };
  return { review, notes, preview, suggestions };
}

const show = (a: ReturnType<typeof apis>) =>
  render(
    <ReviewSection
      teamId="t1"
      threadId={THREAD}
      api={a.review}
      notesApi={a.notes}
      suggestionsApi={a.suggestions}
    />,
  );
const editor: ProjectNotesStatus = {
  projectId: PROJECT,
  access: "write",
  available: true,
  reason: null,
};

afterEach(cleanup);

describe("Add to project notes", () => {
  it("previews the signed change, asks for approval, adds and takes the card away", async () => {
    const a = apis(editor);
    show(a);
    await userEvent.click(await screen.findByRole("button", { name: "Add to project notes" }));
    expect(a.notes.preview).toHaveBeenCalledWith("c1", undefined);
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("- Deploys happen on Fridays")).toBeTruthy();
    expect(within(dialog).getByText("MEMORY.md")).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Approve and add" }));
    await waitFor(() => expect(a.notes.add).toHaveBeenCalledWith("c1", a.preview, undefined));
    expect(await screen.findByText(/Added to the project's notes/)).toBeTruthy();
    expect(screen.queryByText("Deploys happen on Fridays")).toBeNull();
  });

  it("sends the edited statement, and adds nothing when the approval is cancelled", async () => {
    const a = apis(editor);
    show(a);
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const field = screen.getByRole("textbox", { name: "Statement" });
    await userEvent.clear(field);
    await userEvent.type(field, "Deploys happen on Mondays");
    await userEvent.click(screen.getByRole("button", { name: "Add to project notes" }));
    expect(a.notes.preview).toHaveBeenCalledWith("c1", "Deploys happen on Mondays");
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(a.notes.add).not.toHaveBeenCalled();
  });

  it("shows the preview's warnings in the approval dialog", async () => {
    const a = apis(editor);
    a.notes.preview.mockImplementation(() =>
      ok({ ...a.preview, warnings: [{ code: "personal_email", message: "Looks like an email." }] }),
    );
    show(a);
    await userEvent.click(await screen.findByRole("button", { name: "Add to project notes" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Looks like an email.")).toBeTruthy();
  });

  it("shows the server's refusal at click", async () => {
    const a = apis(editor);
    a.notes.preview.mockReturnValueOnce(
      Promise.resolve({
        ok: false as const,
        status: 403,
        error: { code: "memory_not_allowed", message: "Only the project's editors…" },
      }) as never,
    );
    show(a);
    await userEvent.click(await screen.findByRole("button", { name: "Add to project notes" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Only the project's editors");
  });

  it("is disabled with the reason when it can't be used now", async () => {
    show(apis({ ...editor, available: false, reason: "Project memory is turned off." }));
    const button = await screen.findByRole("button", { name: "Add to project notes" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByText("Project memory is turned off.")).toBeTruthy();
  });

  it("is absent outside a project thread", async () => {
    show(apis(null));
    await screen.findByRole("button", { name: "Save" });
    expect(screen.queryByRole("button", { name: /project notes|Suggest/ })).toBeNull();
  });
});

/** KOBE-652: a project reader's Suggest to editors on the same card. */
describe("Suggest to editors", () => {
  const reader: ProjectNotesStatus = {
    projectId: PROJECT,
    access: "read",
    available: true,
    reason: null,
  };

  it("readers suggest the edited statement and kind after confirming; never Add", async () => {
    const a = apis(reader);
    show(a);
    await screen.findByRole("button", { name: "Suggest to editors" });
    expect(screen.queryByRole("button", { name: "Add to project notes" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const field = screen.getByRole("textbox", { name: "Statement" });
    await userEvent.clear(field);
    await userEvent.type(field, "Deploys happen on Mondays");
    await userEvent.click(screen.getByRole("button", { name: "Suggest to editors" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/quotes from your own messages/)).toBeTruthy();
    expect(within(dialog).getByText("Deploys happen on Mondays")).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Suggest" }));
    await waitFor(() =>
      expect(a.suggestions.suggest).toHaveBeenCalledWith("c1", {
        statement: "Deploys happen on Mondays",
      }),
    );
    expect(await screen.findByText(/Suggested to the project's editors/)).toBeTruthy();
    expect(a.notes.preview).not.toHaveBeenCalled();
  });

  it("suggests nothing when cancelled, and shows the server's refusal", async () => {
    const a = apis(reader);
    show(a);
    await userEvent.click(await screen.findByRole("button", { name: "Suggest to editors" }));
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }),
    );
    expect(a.suggestions.suggest).not.toHaveBeenCalled();
    a.suggestions.suggest.mockReturnValueOnce(
      Promise.resolve({
        ok: false as const,
        status: 403,
        error: { code: "memory_not_allowed", message: "A suggestion needs your own words." },
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Suggest to editors" }));
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Suggest" }),
    );
    expect((await screen.findByRole("alert")).textContent).toContain("needs your own words");
  });

  it("is disabled with the reason while project memory is off", async () => {
    show(apis({ ...reader, available: false, reason: "Project memory is turned off." }));
    const button = await screen.findByRole("button", { name: "Suggest to editors" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Project memory is turned off.")).toBeTruthy();
  });
});
