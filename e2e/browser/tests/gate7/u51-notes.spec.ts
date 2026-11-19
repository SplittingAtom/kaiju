import { expect, test } from "../support/chat.js";
import { SHELL_TIMEOUT_MS } from "../support/constants.js";

/**
 * Gate 7, U51 (KOBE-675): "Notes, remember and recall(path) unchanged inside the Notes tab; one bar
 * icon and /memory remain; release notes cover the master-switch widening." remember and
 * recall(path) run in e2e/gate7.sh (API). Here: one My memory icon in the bar opens My memory
 * with its Memories and Notes tabs (the Notes tab loads without an error), the / menu still offers
 * /memory, and the guide (served at /docs) says that turning memory off now turns memories off too,
 * on the Memory page and on What's new, the user-facing release notes (KOBE-678; the operator notes
 * are docs/releases/v1.3.md). Spends one short model turn.
 */
test("U51: one bar icon, the Notes tab, /memory and the guide's master-switch note", async ({
  chat,
  page,
}) => {
  await chat.open();
  await chat.ask("No tools. Reply with the single word NOTES.");
  const icons = page.locator('[data-command="my-memory"]');
  await expect(icons).toHaveCount(1);
  await icons.click();
  const panel = page.getByRole("dialog", { name: "My memory" });
  await expect(panel).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  await expect(panel.getByRole("tab", { name: "Memories" })).toBeVisible();
  const notes = panel.getByRole("tab", { name: "Notes" });
  await notes.click();
  await expect(notes).toHaveAttribute("aria-selected", "true");
  await expect(panel.getByRole("tabpanel")).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);

  await chat.composer.click();
  await chat.composer.pressSequentially("/mem");
  await expect(page.getByRole("option", { name: /^\/memory\b/ })).toBeVisible();
  await chat.composer.press("Escape");
  await chat.composer.fill("");

  const served = (path: string) =>
    page.evaluate(async (p) => {
      const res = await fetch(p);
      return res.ok ? await res.text() : `status ${res.status}`;
    }, path);
  // The Markdown wraps lines: compare with whitespace collapsed.
  const guide = await served("/docs/memory.md");
  expect(guide.replace(/\s+/g, " ")).toContain(
    "Turning **Allow memory** off now also turns memories off",
  );
  const whatsNew = await served("/docs/whats-new.md");
  expect(whatsNew.replace(/\s+/g, " ")).toContain(
    "Turning Allow memory off now turns memories off too.",
  );
});
