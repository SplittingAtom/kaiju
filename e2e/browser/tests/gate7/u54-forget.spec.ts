import { expect, test } from "../support/chat.js";
import { SHELL_TIMEOUT_MS } from "../support/constants.js";
import { FAKE_MODEL, memoriesInContext } from "../support/gate7.js";
import { panelOf } from "../support/panel.js";

/**
 * Gate 7, U54 (KOBE-675): "'forget X' yields an Open in Memory chip; one click archives with Undo;
 * the next run no longer receives it." e2e/gate7.sh pins one memory for KOBE_USER (so every run is
 * given it) and passes its id and text. The agent shows it with `show_memory_item` (with the fake
 * model, `tool: show_memory_item {...}`; a real model calls it when asked to forget): the chip
 * appears under the call, Open in Memory opens it on My memory, Archive archives it with Undo,
 * Undo brings it back, Archive again, and the thread's next run is not given it.
 */
const ITEM = process.env["KOBE_GATE7_FORGET_ITEM"] ?? "";
const TEXT = process.env["KOBE_GATE7_FORGET_TEXT"] ?? "";

test("U54: Open in Memory, Archive with Undo, and the next run no longer gets it", async ({
  chat,
  page,
}) => {
  test.skip(!FAKE_MODEL || !ITEM || !TEXT, "needs the fake model and e2e/gate7.sh's pinned memory");
  await chat.open();
  const threadId = await chat.ask(`tool: show_memory_item {"id":"${ITEM}"}`);
  expect(await memoriesInContext(page, threadId)).toContain(ITEM);
  const chip = page.locator(`[data-kaiju-memory-item="${ITEM}"]`);
  await expect(chip).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  await chip
    .getByRole("link", { name: "Open in Memory" })
    .or(chip.getByRole("button", { name: "Open in Memory" }))
    .click();

  const panel = panelOf(page);
  const opened = panel.getByRole("region", { name: "Opened from a conversation" });
  await expect(opened.getByRole("list", { name: "Opened memory" })).toContainText(TEXT, {
    timeout: SHELL_TIMEOUT_MS,
  });
  await opened.getByRole("button", { name: `Archive: ${TEXT}` }).click();
  await expect(panel.getByText("Archived.", { exact: true })).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  await panel.getByRole("button", { name: "Undo" }).click();
  await expect(panel.getByText("Undone.", { exact: true })).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  await opened.getByRole("button", { name: `Archive: ${TEXT}` }).click();
  await expect(panel.getByText("Archived.", { exact: true })).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });

  await page.goto(`/?thread=${threadId}`);
  await expect(chat.answers.first()).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  await chat.ask("No tools. Reply with the single word OK.");
  await expect
    .poll(() => memoriesInContext(page, threadId), { timeout: SHELL_TIMEOUT_MS })
    .not.toContain(ITEM);
});
