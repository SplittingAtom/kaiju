import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./support/chat.js";
import { SHELL_TIMEOUT_MS } from "./support/constants.js";
import { panelOf } from "./support/panel.js";
import { api } from "./support/tree.js";

/**
 * Gate D (KOBE-412) on gate1: the Learn nudge (KOBE-410) and memory quality (KOBE-411).
 *
 * 1. The Site console's Memory switches show **Nudge to learn** (read only: the spec never changes
 *    it). In one thread, ten short "OK" turns cross the threshold: after the ninth the Learn state
 *    has no nudge, after the tenth it names a `messages` nudge and the + button's dot pulses
 *    (`data-kobe-learn-nudge="pulse"`, two beats, recorded by a MutationObserver because it lasts
 *    2.4 s); a thumbs down then gives a `correction` nudge and a second pulse on the next read. No
 *    learning pass starts (no spinner, `running` stays null). Spends ten short model turns.
 * 2. Workspace and Site console › Memory › Quality show queue health (pending, oldest waiting,
 *    median time to decision), how memories are used (runs, thumbs down, last received, flags) and
 *    Learn's pass numbers, in sane formats (gate1's numbers vary). Light and dark screenshots of
 *    both Quality views are attached. Spends no tokens.
 */
const NUDGE_MESSAGES = 10;
const LEARN_PATH = /\/v1\/threads\/[^/]+\/learn(\?|$)/;
const DURATION = /^\d+ (min|h|days)$/;
const COUNT = /^\d+$/;
const PULSE_TIMEOUT_MS = 30_000;

interface LearnStateWire {
  readonly blocker: { readonly code: string } | null;
  readonly running: unknown;
  readonly new_messages: boolean;
  readonly nudge?: { readonly reason: string; readonly key: string } | null;
}

declare global {
  interface Window {
    __kobeNudgePulses?: number;
  }
}

async function shoot(page: Page, name: string, target: Locator): Promise<void> {
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await test.info().attach(`${name}-${theme}.png`, {
      body: await target.screenshot({ animations: "disabled" }),
      contentType: "image/png",
    });
  }
  await page.evaluate(() => delete document.documentElement.dataset.theme);
}

/** Counts every pulse start in the page (the attribute appearing), from the first paint. */
async function recordPulses(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__kobeNudgePulses = 0;
    const seen = new WeakSet<Element>();
    const count = () => {
      document.querySelectorAll('[data-kobe-learn-nudge="pulse"]').forEach((el) => {
        if (seen.has(el)) return;
        seen.add(el);
        window.__kobeNudgePulses = (window.__kobeNudgePulses ?? 0) + 1;
      });
    };
    new MutationObserver(count).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-kobe-learn-nudge"],
    });
  });
}

/**
 * The thread's Learn state once its last run counts as completed. The chat reads the state when
 * the thread opens and when a run ends, so its first read of a new thread can come before the
 * reply finished (`no_completed_run`): read the server's state until the run counts, then return it.
 */
async function settledState(page: Page, threadId: string): Promise<LearnStateWire> {
  let last: LearnStateWire | null = null;
  await expect
    .poll(
      async () => {
        const res = await api(page, "GET", `/v1/threads/${threadId}/learn`);
        if (res.status !== 200) return `HTTP ${res.status}`;
        const body = res.json as LearnStateWire & { data?: LearnStateWire };
        last = body.data ?? body;
        return last.blocker?.code ?? "none";
      },
      { timeout: SHELL_TIMEOUT_MS, intervals: [1_000] },
    )
    .not.toMatch(/^(no_completed_run|HTTP \d+)$/);
  return last as unknown as LearnStateWire;
}

const pulses = (page: Page) => page.evaluate(() => window.__kobeNudgePulses ?? 0);

test("the Learn nudge: switch shown, pulse after 10 messages and after a thumbs down, no pass", async ({
  chat,
  page,
}) => {
  test.setTimeout(15 * 60_000);
  await page.goto("/admin/site/settings");
  const form = panelOf(page).getByRole("form", { name: "Memory" });
  const nudgeSwitch = form.getByRole("checkbox", { name: "Nudge to learn" });
  await expect(nudgeSwitch).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  await expect(nudgeSwitch, "the nudge is on on gate1 (default)").toBeChecked();
  await expect(nudgeSwitch).toBeEnabled();

  const states: LearnStateWire[] = [];
  page.on("response", async (res) => {
    if (res.request().method() !== "GET" || !LEARN_PATH.test(res.url()) || !res.ok()) return;
    const body = (await res.json().catch(() => null)) as
      (LearnStateWire & { data?: LearnStateWire }) | null;
    if (body) states.push(body.data ?? body);
  });
  const latestAfter = async (seen: number): Promise<LearnStateWire> => {
    await expect.poll(() => states.length, { timeout: SHELL_TIMEOUT_MS }).toBeGreaterThan(seen);
    return states[states.length - 1] as LearnStateWire;
  };
  await recordPulses(page);

  await chat.open();
  const plus = page.getByRole("button", { name: "Add to your message", exact: true });
  for (let i = 1; i <= NUDGE_MESSAGES; i += 1) {
    // ask() returns once the reply finished and the chat is idle.
    const threadId = await chat.ask(`No tools. Reply with the single word OK. (${i})`);
    const state = await settledState(page, threadId);
    expect(state.blocker, "Learn could start (else no dot and no nudge)").toBeNull();
    expect(state.running).toBeNull();
    if (i < NUDGE_MESSAGES) {
      expect(state.nudge ?? null, `no nudge after ${i} messages`).toBeNull();
      expect(await pulses(page)).toBe(0);
    } else {
      expect(state.nudge?.reason).toBe("messages");
    }
  }
  await expect.poll(() => pulses(page), { timeout: PULSE_TIMEOUT_MS }).toBe(1);
  // A hint only: the dot stays, no pass started.
  await expect(plus.locator('[data-kobe-learn-mark="dot"]')).toBeVisible();
  await expect(plus).not.toHaveAttribute("data-kobe-learn-state", "spinner");
  await expect(page.locator("[data-kobe-learn-notice]")).not.toContainText(
    "Kobe is learning from this chat",
  );

  // A correction: thumbs down on the last answer; the next read (here a reload) pulses again.
  const down = await chat.messageAction(chat.answers.last(), "Bad answer");
  await down.click();
  await expect(down).toHaveAttribute("aria-pressed", "true");
  const seen = states.length;
  await page.reload();
  await expect(chat.composer).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  const corrected = await latestAfter(seen);
  expect(corrected.nudge?.reason).toBe("correction");
  expect(corrected.running).toBeNull();
  await expect.poll(() => pulses(page), { timeout: PULSE_TIMEOUT_MS }).toBe(1);
  await expect(plus).not.toHaveAttribute("data-kobe-learn-state", "spinner");
  // Leave no rating behind (the thread goes to Trash at the end).
  const again = await chat.messageAction(chat.answers.last(), "Bad answer");
  await again.click();
  await expect(again).toHaveAttribute("aria-pressed", "false");
});

