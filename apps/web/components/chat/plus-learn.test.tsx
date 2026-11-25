// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true,"handleDisabledFileLoadingAsSuccess":true},"width":1280,"height":800}
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKaiju } from "../../lib/chat/testing/fake-kaiju";
import { must } from "../../lib/testing/must";
import { DESKTOP_WIDTH, resizeWindow } from "../../lib/testing/viewport";
import { isMacPlatform } from "../../lib/shell/shortcuts";
import { chatRequests, composer, openApp } from "./testing";
import { LEARN_SPIN_MAX_MS, LEARN_TIMEOUT_MESSAGE } from "../../lib/chat/learn-watch";
import { MEMORY_DOT_MIN_CONTEXT_PERCENT } from "../../lib/chat/learn-api";
import { LEARN_HINT_KEY } from "./plus-learn";

/**
 * KOBE-395 (SM12, Q8): Learn from this chat in the composer's + menu (Memory), the + button's
 * dot / spinner / count, `/learn`, `/learn all`, Mod+Shift+L and the palette.
 */
let fake: FakeKaiju;
const WAIT = { timeout: 10_000 };
const PASS = "00000000-0000-4000-8000-00000000aa01";

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  resizeWindow(DESKTOP_WIDTH);
  fake = new FakeKaiju();
  fake.teamModels.push({
    alias: "kimi",
    label: "Kimi K2.7 Code",
    enabled: true,
    is_default: true,
    context_window: CONTEXT_WINDOW,
  });
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function answered() {
  const t = fake.addThread("Units");
  const first = fake.addSystemEntry(t, null, "model_change", {
    provider: "kaiju",
    modelId: "kimi",
  });
  const u = fake.addEntry(t, first, { role: "user", content: "I prefer metric units." });
  fake.addEntry(t, u, { role: "assistant", content: [{ type: "text", text: "Noted." }] });
  return t;
}

/** The model's context window in these tests: 1% is 1,000 tokens. */
const CONTEXT_WINDOW = 100_000;

/** The thread's newest call read `percent` of the window (the context gauge's figure). */
function filled(t: string, percent: number) {
  fake.threadLatestCall.set(t, {
    run_id: "00000000-0000-4000-8000-0000000000aa",
    at: "2026-11-25T10:00:00.000Z",
    model: "ollama/kimi",
    input_tokens: (CONTEXT_WINDOW * percent) / 100,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  });
}

/** New messages to learn from, in a context 40% full (the dot shows above 30%, KOBE-840). */
const learnable = (t: string, over: Record<string, unknown> = {}, percent = 40) => {
  filled(t, percent);
  fake.learnState.set(t, { new_messages: true, ...over });
};

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
  button.querySelector("[data-kaiju-learn-mark]")?.getAttribute("data-kaiju-learn-mark") ?? null;
const pulse = (button: HTMLElement) =>
  button.querySelector("[data-kaiju-learn-nudge]")?.getAttribute("data-kaiju-learn-nudge") ?? null;
