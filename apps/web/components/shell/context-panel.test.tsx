// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONTEXT_VIEW_KEY } from "../../lib/chat/context-viewer";
import { contextOf, section } from "../../lib/chat/testing/context-fixtures";
import { FakeKaiju } from "../../lib/chat/testing/fake-kaiju";
import { openApp } from "../chat/testing";

/**
 * KOBE-841: the Context panel's Formatted/Raw toggle (remembered), safe formatting of untrusted
 * markup, Download, the legend filter, collapsible sections and the Memory row.
 */
let fake: FakeKaiju;

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKaiju();
  fake.teamModels.push({
    alias: "kimi",
    label: "Kimi K2.7 Code",
    enabled: true,
    is_default: true,
    context_window: 200_000,
  });
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const HOSTILE =
  '<div><script>window.pwned = 1</script><img src="https://e.test/x.png" onerror="window.pwned = 2"><a href="javascript:alert(1)">x</a></div>';

const SECTIONS = [
  section("system_prompt", 400, "<rules>\n    Be brief.\n</rules>", "rules"),
  section("memory", 30, "Saved memory\n- likes tea", "Saved memory"),
  section("memory", 20, "What Kaiju knows\n- the wiki", "What Kaiju knows"),
  section("tool_result", 100, HOSTILE, "fetch"),
  section("user_message", 50, "Hello there"),
];

function thread(sections = SECTIONS, extra = {}): string {
  const t = fake.addThread("Report");
  fake.threadLatestCall.set(t, {
    run_id: "00000000-0000-4000-8000-0000000000aa",
    at: "2026-10-21T10:00:00.000Z",
    model: "ollama/kimi",
    input_tokens: 600,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  });
  fake.threadContext.set(t, [
    { status: 200, body: contextOf(sections, { thread_id: t, ...extra }) },
    { status: 200, body: contextOf(sections, { thread_id: t, ...extra }) },
  ]);
  return t;
}

async function openViewer(t: string) {
  openApp(fake, t);
  const gauge = await screen.findByRole("meter", { name: "Context used" });
  await userEvent.setup().click(gauge);
  const dialog = await screen.findByRole("dialog", { name: "Context" });
  const text = within(dialog).getByRole("region", { name: "Context text" });
  await within(text).findByText(/System prompt · rules/);
  return { dialog, text };
}

