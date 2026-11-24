import { expect, test } from "@playwright/test";
import { SHELL_TIMEOUT_MS } from "./support/constants.js";
import { panelOf } from "./support/panel.js";

/**
 * KOBE-835: connecting an OAuth connector from My connectors, end to end in a real browser. Needs
 * `KOBE_OAUTH_CONNECTOR`: the name of an OAuth connector enabled for `KOBE_USER`'s active
 * workspace whose authorization server consents without a login page, such as the e2e fake
 * (`e2e/lib/fake-oauth-mcp.js`, KOBE-232) served where both the browser and the cluster reach it.
 * Skipped without it: the suite has no such server of its own, and a real provider (Massive) needs
 * a person to sign in. Spends no model tokens. Run: `npx playwright test connector-oauth`.
 */
const NAME = process.env["KOBE_OAUTH_CONNECTOR"];

test.skip(!NAME, "KOBE_OAUTH_CONNECTOR names no OAuth connector with a consent-at-once server");

test("My connectors: Connect signs in at the service, comes back connected, and Disconnect", async ({
  page,
}) => {
  const name = NAME ?? "";
  await page.goto("/me/connectors");
  const panel = panelOf(page);
  const card = panel.getByRole("article", { name });
  await expect(card).toBeVisible({ timeout: SHELL_TIMEOUT_MS });

  const connect = card.getByRole("button", { name: new RegExp(`^(Re)?[Cc]onnect ${name}$`) });
  const started = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/oauth/start"),
  );
  await connect.click();
  const start = await started;
  expect(start.status()).toBe(200);
  // The start answer carries the authorization URL only: never a token, code or verifier.
  expect(Object.keys((await start.json()) as object)).toEqual(["authorization_url"]);

  // The fake authorization server consents at once and sends the browser to the callback, which
  // brings it back to My connectors with the result; the page then clears the address.
  await page.waitForURL(/\/me\/connectors/, { timeout: SHELL_TIMEOUT_MS });
  await expect(panel.getByText(`Connected your account to ${name}.`)).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  await expect.poll(() => new URL(page.url()).search).toBe("");
  await expect(card.getByText("Connected", { exact: true })).toBeVisible();

  await card.getByRole("button", { name: `Disconnect ${name}` }).click();
  const confirm = page.getByRole("alertdialog", {
    name: `Disconnect your account from ${name}?`,
  });
  await confirm.getByRole("button", { name: "Disconnect" }).click();
  await expect(card.getByText("Not connected")).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
});
