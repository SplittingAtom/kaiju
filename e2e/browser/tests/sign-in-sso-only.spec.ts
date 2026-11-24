import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { SHELL_TIMEOUT_MS, STORAGE_STATE } from "./support/constants.js";
import { pageApi } from "./support/gate5.js";
import {
  MOCK,
  ensureProvider,
  expectSignedIn,
  freshBrowser,
  newPerson,
  passwordSignIn,
  signInAs,
  type Provider,
} from "./support/sso.js";

/**
 * KOBE-774: the sign-in page in both modes of the Site setting "Require single sign-on", against
 * the mock identity provider (as `sso.spec.ts`; deployment e2e/sso/gate1-mock-idp.sh).
 *
 * 1. Setting off: the panel has the email and password form, and the server takes a password
 *    sign-in (a wrong password is 401, not `SSO_REQUIRED`).
 * 2. Setting on: the Owner (KOBE_USER) signs in through the mock (linking the account with the
 *    password and a confirmation the first time; the link stays for later runs), turns the setting
 *    on from that SSO session, and a signed-out browser sees only "Sign in with <mock>" and "This
 *    site requires single sign-on": no Email, Password, "Forgot your password?" or passkey; the
 *    server refuses the right password and a reset request (403 `SSO_REQUIRED`). The Owner turns it
 *    off again, and the password form is back.
 *
 * Turning the setting on ends every session not signed in through a provider, the suite's stored
 * one too: run this spec on its own (`npx playwright test sign-in-sso-only`). KOBE_USER must be the
 * Owner, without an authenticator app (the link step signs in with the password only). If a run
 * dies with the setting on, the Owner turns it off in Site console › Single sign-on, or with
 * cluster access: `KOBE_DB_MIGRATE_URL=… kaiju sso allow-local-sign-in`. No model tokens.
 */
const OWNER = process.env["KOBE_USER"] ?? "";
const OWNER_PW = process.env["KOBE_PW"] ?? "";
const SETTINGS = "/v1/site/sso/settings";

test.describe.configure({ mode: "serial" });

let provider: Provider | null = null;
let turnedOn = false;
/** The Owner's SSO session (the stored password session ends with the setting). */
let ownerSso: Page | null = null;

