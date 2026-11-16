// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REVEAL_REQUEST_EVENT, type RevealRequest } from "../../../lib/chat/reveal-request";
import type { Candidate, ReviewApi, ReviewList } from "../../../lib/memory/review-api";
import { must } from "../../../lib/testing/must";
import { ReviewSection } from "./review-section";

/** KOBE-396: the To review section and its cards (ac-2, the client side). */
const THREAD = "00000000-0000-4000-8000-0000000000aa";
const ITEM = "00000000-0000-4000-8000-0000000000bb";

const cand = (over: Partial<Candidate> = {}): Candidate => ({
  id: "c1",
  passId: "p1",
  statement: "We ship on Tuesdays",
  kind: "fact",
  destination: "user",
  scope: "user",
  allowedScopes: ["user", "team"],
  scopeLocked: false,
  saveAllMine: true,
  projectSpecific: false,
  source: "stated",
  operation: "add",
  target: null,
  confidence: 0.9,
  rationale: "You said it twice.",
  evidence: [{ entryId: "u1", quote: "we ship on Tuesdays" }],
  warnings: [],
  policyConflicts: [],
  nearDuplicates: [],
  expiresAt: new Date(Date.now() + 13.5 * 86_400_000).toISOString(),
  ...over,
});

const savedItem = (id: string) => ({
  candidateId: id,
  item: {
    id: ITEM,
    scope: "user" as const,
    kind: "fact" as const,
    status: "active" as const,
    statement: "x",
    tags: [],
    pinned: false,
    policy: false,
    asOf: null,
    version: 1,
    updatedAt: "2026-11-15T00:00:00Z",
  },
});

function fakeApi(candidates: Candidate[], extra: Partial<ReviewList> = {}) {
  const list: ReviewList = {
    threadId: THREAD,
    canCurateWorkspace: false,
    candidates,
    skillHints: [],
    ...extra,
  };
  const ok = <T,>(data: T) => Promise.resolve({ ok: true as const, status: 200, data });
  return {
    list: vi.fn(() => ok(list)),
    save: vi.fn((id: string) => ok(savedItem(id))),
    dismiss: vi.fn((id: string) => ok({ candidateId: id })),
    saveAll: vi.fn((ids: readonly string[]) => ok({ saved: ids.map(savedItem) })),
    undo: vi.fn((ids: readonly string[]) => ok({ reopened: ids })),
    seen: vi.fn(() => ok({ read: 0 })),
  } satisfies ReviewApi;
}

const show = (api: ReviewApi) => render(<ReviewSection teamId="t1" threadId={THREAD} api={api} />);

afterEach(cleanup);