describe("Formatted and Raw", () => {
  it("formats markup as tokens, never live HTML, and Raw shows the exact text; the choice is remembered", async () => {
    const t = thread();
    const { dialog, text } = await openViewer(t);
    const user = userEvent.setup();
    const formatted = within(dialog).getByRole("button", { name: "Formatted" });
    expect(formatted.getAttribute("aria-pressed")).toBe("true");
    expect(text.getAttribute("data-context-view")).toBe("formatted");
    // The system prompt's tags are coloured tokens; a short body sits between them.
    expect(text.querySelectorAll("[data-token='tag']").length).toBeGreaterThan(0);
    expect(text.textContent).toContain("<rules>Be brief.</rules>");
    // The hostile tool result is laid out as text: no element, handler or load comes from it.
    expect(text.querySelector("script, img, a, iframe")).toBeNull();
    expect(text.textContent).toContain("window.pwned = 1");
    expect(text.textContent).toContain('"javascript:alert(1)"');
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();

    await user.click(within(dialog).getByRole("button", { name: "Raw" }));
    expect(text.getAttribute("data-context-view")).toBe("raw");
    expect(text.querySelectorAll("[data-token]")).toHaveLength(0);
    within(text).getByText(HOSTILE);
    // Exactly as sent: the indentation is kept.
    within(text).getByText("    Be brief.", { normalizer: (x) => x });
    expect(localStorage.getItem(CONTEXT_VIEW_KEY)).toBe("raw");

    // Reopened, the panel remembers Raw.
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Context" })).toBeNull());
    await user.click(await screen.findByRole("meter", { name: "Context used" }));
    const again = await screen.findByRole("dialog", { name: "Context" });
    await within(again).findByText(/System prompt · rules/);
    expect(within(again).getByRole("button", { name: "Raw" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });
});

describe("Download", () => {
  it("saves the context with headings, token counts and the raw text, named by thread and time", async () => {
    const t = thread();
    const { dialog } = await openViewer(t);
    const blobs: Blob[] = [];
    vi.stubGlobal(
      "URL",
      Object.assign(URL, {
        createObjectURL: (b: Blob) => {
          blobs.push(b);
          return "blob:test";
        },
        revokeObjectURL: () => undefined,
      }),
    );
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });
    await userEvent
      .setup()
      .click(within(dialog).getByRole("button", { name: "Download the context" }));
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(new RegExp(`^kaiju-context-${t}-\\d{4}-\\d{2}-\\d{2}-\\d{6}Z\\.txt$`));
    const text = await (blobs[0] as Blob).text();
    expect(text).toContain(
      "===== 1. System prompt · rules · 400 tokens =====\n<rules>\n    Be brief.\n</rules>",
    );
    expect(text).toContain(`===== 4. Tool result · fetch · 100 tokens =====\n${HOSTILE}`);
  });
});

describe("the legend filter", () => {
  it("filters the text to a kind, highlights its segment, announces it, and clears", async () => {
    const t = thread();
    const { dialog, text } = await openViewer(t);
    const user = userEvent.setup();
    const legend = within(dialog).getByRole("list", { name: "Context by kind" });
    const memory = within(legend).getByRole("button", { name: /^Memory: 50 tokens/ });
    expect(memory.getAttribute("aria-pressed")).toBe("false");
    await user.click(memory);
    expect(memory.getAttribute("aria-pressed")).toBe("true");
    const segment = dialog.querySelector("[data-context-segment='memory']");
    expect(segment?.hasAttribute("data-selected")).toBe(true);
    expect(
      dialog.querySelector("[data-context-segment='system_prompt']")?.hasAttribute("data-selected"),
    ).toBe(false);
    await within(text).findByText(/Memory · Saved memory/);
    within(text).getByText(/Memory · What Kaiju knows/);
    expect(within(text).queryByText(/System prompt · /)).toBeNull();
    expect(within(dialog).getByText("Showing only Memory: 2 sections.")).toBeTruthy();
    within(dialog).getByText("Only Memory (2 sections)");

    // Clear filter brings everything back.
    await user.click(within(dialog).getByRole("button", { name: "Clear filter" }));
    await within(text).findByText(/System prompt · /);
    expect(memory.getAttribute("aria-pressed")).toBe("false");
    expect(within(dialog).getByText("Showing every section.")).toBeTruthy();

    // From the keyboard: Enter filters, again clears.
    memory.focus();
    await user.keyboard("{Enter}");
    expect(memory.getAttribute("aria-pressed")).toBe("true");
    await user.keyboard("{Enter}");
    expect(memory.getAttribute("aria-pressed")).toBe("false");
    await within(text).findByText(/System prompt · /);
  });
});

describe("collapsing sections", () => {
  it("collapses a section to its heading, and expands or collapses them all", async () => {
    const t = thread();
    const { dialog, text } = await openViewer(t);
    const user = userEvent.setup();
    const heading = within(text).getByRole("button", { name: /User prompt · 50 tokens/ });
    expect(heading.getAttribute("aria-expanded")).toBe("true");
    within(text).getByText("Hello there");
    await user.click(heading);
    expect(
      within(text)
        .getByRole("button", { name: /User prompt · 50 tokens/ })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(within(text).queryByText("Hello there")).toBeNull();

    await user.click(within(dialog).getByRole("button", { name: "Collapse all" }));
    expect(text.textContent).not.toContain("Be brief.");
    const headings = within(text).getAllByRole("button");
    expect(headings).toHaveLength(5);
    expect(headings.every((h) => h.getAttribute("aria-expanded") === "false")).toBe(true);

    await user.click(within(dialog).getByRole("button", { name: "Expand all" }));
    expect(text.textContent).toContain("Be brief.");
    within(text).getByText("Hello there");
  });
});

describe("the Memory row", () => {
  it("is listed with 0 tokens when the call had no memory, and filters to an empty note", async () => {
    const t = thread([
      section("system_prompt", 400, "x", "rules"),
      section("user_message", 50, "Hi"),
    ]);
    const { dialog, text } = await openViewer(t);
    const legend = within(dialog).getByRole("list", { name: "Context by kind" });
    const row = within(legend).getByRole("button", { name: /^Memory: 0 tokens/ });
    expect(row.textContent).toBe("Memory0 tokens0%");
    expect(dialog.querySelector("[data-context-segment='memory']")).toBeNull();
    await userEvent.setup().click(row);
    await within(text).findByText("No Memory in this context.");
  });

  it("says unknown when an approximate answer may lack the memory", async () => {
    const t = thread([section("user_message", 50, "Hi")], {
      exact: false,
      source: "session",
      missing: ["memory"],
      context_window: null,
    });
    openApp(fake, t);
    await userEvent.setup().click(await screen.findByRole("meter", { name: "Context used" }));
    const dialog = await screen.findByRole("dialog", { name: "Context" });
    const legend = await within(dialog).findByRole("list", { name: "Context by kind" });
    expect(within(legend).getByRole("button", { name: /^Memory: unknown/ })).toBeTruthy();
  });
});
