// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true,"handleDisabledFileLoadingAsSuccess":true},"width":1280,"height":800}
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { DESKTOP_WIDTH, resizeWindow } from "../../lib/testing/viewport";
import { isMacPlatform } from "../../lib/shell/shortcuts";
import { chatRequests, composer, openApp } from "./testing";
import { LEARN_HINT_KEY } from "./plus-learn";

/**
 * KOBE-395 (SM12, Q8): Learn from this chat in the composer's + menu (Memory), the + button's
 * dot / spinner / count, `/learn`, `/learn all`, Mod+Shift+L and the palette.
 */
let fake: FakeKobe;
const WAIT = { timeout: 10_000 };
const PASS = "00000000-0000-4000-8000-00000000aa01";

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  resizeWindow(DESKTOP_WIDTH);
  fake = new FakeKobe();
  fake.teamModels.push({ alias: "kimi", label: "Kimi K2.7 Code", enabled: true, is_default: true });
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function answered() {
  const t = fake.addThread("Units");
  const first = fake.addSystemEntry(t, null, "model_change", { provider: "kobe", modelId: "kimi" });
  const u = fake.addEntry(t, first, { role: "user", content: "I prefer metric units." });
  fake.addEntry(t, u, { role: "assistant", content: [{ type: "text", text: "Noted." }] });
  return t;
}

const learnable = (t: string, over: Record<string, unknown> = {}) =>
  fake.learnState.set(t, { new_messages: true, ...over });

const plus = () => screen.findByRole("button", { name: "Add to your message" }, WAIT);
/** The + button once its accessible description (the Learn state) reads `text`. */
const plusSaying = (text: string | RegExp) =>
  waitFor(async () => {
    const button = await plus();
    const ids = (button.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
    const said = ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
    expect(said).toMatch(text);
    return button;
  }, WAIT);
const mark = (button: HTMLElement) =>
  button.querySelector("[data-kobe-learn-mark]")?.getAttribute("data-kobe-learn-mark") ?? null;
const starts = () => fake.learnStarts.map((s) => s.mode);
const notice = () =>
  (document.querySelector("[data-kobe-learn-notice]")?.textContent ?? "").replace(/\u00a0/g, "");

async function openMemory() {
  const user = userEvent.setup();
  (await plus()).focus();
  await user.keyboard("{Enter}");
  const menu = await screen.findByRole("menu", {}, WAIT);
  within(menu)
    .getByRole("menuitem", { name: /^Memory/ })
    .focus();
  await user.keyboard("{ArrowRight}");
  // Radix names a submenu by its trigger ("Memory 3 to review"): find it by its own mark.
  const sub = await waitFor(
    () => must(document.querySelector<HTMLElement>("[data-kobe-memory-menu]")),
    WAIT,
  );
  expect(sub.getAttribute("role")).toBe("menu");
  return { user, sub };
}

describe("the + button's Learn state (ac-1)", { timeout: 30_000 }, () => {
  it("unavailable: no badge; Learn is disabled with the server's reason", async () => {
    openApp(fake, answered());
    await composer();
    const button = await plus();
    expect(button.getAttribute("aria-describedby")).toBeNull();
    expect(mark(button)).toBeNull();
    const { sub } = await openMemory();
    const item = await within(sub).findByRole("menuitem", { name: /^Learn from this chat/ });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.textContent).toContain("No learning model is set.");
    await userEvent.setup().click(item);
    expect(starts()).toEqual([]);
  });

  it("new messages since the last pass: a dot on the + and its label", async () => {
    const t = answered();
    learnable(t);
    openApp(fake, t);
    const button = await plusSaying("New messages to learn from (Memory)");
    expect(mark(button)).toBe("dot");
  });

  it("a running pass: a spinner, not a dot; the items say it is learning", async () => {
    const t = answered();
    learnable(t, { running: { pass_id: PASS, started_at: "2026-11-15T10:00:00.000Z" } });
    openApp(fake, t);
    const button = await plusSaying("Kobe is learning from this chat");
    expect(mark(button)).toBe("spinner");
    const { sub } = await openMemory();
    const item = within(sub).getByRole("menuitem", { name: /^Learn from this chat/ });
    expect(item.getAttribute("aria-disabled")).toBe("true");
  });

  it("candidates waiting: a count on the + and Review in Memory opens To review", async () => {
    const t = answered();
    learnable(t, { candidates: 3, new_messages: false });
    openApp(fake, t);
    const button = await plusSaying("3 memory suggestions to review (Memory)");
    expect(mark(button)).toBe("count");
    expect(button.querySelector("[data-kobe-learn-mark]")?.textContent).toBe("3");
    const { user, sub } = await openMemory();
    await user.click(within(sub).getByRole("menuitem", { name: "Review 3 candidates" }));
    await waitFor(() => expect(window.location.pathname).toBe("/me/memory"));
    expect(window.location.search).toContain("tab=review");
  });

  it("shows the one-time New hint on Memory until it is opened", async () => {
    const t = answered();
    learnable(t);
    openApp(fake, t);
    await plusSaying("New messages to learn from");
    const user = userEvent.setup();
    (await plus()).focus();
    await user.keyboard("{Enter}");
    const menu = await screen.findByRole("menu", {}, WAIT);
    expect(within(menu).getByRole("menuitem", { name: /^Memory/ }).textContent).toBe("MemoryNew");
    within(menu)
      .getByRole("menuitem", { name: /^Memory/ })
      .focus();
    await user.keyboard("{ArrowRight}");
    await screen.findByRole("menu", { name: "Memory" }, WAIT);
    expect(localStorage.getItem(LEARN_HINT_KEY)).toBe("seen");
  });

  it("a shared reader gets no + menu at all", async () => {
    const t = answered();
    learnable(t);
    must(fake.threads.get(t)).read_only = true;
    openApp(fake, t);
    await screen.findByText(/You are reading a shared conversation/, undefined, WAIT);
    expect(screen.queryByRole("button", { name: "Add to your message" })).toBeNull();
  });
});

