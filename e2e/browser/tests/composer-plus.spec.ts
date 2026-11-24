import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./support/chat.js";

/**
 * KOBE-451 ac-5. The composer's + menu on gate1: its items; a connector turned off for this
 * thread stays off across two runs and a reload, then back on (the server keeps it); a broken
 * connector's red ✕ with its reason (skipped when every connector works); a picked skill shown as
 * a chip, sent with the message and shown in the history (skipped when no skill is available).
 * Light and dark screenshots of the menu are attached. Spends up to three short model turns.
 */
const PROMPT = "No tools. Reply with the single word ALPHA.";
const TEAM_KEY = "kobe.lastTeamId";

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

async function openPlus(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Add to your message", exact: true }).click();
  const menu = page.locator("[data-kaiju-plus-menu]");
  await expect(menu).toBeVisible();
  return menu;
}

async function openSub(page: Page, name: string): Promise<Locator> {
  const menu = await openPlus(page);
  await menu.getByRole("menuitem", { name: new RegExp(`^${name}`) }).hover();
  const sub = page.getByRole("menu", { name, exact: true });
  await expect(sub).toBeVisible();
  return sub;
}

/** The thread's connectors as the server stores them (the page's own session and team). */
async function serverConnectors(page: Page, threadId: string) {
  return page.evaluate(
    async ({ id, teamKey }) => {
      const team = window.localStorage.getItem(teamKey);
      const res = await fetch(`/v1/threads/${encodeURIComponent(id)}/connectors`, {
        headers: team ? { "x-kobe-team": team } : {},
      });
      return ((await res.json()) as { connectors: { connector_id: string; enabled: boolean }[] })
        .connectors;
    },
    { id: threadId, teamKey: TEAM_KEY },
  );
}

test("the + menu: its items, a broken connector, a toggle across two runs (ac-1..3, ac-5, ac-6)", async ({
  chat,
  page,
}) => {
  await chat.open();
  await expect(page.getByRole("button", { name: "Attach files", exact: true })).toHaveCount(0);
  const menu = await openPlus(page);
  for (const item of ["Attach files", "Connectors", "Memory", "Skills", "Apps"]) {
    await expect(menu.getByRole("menuitem", { name: new RegExp(`^${item}`) })).toBeVisible();
  }
  await shoot(page, "composer-plus-menu", menu);
  // Memory is a submenu (KOBE-395); before the first message its Learn items are disabled with
  // the reason beside them.
  const memory = menu.getByRole("menuitem", { name: /^Memory/ });
  await expect(memory).toHaveAttribute("aria-haspopup", "menu");
  await memory.hover();
  const memorySub = page.getByRole("menu", { name: "Memory", exact: true });
  await expect(memorySub).toBeVisible();
  for (const item of [/^Learn from this chat/, /^Rescan the whole chat/]) {
    const learnItem = memorySub.getByRole("menuitem", { name: item });
    await expect(learnItem).toHaveAttribute("aria-disabled", "true");
    await expect(learnItem).toContainText("Send a message first.");
  }
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();

  const threadId = await chat.ask(PROMPT);
  await chat.waitForIdle();
  const sub = await openSub(page, "Connectors");
  await expect(sub.getByText("Loading…")).toHaveCount(0);
  const broken = sub.locator("[data-kaiju-connector-problem]");
  if ((await broken.count()) > 0) {
    await expect(broken.first().getByLabel("Not working")).toBeVisible();
    await shoot(page, "composer-plus-broken", sub);
  }
  const toggle = sub.getByRole("menuitemcheckbox").first();
  test.skip((await toggle.count()) === 0, "no working connector for this member");
  const id = (await toggle.getAttribute("data-kaiju-connector")) ?? "";
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");

  // Two runs with it off: the server keeps the choice for this thread.
  for (let i = 0; i < 2; i++) {
    await chat.ask(PROMPT);
    await chat.waitForIdle();
    expect(
      (await serverConnectors(page, threadId)).find((c) => c.connector_id === id)?.enabled,
    ).toBe(false);
  }
  await page.reload();
  const again = await openSub(page, "Connectors");
  const same = again.locator(`[data-kaiju-connector="${id}"]`);
  await expect(same).toHaveAttribute("aria-checked", "false");
  await same.click();
  await expect(same).toHaveAttribute("aria-checked", "true");
  expect((await serverConnectors(page, threadId)).find((c) => c.connector_id === id)?.enabled).toBe(
    true,
  );
});

test("the + menu: a picked skill is a chip, goes with the message and shows in the history (ac-4, ac-5)", async ({
  chat,
  page,
}) => {
  await chat.open();
  const sub = await openSub(page, "Skills");
  await expect(sub.getByText("Loading…")).toHaveCount(0);
  const first = sub.locator("[data-kaiju-skill]").first();
  test.skip((await first.count()) === 0, "no skill available to this member and agent");
  const name = (await first.getAttribute("data-kaiju-skill")) ?? "";
  await first.click();
  await expect(page.locator(`[data-kaiju-skill-chip="${name}"]`)).toBeVisible();
  await chat.ask("No tools. Reply with the single word ALPHA.");
  await chat.waitForIdle();
  await expect(page.locator("[data-kaiju-skill-chip]")).toHaveCount(0);
  await expect(chat.userMessages.last().locator(`[data-kaiju-sent-skill="${name}"]`)).toBeVisible();
});

test("the + menu: a connector turned off before the first message is off in the new thread (review MEDIUM-3)", async ({
  chat,
  page,
}) => {
  await chat.open();
  const sub = await openSub(page, "Connectors");
  await expect(sub.getByText("Loading…")).toHaveCount(0);
  const toggle = sub.getByRole("menuitemcheckbox").first();
  test.skip((await toggle.count()) === 0, "no working connector for this member");
  const id = (await toggle.getAttribute("data-kaiju-connector")) ?? "";
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");
  const threadId = await chat.ask(PROMPT);
  await chat.waitForIdle();
  expect((await serverConnectors(page, threadId)).find((c) => c.connector_id === id)?.enabled).toBe(
    false,
  );
});
