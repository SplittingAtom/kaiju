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
 *    (`data-kaiju-learn-nudge="pulse"`, two beats, recorded by a MutationObserver because it lasts
 *    2.4 s); a thumbs down then gives a `correction` nudge and a second pulse on the next read. No
 *    learning pass starts (no spinner, `running` stays null). Since KOBE-840 the dot (and so its
 *    pulse) shows only above 30% context use: the page's reads of the team's models and the
 *    thread's usage are answered with a fixed context window and a chosen use (`driveContextUse`),
 *    so the spec shows no dot or pulse at exactly 30% and the dot and its pulse at 31%, whatever
 *    model the install runs. Spends ten short model turns.
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
/** How long the spec watches for a pulse that must not come (the pulse starts within frames). */
const PULSE_WATCH_MS = 3_000;

interface LearnStateWire {
  readonly blocker: { readonly code: string } | null;
  readonly running: unknown;
  readonly new_messages: boolean;
  readonly nudge?: { readonly reason: string; readonly key: string } | null;
}

declare global {
  interface Window {
    __kaijuNudgePulses?: number;
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
    window.__kaijuNudgePulses = 0;
    const seen = new WeakSet<Element>();
    const count = () => {
      document.querySelectorAll('[data-kaiju-learn-nudge="pulse"]').forEach((el) => {
        if (seen.has(el)) return;
        seen.add(el);
        window.__kaijuNudgePulses = (window.__kaijuNudgePulses ?? 0) + 1;
      });
    };
    new MutationObserver(count).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-kaiju-learn-nudge"],
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

const pulses = (page: Page) => page.evaluate(() => window.__kaijuNudgePulses ?? 0);

/** The memory dot shows above this share of the context window (KOBE-840). */
const MEMORY_DOT_MIN_CONTEXT_PERCENT = 30;
/** The context window every team model gets in this spec (the routes below). */
const CONTEXT_WINDOW = 100_000;
const TEAM_MODELS_PATH = /\/v1\/team\/models(\?|$)/;
const USAGE_PATH = /\/v1\/threads\/[^/]+\/usage(\?|$)/;

/** The one model the page is told the team has (shaped like `GET /v1/team/models`, KOBE-44). */
const SPEC_MODEL = "spec-context-model";
const NOW = new Date().toISOString();

/** `GET /v1/team/models` as the server answers it (`TeamModels`, snake_case on the wire). */
function teamModelsBody() {
  return {
    models: [
      {
        alias: SPEC_MODEL,
        provider_id: "spec",
        model: SPEC_MODEL,
        label: "Spec model",
        input_modalities: ["text"],
        gateway_model: `spec/${SPEC_MODEL}`,
        max_output_tokens: null,
        context_window: CONTEXT_WINDOW,
        reasoning: false,
        enabled: true,
        is_default: true,
        created_at: NOW,
        updated_at: NOW,
      },
    ],
    default: SPEC_MODEL,
  };
}

/** `GET /v1/threads/:id/usage` (`ThreadUsage`): no per-run rows, the newest call at `percent`. */
function usageBody(threadId: string, percent: number) {
  return {
    thread_id: threadId,
    runs: [],
    latest_call: {
      run_id: "00000000-0000-4000-8000-000000000840",
      at: NOW,
      model: `spec/${SPEC_MODEL}`,
      input_tokens: Math.round((CONTEXT_WINDOW * percent) / 100),
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    },
  };
}

/**
 * KOBE-840: drives the context use the + button reads, deterministically. The fake model of the
 * gate7 install (and some catalogs) leave the context window blank or report no usage, so the
 * gauge shows no meter and the dot never shows. The page's reads of the team's models and the
 * thread's usage are answered entirely in the browser with synthetic bodies (never `route.fetch`,
 * which runs in Node and misses the browser's host mapping): the team's default model has a
 * `CONTEXT_WINDOW` window and the thread's newest call used `percent()` of it, exactly the figure
 * the context gauge and the + button compute (`contextPercent`). The conversation follows the
 * team default, so runs still use the install's real default model. Only after a reload does the
 * stored call decide (a run streamed in this tab keeps its own figure).
 */
async function driveContextUse(page: Page, percent: () => number): Promise<void> {
  await page.route(TEAM_MODELS_PATH, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({ json: teamModelsBody() });
  });
  await page.route(USAGE_PATH, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const threadId = /\/v1\/threads\/([^/]+)\/usage/.exec(route.request().url())?.[1] ?? "";
    await route.fulfill({ json: usageBody(decodeURIComponent(threadId), percent()) });
  });
}

/** The context meter's figure after a reload: the one the + button reads. */
async function meterPercent(page: Page): Promise<number> {
  const meter = page.getByRole("meter", { name: "Context used" });
  await expect(meter).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  const now = Number(await meter.getAttribute("aria-valuenow"));
  const max = Number(await meter.getAttribute("aria-valuemax"));
  return (now / max) * 100;
}

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
  // KOBE-840: at or below 30% context use no dot (so no pulse) until the figure passes 30%.
  let percent = MEMORY_DOT_MIN_CONTEXT_PERCENT;
  await driveContextUse(page, () => percent);

  await chat.open();
  const plus = page.getByRole("button", { name: "Add to your message", exact: true });
  const dot = plus.locator('[data-kaiju-learn-mark="dot"]');
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

  // No pulse so far: a run's own streamed figure stayed at or below 30% (else the nudge would be
  // claimed already and the 31% step below could not pulse).
  expect(await pulses(page), "no dot while the run's own context figure is low").toBe(0);

  // Exactly 30% (the stored call decides after a reload): the nudge is there, the dot is not.
  let seen = states.length;
  await page.reload();
  await expect(chat.composer).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  expect((await latestAfter(seen)).nudge?.reason).toBe("messages");
  expect(await meterPercent(page)).toBe(MEMORY_DOT_MIN_CONTEXT_PERCENT);
  await expect(plus).toBeVisible();
  await expect(dot).toHaveCount(0);
  await page.waitForTimeout(PULSE_WATCH_MS);
  expect(await pulses(page)).toBe(0);

  // Above 30%: the dot shows and pulses once for the waiting nudge (it was never claimed).
  percent = MEMORY_DOT_MIN_CONTEXT_PERCENT + 1;
  await page.reload();
  await expect(chat.composer).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  expect(await meterPercent(page)).toBe(MEMORY_DOT_MIN_CONTEXT_PERCENT + 1);
  await expect.poll(() => pulses(page), { timeout: PULSE_TIMEOUT_MS }).toBe(1);
  // A hint only: the dot stays, no pass started.
  await expect(dot).toBeVisible();
  await expect(plus).not.toHaveAttribute("data-kaiju-learn-state", "spinner");
  await expect(page.locator("[data-kaiju-learn-notice]")).not.toContainText(
    "Kaiju is learning from this chat",
  );

  // A correction: thumbs down on the last answer; the next read (here a reload) pulses again.
  const down = await chat.messageAction(chat.answers.last(), "Bad answer");
  await down.click();
  await expect(down).toHaveAttribute("aria-pressed", "true");
  seen = states.length;
  await page.reload();
  await expect(chat.composer).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  const corrected = await latestAfter(seen);
  expect(corrected.nudge?.reason).toBe("correction");
  expect(corrected.running).toBeNull();
  await expect.poll(() => pulses(page), { timeout: PULSE_TIMEOUT_MS }).toBe(1);
  await expect(plus).not.toHaveAttribute("data-kaiju-learn-state", "spinner");
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
