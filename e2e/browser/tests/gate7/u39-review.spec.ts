import { expect, test } from "../support/chat.js";
import { SHELL_TIMEOUT_MS } from "../support/constants.js";
import { FAKE_MODEL, memoriesWith } from "../support/gate7.js";
import { panelOf } from "../support/panel.js";
import { uniqueWords } from "../support/unique.js";

/**
 * Gate 7, U39 and U40 (KOBE-675): "composer learn (/learn, Mod+Shift+L) for the thread author; a
 * pass returns candidates in To review with verified quotes; nothing saved without a click" and
 * "user saves apply with chip + Undo". The + menu, `/learn` and the shortcut sheet are
 * learn-from-chat.spec.ts; here Mod+Shift+L starts the pass from the composer, To review opens by
 * itself with the candidate and the person's own words as its quote, nothing is saved until Save,
 * Save says "Memory saved." with Undo, and Undo takes it back (read through the memories API).
 * With the fake model the extractor turns the message's "I prefer …" into the candidate.
 */
const PASS_TIMEOUT_MS = 180_000;

test("U39/U40: Mod+Shift+L learns; the quote; nothing saved until Save; Save and Undo", async ({
  chat,
  page,
}) => {
  test.skip(!FAKE_MODEL, "scripted by the fake model's extractor (KAIJU_FAKE_MODEL=1)");
  const words = uniqueWords();
  const what = `gate seven ${words} reports as one page documents`;
  await chat.open();
  await chat.ask(`No tools. Reply with the single word OK. I prefer ${what}.`);
  await chat.composer.click();
  await page.keyboard.press("ControlOrMeta+Shift+L");

  // The pass found the preference: To review opens by itself over the chat (KOBE-396).
  const panel = panelOf(page);
  await expect(panel).toBeVisible({ timeout: PASS_TIMEOUT_MS });
  await expect(page).toHaveURL(/\/me\/memory\?review=1/);
  const card = panel
    .getByRole("list", { name: "Candidates" })
    .locator(":scope > li")
    .filter({ hasText: words });
  await expect(card).toHaveCount(1, { timeout: SHELL_TIMEOUT_MS });
  await expect(card).toContainText(`Prefers ${what}`);
  await expect(card, "the quote is the person's own words").toContainText(`I prefer ${what}`);
  expect(await memoriesWith(page, "user", words), "nothing saved before a click").toBe(0);

  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect(panel.getByText("Memory saved.", { exact: true })).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  await expect.poll(() => memoriesWith(page, "user", words)).toBe(1);
  await panel.getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => memoriesWith(page, "user", words), { timeout: SHELL_TIMEOUT_MS }).toBe(0);
});
