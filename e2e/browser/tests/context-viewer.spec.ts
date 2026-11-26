import type { Locator } from "@playwright/test";
import { expect, test } from "./support/chat.js";
import { RUN_TIMEOUT_MS } from "./support/constants.js";
import { styleViolations, watchStyleViolations } from "./support/csp.js";

/**
 * KOBE-471 (spec docs/specs/context-viewer.md, route KOBE-470): after one model turn the context
 * gauge under the composer opens the context viewer over the workspace: labelled sections of raw
 * text, a stacked gauge with segments and a legend; a legend row filters the text to its kind;
 * Escape closes it and focus returns to the gauge. No style-src CSP violation. Run with
 * KAIJU_TEAM=team1. KOBE-841 adds the Memory row, Formatted/Raw (remembered), collapse and
 * Download to the same turn (the context needs a model call, so the spec cannot do without one).
 * KOBE-846 checks the three columns (text, full-height gauge, rail with totals then stats), free
 * space at the gauge's bottom, and the stacked order at phone width.
 */
test("context viewer: open from the gauge, sections and gauge, legend filters, Escape closes", async ({
  chat,
  page,
}) => {
  await chat.open();
  await watchStyleViolations(page);
  await chat.ask("No tools. Name three colours of the rainbow, one word each.");
  const meter = page.getByRole("meter", { name: "Context used" });
  await expect(meter).toBeVisible({ timeout: 60_000 });
  await expect(meter).toHaveAttribute("aria-haspopup", "dialog");

  await meter.click();
  const dialog = page.getByRole("dialog", { name: "Context" });
  await expect(dialog).toBeVisible();
  // The rest of the workspace is inert behind it.
  const chatInert = () =>
    page.evaluate(() => document.getElementById("kaiju-chat-main")?.closest("[inert]") != null);
  expect(await chatInert()).toBe(true);
  await expect(page.locator("[data-kaiju-panel='context-viewer']")).toBeVisible();

  // Read live from the sandbox (it may wake first): labelled sections render as text.
  const text = dialog.getByRole("region", { name: "Context text" });
  await expect(text.getByText(/^System prompt · /).first()).toBeVisible({
    timeout: RUN_TIMEOUT_MS,
  });

  // The gauge: one segment per kind present, the legend with tokens and shares.
  expect(await dialog.locator("[data-context-segment]").count()).toBeGreaterThan(1);
  const legend = dialog.getByRole("list", { name: "Context by kind" });
  await expect(legend.getByRole("listitem").first()).toContainText(/tokens.*%/);

  // KOBE-846: three columns. The gauge is an image with a text equivalent, a full-height
  // vertical bar between the text and the rail; the rail holds the totals then the stats.
  const gauge = dialog.getByRole("img", { name: /^Context window: / });
  const rail = dialog.getByRole("region", { name: "Totals and stats" });
  await expect(rail.getByRole("list", { name: "Context by kind" })).toBeVisible();
  await expect(rail.getByRole("region", { name: "Conversation stats" })).toBeVisible();
  const box = async (l: Locator) => {
    const b = await l.boundingBox();
    expect(b).not.toBeNull();
    return b as NonNullable<typeof b>;
  };
  const [textBox, gaugeBox, railBox, columnsBox] = await Promise.all([
    box(text),
    box(gauge),
    box(rail),
    box(dialog.locator("[data-context-columns]")),
  ]);
  expect(gaugeBox.x).toBeGreaterThanOrEqual(textBox.x + textBox.width);
  expect(railBox.x).toBeGreaterThanOrEqual(gaugeBox.x + gaugeBox.width);
  expect(gaugeBox.height).toBeGreaterThan(gaugeBox.width * 4);
  expect(gaugeBox.height).toBeGreaterThan(columnsBox.height * 0.95);
  // Segments follow the totals' order top to bottom; free space, when there is any, is last.
  const segments = await dialog
    .locator("[data-context-bar] [data-context-segment]")
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-context-segment")));
  const listed = await legend
    .locator("[data-context-legend]")
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-context-legend")));
  expect(listed.filter((k) => segments.includes(k))).toEqual(segments);
  const free = dialog.locator("[data-context-segment-free]");
  if ((await free.count()) > 0) {
    const freeBox = await box(free);
    expect(freeBox.y + freeBox.height).toBeGreaterThan(gaugeBox.y + gaugeBox.height - 3);
  }

  // The prompt comes after the system prompt and the tool definitions, out of view: its legend
  // row filters the text to the prompts (KOBE-841) and marks the first.
  const prompts = legend.locator("[data-context-legend='user_message']");
  await prompts.click();
  await expect(prompts).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.locator("[data-context-segment='user_message']")).toHaveAttribute(
    "data-selected",
    "true",
  );
  await expect(text.locator("[data-active]")).toBeVisible();
  await expect(text.locator("[data-active]")).toHaveText(/^User prompt · /);
  await expect(text.getByText(/^System prompt · /)).toHaveCount(0);

  // Search marks a match.
  await dialog.getByRole("searchbox", { name: "Search the context" }).fill("rainbow");
  await expect(dialog.getByRole("status").filter({ hasText: /of \d+/ })).toBeVisible();
  await expect(text.locator("mark").first()).toBeVisible();

  await dialog.getByRole("searchbox", { name: "Search the context" }).fill("");
  await dialog.getByRole("button", { name: "Clear filter" }).click();
  await expect(prompts).toHaveAttribute("aria-pressed", "false");
  await expect(text.getByText(/^System prompt · /).first()).toBeVisible();

  // KOBE-841: Memory is always in the legend, with its tokens.
  await expect(legend.locator("[data-context-legend='memory']")).toContainText(/Memory.*tokens/);

  // Formatted (the default) and Raw (exactly as sent), remembered per browser.
  await dialog.getByRole("button", { name: "Raw" }).click();
  await expect(text).toHaveAttribute("data-context-view", "raw");
  expect(await page.evaluate(() => localStorage.getItem("kaiju.contextViewer.view"))).toBe("raw");
  await dialog.getByRole("button", { name: "Formatted" }).click();
  await expect(text).toHaveAttribute("data-context-view", "formatted");

  // Collapse all leaves the headings only; Expand all brings the text back.
  await dialog.getByRole("button", { name: "Collapse all" }).click();
  await expect(text.locator("[aria-expanded='true']")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Expand all" }).click();
  await expect(text.locator("[aria-expanded='false']")).toHaveCount(0);

  // Download saves the context as text, named by the conversation and the time.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    dialog.getByRole("button", { name: "Download the context" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^kaiju-context-[0-9a-f-]{36}-[\dTZ-]+\.txt$/);

  // KOBE-846: at phone width the columns stack: the gauge (horizontal) on top, the totals, the
  // stats, then the text; nothing is wider than the panel.
  const wide = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(async () => {
    const [g, l, s, t] = await Promise.all([
      box(gauge),
      box(legend),
      box(rail.getByRole("region", { name: "Conversation stats" })),
      box(text),
    ]);
    expect(g.width).toBeGreaterThan(g.height * 4);
    expect(l.y).toBeGreaterThanOrEqual(g.y + g.height);
    expect(s.y).toBeGreaterThanOrEqual(l.y + l.height);
    expect(t.y).toBeGreaterThanOrEqual(s.y + s.height);
    for (const b of [g, l, s, t]) expect(b.x + b.width).toBeLessThanOrEqual(390);
  }).toPass();
  if (wide !== null) await page.setViewportSize(wide);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(meter).toBeFocused();
  expect(await styleViolations(page)).toEqual([]);
});