const starts = () => fake.learnStarts.map((s) => s.mode);
const notice = () =>
  (document.querySelector("[data-kaiju-learn-notice]")?.textContent ?? "").replace(/\u00a0/g, "");

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
    () => must(document.querySelector<HTMLElement>("[data-kaiju-memory-menu]")),
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

  it("KOBE-840: no dot at 29% context use, the dot at 31%; Learn stays in the menu", async () => {
    expect(MEMORY_DOT_MIN_CONTEXT_PERCENT).toBe(30);
    const t = answered();
    learnable(t, { nudge: { reason: "messages", key: "start:kobe-840" } }, 29);
    openApp(fake, t);
    await waitFor(
      () => expect(fake.requests.some((r) => r.path === `/v1/threads/${t}/usage`)).toBe(true),
      WAIT,
    );
    await screen.findByRole("meter", { name: "Context used" }, WAIT);
    const below = await plus();
    expect(mark(below)).toBeNull();
    expect(pulse(below)).toBeNull();
    expect(below.getAttribute("aria-describedby")).toBeNull();
    // The suggestions stay reachable from the menu either way.
    const { sub } = await openMemory();
    const item = await within(sub).findByRole("menuitem", { name: /^Learn from this chat/ });
    expect(item.getAttribute("aria-disabled")).not.toBe("true");
    cleanup();
    learnable(t, {}, 31);
    openApp(fake, t);
    const above = await plusSaying("New messages to learn from (Memory)");
    expect(mark(above)).toBe("dot");
  });

  it("KOBE-840: suggestions to review keep their count whatever the context use", async () => {
    const t = answered();
    learnable(t, { candidates: 2 }, 5);
    openApp(fake, t);
    const button = await plusSaying(/2 memory suggestions to review/);
    expect(mark(button)).toBe("count");
  });

  it("the nudge pulses the dot once per crossing and never starts a pass (KOBE-410)", async () => {
    const t = answered();
    learnable(t, { nudge: { reason: "messages", key: "start:messages" } });
    openApp(fake, t);
    const button = await plusSaying("New messages to learn from (Memory)");
    expect(mark(button)).toBe("dot");
    await waitFor(() => expect(pulse(button)).toBe("pulse"), WAIT);
    expect(starts()).toEqual([]);
    // Opened again (another render, a reload): the same crossing does not pulse again.
    cleanup();
    openApp(fake, t);
    const again = await plusSaying("New messages to learn from (Memory)");
    expect(mark(again)).toBe("dot");
    expect(pulse(again)).toBeNull();
    // A new crossing (after the next pass, or a correction) pulses once more.
    cleanup();
    learnable(t, { nudge: { reason: "correction", key: "start:correction" } });
    openApp(fake, t);
    await waitFor(async () => expect(pulse(await plus())).toBe("pulse"), WAIT);
    expect(starts()).toEqual([]);
  });

  it("no nudge, no pulse: the dot stays still", async () => {
    const t = answered();
    learnable(t, { nudge: null });
    openApp(fake, t);
    const button = await plusSaying("New messages to learn from (Memory)");
    expect(pulse(button)).toBeNull();
  });

  it("a running pass: a spinner, not a dot; the items say it is learning", async () => {
    const t = answered();
    learnable(t, { running: { pass_id: PASS, started_at: "2026-11-15T10:00:00.000Z" } });
    openApp(fake, t);
    const button = await plusSaying("Kaiju is learning from this chat");
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
    expect(button.querySelector("[data-kaiju-learn-mark]")?.textContent).toBe("3");
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
    await plusSaying("Kaiju is learning from this chat");
    expect(notice()).toBe("Kaiju is learning from this chat.");
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
    const announced: unknown[] = [];
    const hear = (e: Event) => announced.push((e as CustomEvent).detail);
    window.addEventListener("kaiju:memory-pass-completed", hear);
    openApp(fake, t);
    await plusSaying("New messages to learn from");
    const { user, sub } = await openMemory();
    await user.click(within(sub).getByRole("menuitem", { name: /^Learn from this chat/ }));
    await plusSaying("Kaiju is learning from this chat");
    // The pass ends on the server: the next check (every 2 s) sees it.
    fake.learnState.set(t, { new_messages: false, running: null, candidates: 2 });
    await waitFor(() => expect(notice()).toMatch(/Kaiju found 2 things to review/), {
      timeout: 8_000,
    });
    // KOBE-396: the finished pass is announced, so To review can open by itself.
    window.removeEventListener("kaiju:memory-pass-completed", hear);
    expect(announced).toEqual([expect.objectContaining({ threadId: t, candidates: 2 })]);
    await plusSaying("2 memory suggestions to review");
  });

  it("never spins forever: past the limit the + stops and says Try again (KOBE-661)", async () => {
    const t = answered();
    learnable(t);
    openApp(fake, t);
    await plusSaying("New messages to learn from");
    const { user, sub } = await openMemory();
    await user.click(within(sub).getByRole("menuitem", { name: /^Learn from this chat/ }));
    await plusSaying("Kaiju is learning from this chat");
    // The server keeps saying it runs; the clock passes the limit before the next check.
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + LEARN_SPIN_MAX_MS + 1_000);
    await waitFor(() => expect(notice()).toBe(LEARN_TIMEOUT_MESSAGE), { timeout: 8_000 });
    const button = await plus();
    expect(mark(button)).not.toBe("spinner");
    expect(button.getAttribute("data-kaiju-learn-state")).not.toBe("spinner");
  });

  it("reads the state again when the tab comes back while a pass runs (KOBE-661)", async () => {
    const t = answered();
    learnable(t, { running: { pass_id: PASS, started_at: "2026-11-15T10:00:00.000Z" } });
    openApp(fake, t);
    await plusSaying("Kaiju is learning from this chat");
    fake.learnState.set(t, { new_messages: false, running: null, candidates: 1 });
    const reads = () =>
      fake.requests.filter((r) => r.method === "GET" && r.path.endsWith("/learn"));
    const before = reads().length;
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(reads().length).toBeGreaterThan(before), { timeout: 300 });
    await plusSaying("1 memory suggestion to review");
  });

  it("a server refusal shows its message", async () => {
    const t = answered();
    learnable(t);
    fake.learnRefusal = {
      status: 429,
      code: "learn_rate_limited",
      message: "You can teach Kaiju 20 times a day in this workspace. Try again later.",
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
    expect(button.querySelector("[data-kaiju-learn-mark]")?.textContent).toBe("2");
    const bar = must(button.closest("[data-composer-toolbar]"));
    expect(within(bar as HTMLElement).getAllByRole("button")[0]).toBe(button);
  });
});
