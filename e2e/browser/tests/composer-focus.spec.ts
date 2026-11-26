import { devices, type Page } from "@playwright/test";
import { expect, test } from "./support/chat.js";
import { SHELL_TIMEOUT_MS } from "./support/constants.js";
import { api } from "./support/tree.js";

/**
 * KOBE-840 ac-4/ac-5: the composer has the focus after the page loads, after New conversation and
 * after a thread is chosen in the Threads panel; on a touch screen the page load leaves it alone
 * (no keyboard). Two empty threads are made over the API (`POST /v1/threads`, no model turn) and
 * moved to Trash at the end. Spends no tokens.
 *
 * The gold edge glow on a pending approval needs a model turn to raise the approval, so it is not
 * here: the state mapping and the rendered `data-kaiju-edge-glow` are unit-tested
 * (lib/chat/edge-glow.test.ts, components/chat/edge-glow.test.tsx, app/edge-glow.test.ts).
 */
async function emptyThread(page: Page, title: string): Promise<string> {
  const res = await api(page, "POST", "/v1/threads", { title });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  const body = res.json as { thread_id?: string; data?: { thread_id?: string } };
  const id = body.data?.thread_id ?? body.thread_id;
  if (!id) throw new Error(`no thread id in ${JSON.stringify(res.json)}`);
  return id;
}

test("the composer takes the focus on load, New conversation and a thread from Threads", async ({
  chat,
  page,
}) => {
  const stamp = Date.now().toString(36);
  await page.goto("/");
  await expect(chat.composer).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  await expect(chat.composer).toBeFocused();

  const first = `kobe-840 first ${stamp}`;
  const second = `kobe-840 second ${stamp}`;
  await emptyThread(page, first);
  await emptyThread(page, second);

  // A thread chosen in the Threads panel: the panel closes onto it, the composer is focused.
  await page.reload();
  await expect(chat.composer).toBeFocused({ timeout: SHELL_TIMEOUT_MS });
  for (const title of [first, second]) {
    const panel = await chat.openThreads();
    await panel.getByRole("button", { name: title, exact: true }).click();
    await expect(chat.threadsPanel).toBeHidden();
    await expect(page.locator("#kaiju-thread-title")).toHaveText(title);
    await chat.threadId(); // remembered: moved to Trash when the test ends
    await expect(chat.composer).toBeFocused();
  }

  // New conversation from the rail's top line.
  await chat.railHeader.getByRole("button", { name: "New conversation", exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("thread")).toBeNull();
  await expect(chat.composer).toBeFocused();

  // Not over a dialog left open: the command palette keeps its own field. While the modal is open
  // the page behind it is hidden from the accessibility tree, so `chat.composer` (a role query)
  // finds nothing there; the check reads `document.activeElement` instead.
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await page.locator("body").press("ControlOrMeta+k");
  await expect(palette).toBeVisible();
  await expect(palette.getByRole("combobox")).toBeFocused();
  // Longer than the composer's two-frame request: the palette's field still has the focus.
  await page.waitForTimeout(500);
  await expect(palette.getByRole("combobox")).toBeFocused();
  expect(
    await page.evaluate(() => document.activeElement?.closest("[data-kaiju-composer]") != null),
    "the composer does not take the focus from the open palette",
  ).toBe(false);
  // Escape closes it and the focus goes back to where it was: the composer.
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
  await expect(chat.composer).toBeFocused();
});

test("a touch screen's page load does not open the keyboard", async ({ browser }) => {
  const storageState = test.info().project.use.storageState;
  const context = await browser.newContext({ ...devices["Pixel 7"], storageState });
  try {
    const page = await context.newPage();
    await page.goto("/");
    const composer = page.getByRole("textbox", { name: "Message", exact: true });
    await expect(composer).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    // Give the composer's two-frame request time to have happened.
    await page.waitForTimeout(500);
    await expect(composer).not.toBeFocused();
  } finally {
    await context.close();
  }
});