/** A stable mock identity for the Owner, so later runs reuse the link this one made. */
function ownerOid(email: string): string {
  const h = createHash("sha256").update(`kaiju-e2e-owner:${email.toLowerCase()}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

async function signInPage(page: Page) {
  await page.goto("/sign-in");
  const panel = page.getByRole("region", { name: /^Sign in to / });
  await expect(panel).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  return panel;
}

test.beforeAll(async ({ browser }) => {
  if (!MOCK.issuer) return;
  const owner = await (await browser.newContext({ storageState: STORAGE_STATE })).newPage();
  try {
    await owner.goto("/");
    const ensured = await ensureProvider(owner);
    provider = ensured.provider;
    turnedOn = ensured.turnedOn;
  } finally {
    await owner.context().close();
  }
});

test.afterAll(async () => {
  if (!ownerSso) return;
  await pageApi(ownerSso, "PUT", SETTINGS, { requireSso: false });
  if (turnedOn && provider) {
    await pageApi(ownerSso, "PATCH", `/v1/site/sso/providers/${provider.id}`, { enabled: false });
  }
  await ownerSso.context().close();
});

test.beforeEach(() => {
  test.skip(!MOCK.issuer, "KOBE_SSO_MOCK_ISSUER is not set (see e2e/sso/gate1-mock-idp.sh)");
  test.skip(!provider, "The mock provider is not available on this deployment");
  test.skip(!OWNER || !OWNER_PW, "KOBE_USER and KOBE_PW are required");
});

test("setting off: the password form, and the server takes password sign-in", async ({
  browser,
}) => {
  const page = await freshBrowser(browser);
  try {
    const listed = await page.request.get("/api/auth/sso/providers");
    expect(((await listed.json()) as { ssoRequired?: boolean }).ssoRequired).toBe(false);
    const panel = await signInPage(page);
    await expect(panel.getByLabel("Email")).toBeVisible();
    await expect(panel.getByLabel("Password")).toBeVisible();
    await expect(panel.getByRole("link", { name: "Forgot your password?" })).toBeVisible();
    await expect(panel.getByRole("link", { name: `Sign in with ${MOCK.name}` })).toBeVisible();
    const wrong = await page.request.post("/api/auth/sign-in/email", {
      data: { email: OWNER, password: "not the password at all" },
    });
    expect(wrong.status()).toBe(401);
  } finally {
    await page.context().close();
  }
});

test("setting on: only the provider buttons, and the server refuses local sign-in", async ({
  browser,
}) => {
  if (!provider) return;
  const person = newPerson("owner", {
    oid: ownerOid(OWNER),
    upn: OWNER,
    email: OWNER,
    roles: [],
  });
  ownerSso = await freshBrowser(browser);
  await signInAs(ownerSso, person);
  // First run: the address is not linked yet; link it with the Owner's password.
  await ownerSso.waitForURL((url) => url.pathname === "/" || url.searchParams.has("sso_error"), {
    timeout: SHELL_TIMEOUT_MS,
  });
  if (new URL(ownerSso.url()).searchParams.get("sso_error") === "not_allowed") {
    await passwordSignIn(ownerSso, OWNER, OWNER_PW);
    await ownerSso.waitForURL(/\/link-sign-in$/, { timeout: SHELL_TIMEOUT_MS });
    await ownerSso.getByRole("button", { name: `Link ${MOCK.name}` }).click();
    await ownerSso.waitForURL((url) => url.pathname === "/", { timeout: SHELL_TIMEOUT_MS });
    const again = ownerSso;
    ownerSso = await freshBrowser(browser);
    await again.context().close();
    await signInAs(ownerSso, person);
  }
  await expectSignedIn(ownerSso, OWNER.toLowerCase());

  const before = await pageApi<{ canTurnOn?: boolean }>(ownerSso, "GET", SETTINGS);
  expect(before.json.canTurnOn, "the Owner's session came through the mock").toBe(true);
  const on = await pageApi<{ requireSso?: boolean }>(ownerSso, "PUT", SETTINGS, {
    requireSso: true,
  });
  expect(on.status).toBe(200);
  expect(on.json.requireSso).toBe(true);

  const page = await freshBrowser(browser);
  try {
    const panel = await signInPage(page);
    await expect(panel.getByText("This site requires single sign-on")).toBeVisible();
    await expect(panel.getByRole("link", { name: `Sign in with ${MOCK.name}` })).toBeVisible();
    await expect(panel.getByLabel("Email")).toHaveCount(0);
    await expect(panel.getByLabel("Password")).toHaveCount(0);
    await expect(panel.getByRole("link", { name: "Forgot your password?" })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: /passkey/i })).toHaveCount(0);
    await test.info().attach("sign-in-sso-only.png", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });

    const password = await page.request.post("/api/auth/sign-in/email", {
      data: { email: OWNER, password: OWNER_PW },
    });
    expect(password.status()).toBe(403);
    expect(((await password.json()) as { code?: string }).code).toBe("SSO_REQUIRED");
    const reset = await page.request.post("/api/auth/request-password-reset", {
      data: { email: OWNER, redirectTo: "/reset-password" },
    });
    expect(reset.status()).toBe(403);
  } finally {
    await page.context().close();
  }

  const off = await pageApi(ownerSso, "PUT", SETTINGS, { requireSso: false });
  expect(off.status, "the Owner turns it off (else: kaiju sso allow-local-sign-in)").toBe(200);
  const back = await freshBrowser(browser);
  try {
    const panel = await signInPage(back);
    await expect(panel.getByLabel("Password")).toBeVisible();
  } finally {
    await back.context().close();
  }
});
