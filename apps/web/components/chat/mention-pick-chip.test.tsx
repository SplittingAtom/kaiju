// @vitest-environment happy-dom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestReload, resetReloadRequest } from "../../lib/build/reload-draft";
import { MENTION_LIMIT_REFUSED, MENTION_NAME_REFUSED } from "../../lib/chat/mention-insert";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { composer, openApp } from "./testing";

/**
 * KOBE-756: a file picked in the `@` picker becomes the same file chip a drag from the Files tree
 * or "Mention in message" adds (KOBE-374): the typed `@query` leaves the text, the chip goes in
 * the chip row, the send appends its marker and lists it in `mentions[]` as before (KOBE-223).
 * Duplicates, the 20-mention limit, Tab, Backspace, restored drafts, edit-last and hand-typed
 * `@path` text are covered here; the basics are in mention-picker.test.tsx.
 */
let fake: FakeKobe;
const WAIT = { timeout: 10_000 };

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  fake.workspaceFiles.set("data/sales q3.csv", new Uint8Array(10));
  fake.workspaceFiles.set("reports/summary.md", new Uint8Array(10));
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  cleanup();
  resetReloadRequest();
  vi.unstubAllGlobals();
});

const posts = () =>
  fake.requests
    .filter((r) => r.method === "POST" && /\/v1\/threads\/[^/]+\/messages$/.test(r.path))
    .map((r) => r.body as { content?: string; mentions?: string[] } | undefined);
const sent = () => posts().map((b) => b?.content);
const listed = () => posts().map((b) => b?.mentions);
const picker = () => screen.findByRole("listbox", { name: "Workspace files" }, WAIT);
/** Waits for `name` among the options (earlier matches stay while new ones load), then Enter. */
async function pickWithEnter(name: RegExp) {
  await within(await picker()).findByRole("option", { name }, WAIT);
  await userEvent.setup().keyboard("{Enter}");
}
const chipNames = () =>
  within(screen.getByRole("list", { name: "Mentioned files" }))
    .getAllByRole("listitem")
    .map((li) => li.textContent);

