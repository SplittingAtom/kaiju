import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./support/chat.js";
import { panelOf } from "./support/panel.js";

/**
 * KOBE-395 (SM12, Q8): Learn from this chat on gate1. After one short answer the composer's + menu
 * has Memory › Learn from this chat and Rescan the whole chat, each either ready or disabled with
 * the reason (the switches, the learning model or the budget decide on the install). When Learn
 * can run, it starts a pass: the + shows the spinner, and the pass ends with what it found or why
 * it stopped; when it found something, To review opens by itself over the chat (KOBE-396, KOBE-661). `/learn` is offered in the / menu and the ? sheet lists Mod+Shift+L. Light and dark
 * screenshots of the Memory submenu are attached. Spends one short model turn and at most one
 * learning pass.
 */
const PASS_TIMEOUT_MS = 180_000;

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

async function openMemory(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Add to your message", exact: true }).click();
  const menu = page.locator("[data-kobe-plus-menu]");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: /^Memory/ }).hover();
  const sub = page.locator("[data-kobe-memory-menu]");
  await expect(sub).toBeVisible();
  return sub;
}

test("Learn from this chat in the + menu, /learn and the ? sheet", async ({ chat, page }) => {
  await chat.open();
  await chat.ask("No tools. Reply with the single word ALPHA. I prefer metric units.");
  await chat.waitForIdle();

  const sub = await openMemory(page);
  const learn = sub.getByRole("menuitem", { name: /^Learn from this chat/ });
  const rescan = sub.getByRole("menuitem", { name: /^Rescan the whole chat/ });
  await expect(learn).toBeVisible();
  await expect(rescan).toBeVisible();
  await shoot(page, "learn-memory-menu", sub);

  const plus = page.getByRole("button", { name: "Add to your message", exact: true });
  if ((await learn.getAttribute("aria-disabled")) === "true") {
    // Unavailable on this install: the item says why, and nothing starts.
    await expect(learn).not.toHaveText(/^Learn from this chat$/);
    test.info().annotations.push({ type: "learn", description: (await learn.textContent()) ?? "" });
    await page.keyboard.press("Escape");
  } else {
    await learn.click();
    await expect(plus).toHaveAttribute("data-kobe-learn-state", "spinner");
    const notice = page.locator("[data-kobe-learn-notice]");
    await expect(notice).toContainText("Kobe is learning from this chat");
    // The pass ends one of two ways (KOBE-661). Candidates found while this chat is on screen open
    // To review by itself (KOBE-396): a modal panel, the chat inert behind it, so the + leaves the
    // accessibility tree. Otherwise the + settles and the notice says how it went.
    const panel = panelOf(page);
    await expect(async () => {
      if (await panel.isVisible()) return;
      expect(await plus.getAttribute("data-kobe-learn-state", { timeout: 1_000 })).not.toBe(
        "spinner",
      );
    }).toPass({ timeout: PASS_TIMEOUT_MS });
    if (await panel.isVisible()) {
      await expect(page).toHaveURL(/\/me\/memory\?review=1/);
      await panel
        .getByRole("button", { name: /^Close / })
        .first()
        .click();
      await expect(panel).toBeHidden();
      await expect(plus).toHaveAttribute("data-kobe-learn-state", "count");
    } else {
      await expect(notice).toHaveText(/Kobe found|Try again|budget|turned off|isn't enabled/);
    }
  }

  // The / menu offers /learn.
  await chat.composer.click();
  await chat.composer.pressSequentially("/lea");
  await expect(
    page.getByRole("option", { name: /^\/learn range, Learn from this chat/ }),
  ).toBeVisible();
  await chat.composer.press("Escape");
  await chat.composer.fill("");

  // The ? sheet lists Mod+Shift+L under Memory.
  await chat.answers.last().click();
  await page.keyboard.press("?");
  const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(sheet.getByRole("list", { name: "Memory shortcuts" })).toContainText(
    "Learn from this chat",
  );
  await page.keyboard.press("Escape");
});