async function cellTexts(rows: Locator, column: number): Promise<string[]> {
  const out: string[] = [];
  for (let r = 0; r < (await rows.count()); r += 1) {
    out.push(((await rows.nth(r).locator("th, td").nth(column).textContent()) ?? "").trim());
  }
  return out;
}

/** Queue health, memory usage and Learn's numbers on one Quality tab, in sane formats. */
async function checkQuality(panel: Locator, queue: string): Promise<void> {
  const queues = panel.getByRole("table", { name: "Review queues" });
  await expect(queues).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  for (const h of ["Queue", "Pending", "Oldest waiting", "Decided", "Median time to decision"])
    await expect(queues.getByRole("columnheader", { name: h, exact: true })).toBeVisible();
  await expect(queues.getByRole("rowheader", { name: queue, exact: true })).toBeVisible();
  const qRows = queues.locator("tbody tr");
  expect(await qRows.count()).toBeGreaterThan(0);
  for (const v of await cellTexts(qRows, 1)) expect(v).toMatch(COUNT);
  for (const v of await cellTexts(qRows, 2)) expect(v).toMatch(/^(None|\d+ (min|h|days))$/);
  for (const v of await cellTexts(qRows, 3)) expect(v).toMatch(COUNT);
  for (const v of await cellTexts(qRows, 4)) expect(v === "—" || DURATION.test(v)).toBe(true);

  await expect(panel.getByRole("heading", { name: "How memories are used" })).toBeVisible();
  await expect(panel.getByRole("combobox", { name: "Show" })).toContainText(/Check this \(\d+\)/);
  const items = panel.getByRole("table", { name: "Memories with how often runs received them" });
  const empty = panel.getByText("No active memories", { exact: true });
  await expect(items.or(empty)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  if (await items.isVisible()) {
    for (const h of ["Memory", "Runs", "Thumbs down", "Last received", "Flags"])
      await expect(items.getByRole("columnheader", { name: h, exact: true })).toBeVisible();
    const iRows = items.locator("tbody tr");
    for (const v of await cellTexts(iRows, 1)) expect(v).toMatch(COUNT);
    for (const v of await cellTexts(iRows, 2)) expect(v).toMatch(COUNT);
    for (const v of await cellTexts(iRows, 3)) expect(v).toMatch(/^(Never|.*\d{4}.*)$/);
    for (const v of await cellTexts(iRows, 4))
      expect(v).toMatch(/^((Check this)?(Not used lately)?)$/);
  }

  const passes = panel.getByRole("table", { name: "Learning pass numbers" });
  const none = panel.getByText("No learning passes", { exact: true });
  await expect(passes.or(none)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  if (await passes.isVisible()) {
    for (const h of ["Passes", "Failed", "Shown", "Saved", "Edited before save", "Dismissed"])
      await expect(passes.getByRole("columnheader", { name: h, exact: true })).toBeVisible();
    const pRows = passes.locator("tbody tr");
    expect(await pRows.count()).toBeGreaterThan(0);
    for (let c = 1; c <= 10; c += 1)
      for (const v of await cellTexts(pRows, c)) expect(v).toMatch(COUNT);
  }
}

test("Memory › Quality: queue health, item signals and flags, Learn's numbers (Workspace and Site)", async ({
  page,
}) => {
  await page.goto("/admin/team/memory");
  const panel = panelOf(page);
  await panel.getByRole("tab", { name: "Quality" }).click({ timeout: SHELL_TIMEOUT_MS });
  await checkQuality(panel, "Proposals to this workspace");
  await expect(
    panel.getByRole("table", { name: "Learning pass numbers" }).getByRole("rowheader", {
      name: "This workspace",
    }),
  ).toBeVisible();
  await shoot(page, "workspace-memory-quality", panel);

  await page.goto("/admin/site/memory");
  await panel.getByRole("tab", { name: "Quality" }).click({ timeout: SHELL_TIMEOUT_MS });
  await checkQuality(panel, "Proposals waiting for the Site");
  await shoot(page, "site-memory-quality", panel);
});