describe("To review", () => {
  it("shows nothing without candidates or a thread", async () => {
    const api = fakeApi([]);
    const { container } = show(api);
    await waitFor(() => expect(api.list).toHaveBeenCalledWith(THREAD));
    expect(container.textContent).toBe("");
    render(<ReviewSection teamId="t1" threadId={undefined} api={api} />);
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  it("focuses the first card when opened for review (?tab=review, the bell)", async () => {
    render(<ReviewSection teamId="t1" threadId={THREAD} api={fakeApi([cand()])} autoFocus />);
    const first = await screen.findByRole("heading", { name: "We ship on Tuesdays" });
    await waitFor(() => expect(document.activeElement).toBe(first));
  });

  it("labels a card and locks an inferred one to you", async () => {
    show(
      fakeApi([
        cand(),
        cand({
          id: "c2",
          source: "inferred",
          scopeLocked: true,
          allowedScopes: ["user"],
          statement: "Likes tea",
        }),
      ]),
    );
    const cards = await screen.findAllByRole("listitem");
    expect(screen.getByRole("heading", { name: "To review (2)" })).toBeTruthy();
    expect(screen.getByText("You said")).toBeTruthy();
    expect(screen.getByText("Kobe noticed")).toBeTruthy();
    expect(screen.getAllByText("High confidence (90%)")).toHaveLength(2);
    expect(screen.getAllByText("14 days left").length).toBeGreaterThan(0);
    const tea = must(cards.find((c) => within(c).queryByText("Likes tea")));
    expect(within(tea).queryByRole("radio", { name: "This Workspace" })).toBeNull();
    expect((within(tea).getByRole("radio", { name: /Just me/ }) as HTMLInputElement).disabled).toBe(
      true,
    );
  });

  it("saves an edited card to the Workspace choice and offers Undo", async () => {
    const api = fakeApi([cand({ saveAllMine: false })], { canCurateWorkspace: true });
    show(api);
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const box = screen.getByRole("textbox", { name: /Statement/ });
    await userEvent.clear(box);
    await userEvent.type(box, "We ship on Wednesdays");
    await userEvent.click(screen.getByRole("radio", { name: "This Workspace" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(api.save).toHaveBeenCalledWith(
      "c1",
      { statement: "We ship on Wednesdays", scope: "team" },
      {},
    );
    expect(await screen.findByText("Memory saved.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(api.undo).toHaveBeenCalledWith(["c1"]);
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
  });

  it("asks before a portable save and keeps non-curators out of Workspace saves", async () => {
    const api = fakeApi([
      cand({ kind: "preference", allowedScopes: ["user", "portable", "team"] }),
    ]);
    show(api);
    await userEvent.click(await screen.findByRole("checkbox", { name: /all my workspaces/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Use in all my workspaces" }));
    expect(api.save).toHaveBeenCalledWith("c1", { scope: "portable" }, {});

    cleanup();
    const member = fakeApi([cand({ scope: "team", destination: "team" })]);
    show(member);
    expect(await screen.findByText(/Only Team admins and memory stewards/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("dismisses, and saves all mine as one batch with one Undo", async () => {
    const api = fakeApi([
      cand(),
      cand({ id: "c2", statement: "Coffee at nine" }),
      cand({ id: "c3", saveAllMine: false, statement: "Shared fact" }),
    ]);
    show(api);
    const shared = await screen.findByRole("heading", { name: "Shared fact" });
    const card = must(shared.closest("li"));
    await userEvent.click(within(card).getByRole("button", { name: "Dismiss" }));
    expect(api.dismiss).toHaveBeenCalledWith("c3");
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Shared fact" })).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "Save all mine (2)" }));
    expect(api.saveAll).toHaveBeenCalledWith(["c1", "c2"]);
    expect(await screen.findByText("2 memories saved.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(api.undo).toHaveBeenCalledWith(["c1", "c2"]);
  });

  it("shows the diff, the Policy block with Save anyway, near-duplicates and skill hints", async () => {
    const api = fakeApi(
      [
        cand({
          operation: "update",
          scopeLocked: true,
          allowedScopes: ["user"],
          saveAllMine: false,
          target: { id: ITEM, version: 2, statement: "We ship on Mondays" },
          policyConflicts: [{ id: ITEM, version: 1, statement: "Never ship on Tuesdays." }],
          nearDuplicates: [{ id: ITEM, version: 1, statement: "Shipping is Tuesday" }],
        }),
      ],
      { skillHints: [{ title: "Release checklist", summary: "Steps to ship." }] },
    );
    show(api);
    const changes = await screen.findByLabelText("Changes");
    expect(within(changes).getByText("Mondays").tagName).toBe("DEL");
    expect(within(changes).getByText("Tuesdays").tagName).toBe("INS");
    expect(screen.getByText("Never ship on Tuesdays.")).toBeTruthy();
    expect(screen.getByText("Shipping is Tuesday")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Open the Skill Workbench" }).getAttribute("href"),
    ).toBe("/me/skills?tab=workbench");
    await userEvent.click(screen.getByRole("button", { name: "Not a conflict? Save anyway" }));
    expect(api.save).toHaveBeenCalledWith("c1", {}, { policyConflict: true });
  });

  it("scrolls the conversation to an evidence quote", async () => {
    const heard: RevealRequest[] = [];
    const on = (e: Event) => heard.push((e as CustomEvent<RevealRequest>).detail);
    window.addEventListener(REVEAL_REQUEST_EVENT, on);
    show(fakeApi([cand()]));
    await userEvent.click(
      await screen.findByRole("button", { name: "Show in the conversation: we ship on Tuesdays" }),
    );
    window.removeEventListener(REVEAL_REQUEST_EVENT, on);
    expect(heard).toEqual([{ threadId: THREAD, entryId: "u1" }]);
  });
});