describe("picking a file with @ makes a chip (KOBE-756)", { timeout: 30_000 }, () => {
  it("Tab picks too; the text after the @query stays, the caret where the @ was", async () => {
    openApp(fake, fake.addThread("Sales"));
    const user = userEvent.setup();
    const input = await composer();
    await user.type(input, "see  later");
    input.setSelectionRange(4, 4);
    await user.type(input, "@sum", { initialSelectionStart: 4, initialSelectionEnd: 4 });
    await picker();
    await user.keyboard("{Tab}");
    await waitFor(() => expect(input.value).toBe("see later"));
    expect(input.selectionStart).toBe(4);
    expect(chipNames()).toEqual(["@reports/summary.md"]);
  });

  it("a file already chipped is not added twice; the second @query still leaves the text", async () => {
    openApp(fake, fake.addThread("Sales"));
    const user = userEvent.setup();
    const input = await composer();
    await user.type(input, "@sum");
    await picker();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(input.value).toBe(""));
    await user.type(input, "and @sum");
    await picker();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(input.value).toBe("and "));
    expect(chipNames()).toEqual(["@reports/summary.md"]);
    await user.type(input, "{Enter}");
    await waitFor(() => expect(sent()).toEqual(["and\n\n@file(reports/summary.md)"]));
    expect(listed()).toEqual([["reports/summary.md"]]);
  });

  it("Backspace in an empty input removes the last chip; with text it edits the text", async () => {
    openApp(fake, fake.addThread("Sales"));
    const user = userEvent.setup();
    const input = await composer();
    await user.type(input, "@sal");
    await pickWithEnter(/sales q3/);
    await waitFor(() => expect(input.value).toBe(""));
    await user.type(input, "@sum");
    await pickWithEnter(/summary/);
    await waitFor(() => expect(chipNames()).toHaveLength(2));
    await user.type(input, "x{Backspace}");
    expect(chipNames()).toHaveLength(2);
    await user.keyboard("{Backspace}");
    expect(chipNames()).toEqual(["@data/sales q3.csv"]);
    // Not while an IME composes.
    fireEvent.keyDown(input, { key: "Backspace", isComposing: true });
    expect(chipNames()).toEqual(["@data/sales q3.csv"]);
  });

  it("hand-typed @path text stays text and is sent as written, without mentions", async () => {
    openApp(fake, fake.addThread("Sales"));
    const user = userEvent.setup();
    const input = await composer();
    await user.click(input);
    await user.paste("read @reports/summary.md please");
    expect(screen.queryByRole("list", { name: "Mentioned files" })).toBeNull();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(sent()).toEqual(["read @reports/summary.md please"]));
    expect(listed()).toEqual([undefined]);
  });

  it("a draft restored after the new-build Reload restores its chips", async () => {
    const t = fake.addThread("Sales");
    openApp(fake, t);
    const user = userEvent.setup();
    let input = await composer();
    await user.type(input, "compare @sum");
    await picker();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(chipNames()).toEqual(["@reports/summary.md"]));
    requestReload();
    window.dispatchEvent(new Event("pagehide"));
    cleanup();
    resetReloadRequest();

    openApp(fake, t);
    input = await composer();
    await waitFor(() => expect(input.value).toBe("compare "), WAIT);
    await waitFor(() => expect(chipNames()).toEqual(["@reports/summary.md"]), WAIT);
  });

  it("the 21st file is refused like a drop, with the same reason; the 20 and the typed text stay", async () => {
    const t = fake.addThread("Sales");
    const many = Array.from({ length: 20 }, (_, i) => `f${i}.txt`);
    sessionStorage.setItem(
      "kobe.reload-drafts",
      JSON.stringify({ savedAt: Date.now(), drafts: { [t]: { text: "x", mentions: many } } }),
    );
    openApp(fake, t);
    const user = userEvent.setup();
    const input = await composer();
    await waitFor(() => expect(chipNames()).toHaveLength(20), WAIT);
    await user.type(input, " @sum");
    await pickWithEnter(/summary/);
    await screen.findByText(MENTION_LIMIT_REFUSED, undefined, WAIT);
    expect(chipNames()).toHaveLength(20);
    expect(chipNames()).not.toContain("@reports/summary.md");
    // What the member typed is left exactly as typed.
    expect(input.value).toBe("x @sum");
  });

  it("a file with an unmentionable name is refused and the typed text stays", async () => {
    // The server's search would leave it out; a stale or odd result must still be refused.
    fake.workspaceFiles.set(".kobe/notes-summary.md", new Uint8Array(1));
    const realFetch = fake.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/v1/workspace/files/search")) {
        return Response.json({
          entries: [
            {
              name: "notes-summary.md",
              path: ".kobe/notes-summary.md",
              type: "file",
              size_bytes: 1,
              mtime: "2026-11-01T00:00:00.000Z",
              area: "workspace",
            },
          ],
        });
      }
      return realFetch(input, init);
    });
    openApp(fake, fake.addThread("Sales"));
    const user = userEvent.setup();
    const input = await composer();
    await user.type(input, "see @notes");
    await pickWithEnter(/notes-summary/);
    await screen.findByText(MENTION_NAME_REFUSED, undefined, WAIT);
    expect(input.value).toBe("see @notes");
    expect(screen.queryByRole("list", { name: "Mentioned files" })).toBeNull();
  });

  it("a click on an option leaves the focus in the input; removing a chip gives it back", async () => {
    openApp(fake, fake.addThread("Sales"));
    const user = userEvent.setup();
    const input = await composer();
    await user.type(input, "@sum");
    await user.click(await within(await picker()).findByRole("option", { name: /summary/ }, WAIT));
    await waitFor(() => expect(chipNames()).toEqual(["@reports/summary.md"]));
    expect(document.activeElement).toBe(input);
    await user.click(screen.getByRole("button", { name: "Remove mention of summary.md" }));
    expect(screen.queryByRole("list", { name: "Mentioned files" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it("edit-last: the sent text is edited as written and goes without mentions, as before", async () => {
    fake.teamModels.push({ alias: "kimi", label: "Kimi", enabled: true, is_default: true });
    const t = fake.addThread("Report");
    const first = fake.addSystemEntry(t, null, "model_change", {
      provider: "kobe",
      modelId: "kimi",
    });
    const root = fake.addSystemEntry(t, first, "thinking_level_change", { thinkingLevel: "off" });
    const q = fake.addEntry(t, root, {
      role: "user",
      content: "Read /workspace/reports/summary.md",
    });
    fake.addEntry(t, q, { role: "assistant", content: [{ type: "text", text: "Done." }] });
    openApp(fake, t);
    const user = userEvent.setup();
    const input = await composer();
    await screen.findByText("Done.", undefined, WAIT);
    await screen.findByRole("combobox", { name: "Model for this conversation" }, WAIT);
    input.focus();
    await user.keyboard("{ArrowUp}");
    const edit = (await screen.findByLabelText(
      "Edit your message",
      undefined,
      WAIT,
    )) as HTMLTextAreaElement;
    expect(edit.value).toBe("Read /workspace/reports/summary.md");
    expect(screen.queryByRole("list", { name: "Mentioned files" })).toBeNull();
    await user.type(edit, " again");
    await user.click(within(must(edit.parentElement)).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sent()).toEqual(["Read /workspace/reports/summary.md again"]));
    expect(listed()).toEqual([undefined]);
  });
});
