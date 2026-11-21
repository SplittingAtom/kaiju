import { expect, test, type Browser, type Page } from "@playwright/test";
import { SHELL_TIMEOUT_MS } from "./support/constants.js";

/**
 * KOBE-755: the themed sign-in page on a deployment, signed out. One panel centred on the page in
 * the Site's theme (light and dark from the browser's preference), usable at 360 px; email,
 * password, Sign in and "Forgot your password?" first, then an "or" divider with one button per
 * enabled identity provider (for example Microsoft Entra ID) in the server's order and the passkey
 * button; a password sign-in still works. Screenshots of both schemes are attached to the report.
 * Needs KOBE_USER / KOBE_PW. No model tokens. Run: `npx playwright test sign-in-page`.
 */
type Scheme = "light" | "dark";

async function signedOut(
  browser: Browser,
  colorScheme: Scheme,
  viewport = { width: 1280, height: 800 },
): Promise<Page> {
  const context = await browser.newContext({
    storageState: undefined,
    colorScheme,
    viewport,
    ignoreHTTPSErrors: true,
  });
  return context.newPage();
}

const panelOf = (page: Page) => page.getByRole("region", { name: /^Sign in to / });

/** The page background's relative luminance (0 black … 1 white). */
async function backgroundLuminance(page: Page): Promise<number> {
  return page.locator("[data-auth-page]").evaluate((el) => {
    const probe = document.createElement("canvas").getContext("2d");
    if (!probe) return -1;
    probe.fillStyle = getComputedStyle(el).backgroundColor;
    probe.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0] = probe.getImageData(0, 0, 1, 1).data;
    const lin = (c: number) => {
      const s = c / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  });
}

async function top(page: Page, locator: ReturnType<Page["locator"]>): Promise<number> {
  const box = await locator.boundingBox();
  expect(box, "on screen").not.toBeNull();
  return box?.y ?? 0;
}

for (const scheme of ["light", "dark"] as const) {
  test(`sign-in page in the ${scheme} theme: one centred panel, the order of ac-3`, async ({
    browser,
  }) => {
    const page = await signedOut(browser, scheme);
    try {
      await page.goto("/sign-in");
      const panel = panelOf(page);
      await expect(panel).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
      // The browser's preference picks the scheme before any member preference exists.
      const luminance = await backgroundLuminance(page);
      if (scheme === "dark") expect(luminance).toBeLessThan(0.2);
      else expect(luminance).toBeGreaterThan(0.5);

      const box = await panel.boundingBox();
      expect(box).not.toBeNull();
      if (box) {
        expect(box.width).toBeLessThanOrEqual(400);
        expect(Math.abs(box.x + box.width / 2 - 640)).toBeLessThanOrEqual(2);
        expect(Math.abs(box.y + box.height / 2 - 400)).toBeLessThanOrEqual(2);
      }

      const email = panel.getByLabel("Email");
      const password = panel.getByLabel("Password");
      const submit = panel.getByRole("button", { name: "Sign in", exact: true });
      const forgot = panel.getByRole("link", { name: "Forgot your password?" });
      await expect(email).toHaveAttribute("autocomplete", "username webauthn");
      await expect(password).toHaveAttribute("autocomplete", "current-password");
      const tops = [
        await top(page, email),
        await top(page, password),
        await top(page, submit),
        await top(page, forgot),
      ];
      expect([...tops].sort((a, b) => a - b)).toEqual(tops);

      // The enabled providers, as the server lists them, follow the divider in that order.
      const listed = await page.request.get("/api/auth/sso/providers");
      const providers = listed.ok()
        ? (((await listed.json()) as { providers?: { displayName: string }[] }).providers ?? [])
        : [];
      const alternatives = panel.getByRole("group", { name: "Other ways to sign in" });
      const passkey = alternatives.getByRole("button", { name: "Sign in with a passkey" });
      await expect(passkey).toBeVisible(); // Chromium supports passkeys
      const divider = page.locator("[data-auth-divider]");
      await expect(divider).toBeVisible();
      expect(await top(page, divider)).toBeGreaterThan(tops[3] ?? 0);
      const buttons = alternatives.getByRole("list", { name: "Single sign-on" }).getByRole("link");
      await expect(buttons).toHaveCount(providers.length);
      for (const [i, p] of providers.entries()) {
        const button = buttons.nth(i);
        await expect(button).toHaveText(`Sign in with ${p.displayName}`);
        const b = await button.boundingBox();
        const own = await alternatives.boundingBox();
        if (b && own) expect(Math.abs(b.width - own.width)).toBeLessThanOrEqual(1); // full width
      }
      const entra = providers.find((p) => /entra/i.test(p.displayName));
      if (entra) await expect(buttons.filter({ hasText: entra.displayName })).toBeVisible();

      // Keyboard order runs top to bottom, with a visible focus ring.
      await email.focus();
      await page.keyboard.press("Tab");
      await expect(password).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(submit).toBeFocused();
      const outline = await submit.evaluate((el) => getComputedStyle(el).outlineStyle);
      expect(outline).not.toBe("none");

      await test.info().attach(`sign-in-${scheme}.png`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: "image/png",
      });
    } finally {
      await page.context().close();
    }
  });
}

test("sign-in page at 360 px: the panel fits with a 16 px gutter, no sideways scroll", async ({
  browser,
}) => {
  const page = await signedOut(browser, "light", { width: 360, height: 740 });
  try {
    await page.goto("/sign-in");
    const panel = panelOf(page);
    await expect(panel).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    const box = await panel.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      expect(box.x).toBeGreaterThanOrEqual(15.5);
      expect(box.x + box.width).toBeLessThanOrEqual(344.5);
    }
    const sideways = await page
      .locator("[data-auth-page]")
      .evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(sideways).toBe(false);
    await test.info().attach("sign-in-360.png", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
  } finally {
    await page.context().close();
  }
});

test("password sign-in from the themed page lands in the app", async ({ browser }) => {
  const user = process.env["KOBE_USER"];
  const password = process.env["KOBE_PW"];
  test.skip(!user || !password, "KOBE_USER and KOBE_PW are required");
  const page = await signedOut(browser, "dark");
  try {
    await page.goto("/sign-in");
    const panel = panelOf(page);
    await panel.getByLabel("Email").fill(user ?? "");
    await panel.getByLabel("Password").fill(password ?? "");
    await panel.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), {
      timeout: SHELL_TIMEOUT_MS,
    });
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible({
      timeout: SHELL_TIMEOUT_MS,
    });
  } finally {
    await page.context().close();
  }
});

test("a failed SSO sign-in's message shows inside the panel", async ({ browser }) => {
  const page = await signedOut(browser, "light");
  try {
    await page.goto("/sign-in?sso_error=state_invalid");
    const panel = panelOf(page);
    await expect(panel.getByRole("alert")).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await expect(panel.getByLabel("Email")).toBeVisible();
  } finally {
    await page.context().close();
  }
});