describe("starting a pass (ac-2)", { timeout: 30_000 }, () => {
  it("Learn from this chat starts one; the + turns to a spinner and says so", async () => {
    const t = answered();
    learnable(t);
    openApp(fake, t);
    await plusSaying("New messages to learn from");
    const { user, sub } = await openMemory();
    await user.click(within(sub).getByRole("menuitem", { name: /^Learn from this chat/ }));
    await waitFor(() => expect(starts()).toEqual(["new"]));
    await plusSaying("Kobe is learning from this chat");
    expect(notice()).toBe("Kobe is learning from this chat.");
  });

  it("Rescan the whole chat starts an all pass and shows its estimate", async () => {
    const t = answered();
    learnable(t, { new_messages: false, estimate: { new_tokens: null, all_tokens: 18_400 } });
    openApp(fake, t);
    await composer();
    const { user, sub } = await openMemory();
    expect(
      within(sub)
        .getByRole("menuitem", { name: /^Learn from this chat/ })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    const rescan = within(sub).getByRole("menuitem", { name: /^Rescan the whole chat/ });
    expect(rescan.textContent).toContain("~18k tokens");
    expect(chatRequests(fake, "GET").some((r) => r.path.endsWith("/learn?estimate=1"))).toBe(true);
    await user.click(rescan);
    await waitFor(() => expect(starts()).toEqual(["all"]));
  });

  it("says how a pass it started ended: the candidates found, then the count on the +", async () => {
    const t = answered();
    learnable(t);
    openApp(fake, t);
    await plusSaying("New messages to learn from");
    const { user, sub } = await openMemory();
    await user.click(within(sub).getByRole("menuitem", { name: /^Learn from this chat/ }));
    await plusSaying("Kobe is learning from this chat");
    // The pass ends on the server: the next check (every 2 s) sees it.
    fake.learnState.set(t, { new_messages: false, running: null, candidates: 2 });
    await waitFor(() => expect(notice()).toMatch(/Kobe found 2 things to review/), {
      timeout: 8_000,
    });
    await plusSaying("2 memory suggestions to review");
  });

  it("a server refusal shows its message", async () => {
    const t = answered();
    learnable(t);
    fake.learnRefusal = {
      status: 429,
      code: "learn_rate_limited",
      message: "You can teach Kobe 20 times a day in this workspace. Try again later.",
    };
    openApp(fake, t);
    await plusSaying("New messages to learn from");
    const { user, sub } = await openMemory();
    await user.click(within(sub).getByRole("menuitem", { name: /^Learn from this chat/ }));
    await waitFor(() => expect(notice()).toMatch(/20 times a day/));
  });

  it("/learn and /learn all start passes from the composer", async () => {
    const t = answered();
    learnable(t);
    openApp(fake, t);
    await plusSaying("New messages to learn from");
    const input = await composer();
    const user = userEvent.setup();
    await user.type(input, "/learn");
    const list = await screen.findByRole("listbox", { name: "Actions" }, WAIT);
    expect(within(list).getAllByRole("option")[0]?.getAttribute("aria-label")).toBe(
      "/learn range, Learn from this chat",
    );
    await user.keyboard("{Enter}");
    await waitFor(() => expect(starts()).toEqual(["new"]));
    expect(input.value).toBe("");
  });

  it("/learn all rescans", async () => {
    const t = answered();
    learnable(t, { new_messages: false });
    openApp(fake, t);
    await composer();
    // The state is read before the menu is used.
    await waitFor(() =>
      expect(chatRequests(fake, "GET").some((r) => r.path.endsWith("/learn"))).toBe(true),
    );
    const input = await composer();
    const user = userEvent.setup();
    await user.type(input, "/learn all");
    const list = await screen.findByRole("listbox", { name: "range for /learn" }, WAIT);
    expect(
      within(list)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["The whole chat (rescan)"]);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(starts()).toEqual(["all"]));
  });

  it("Mod+Shift+L starts a pass from the message box", async () => {
    const t = answered();
    learnable(t);
    openApp(fake, t);
    await plusSaying("New messages to learn from");
    const input = await composer();
    input.focus();
    const mod = isMacPlatform() ? { metaKey: true } : { ctrlKey: true };
    fireEvent.keyDown(input, { key: "L", code: "KeyL", shiftKey: true, ...mod });
    await waitFor(() => expect(starts()).toEqual(["new"]));
  });

  it("the palette lists Learn from this chat with its two ranges", async () => {
    const t = answered();
    learnable(t);
    openApp(fake, t);
    await plusSaying("New messages to learn from");
    const mod = isMacPlatform() ? { metaKey: true } : { ctrlKey: true };
    fireEvent.keyDown(document.body, { key: "k", code: "KeyK", ...mod });
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    const user = userEvent.setup();
    await user.keyboard("learn from this chat{Enter}");
    const choices = await within(dialog).findByRole(
      "listbox",
      { name: "Learn from this chat" },
      WAIT,
    );
    expect(within(choices).getAllByRole("option")).toHaveLength(2);
    await user.keyboard("rescan{Enter}");
    await waitFor(() => expect(starts()).toEqual(["all"]));
  });
});

describe("narrow composers keep the + indicator (ac-3)", { timeout: 30_000 }, () => {
  it("on a phone the + still carries the count", async () => {
    resizeWindow(390);
    const t = answered();
    learnable(t, { candidates: 2 });
    openApp(fake, t);
    const button = await plusSaying("2 memory suggestions to review");
    expect(button.querySelector("[data-kobe-learn-mark]")?.textContent).toBe("2");
    const bar = must(button.closest("[data-composer-toolbar]"));
    expect(within(bar as HTMLElement).getAllByRole("button")[0]).toBe(button);
  });
});
