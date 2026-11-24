import { expect, test, type Page, type Route } from "@playwright/test";
import { SHELL_TIMEOUT_MS } from "./support/constants.js";
import { panelOf } from "./support/panel.js";

/**
 * KOBE-761 (spec docs/specs/workspace-git.md §7): the Git section of the Workspace admin console
 * and the members' read-only view, in a real browser against a deployment. `KOBE_USER` must be a
 * Workspace admin of the active team (`KOBE_TEAM` pins it).
 *
 * Self-contained: no git host is needed. The first two tests answer `/v1/team/git/connections*`
 * in the browser with a fake (Playwright `page.route`), so they check the page, the three-step
 * Connect dialog, focus, the live test result and that the credential is sent once in a request
 * body and never shown, in the deployment's real shell and theme. Nothing is stored. The third
 * test runs "Test" (test without saving) against a real host only when `KOBE_GIT_PROVIDER`
 * (github, gitea or forgejo), `KOBE_GIT_ORG`, `KOBE_GIT_TOKEN` and, for Gitea/Forgejo or GitHub
 * Enterprise Server, `KOBE_GIT_BASE_URL` are set; it is skipped otherwise. It saves nothing.
 * Spends no model tokens: `npx playwright test git-section`.
 */
const BASE = "**/v1/team/git/connections";
const FAKE_TOKEN = "github_pat_e2eFAKEfakeFAKE0123456789";
const ID = "11111111-1111-4111-8111-111111111111";

const connection = {
  id: ID,
  provider: "github",
  base_url: "https://github.com",
  organization: "acme-e2e",
  display_name: "acme-e2e on GitHub",
  access_level: "read",
  credential: {
    kind: "access_token",
    hint: "••••6789",
    github_app_id: null,
    github_installation_id: null,
    updated_at: "2026-11-20T10:00:00.000Z",
    expires_at: "2026-11-30T10:00:00.000Z",
    expires_soon: true,
  },
  repo_defaults: { visibility: "private", name_prefix: "", default_branch: "main" },
  push_limit_bytes: 1073741824,
  direct_commits: false,
  agent_ids: null,
  capabilities: { create: "unknown", read: "yes", write: "unknown", admin: "unknown" },
  excess_permissions: [],
  health: {
    status: "ok",
    last_checked_at: "2026-11-22T09:00:00.000Z",
    last_ok_at: "2026-11-22T09:00:00.000Z",
    last_error: null,
  },
  created_by: "33333333-3333-4333-8333-333333333333",
  updated_by: null,
  created_at: "2026-11-20T10:00:00.000Z",
  updated_at: "2026-11-20T10:00:00.000Z",
};

const report = {
  ok: true,
  provider: "github",
  organization: { login: "acme-e2e", name: null, kind: "organization" },
  host_version: null,
  actor: { kind: "token", login: "octo-e2e" },
  capabilities: { create: "unknown", read: "yes", write: "unknown", admin: "unknown" },
  excess_permissions: [],
  credential_expires_at: null,
  missing: [],
  warnings: [{ code: "unverified", capabilities: ["write", "create"] }],
};

const listOf = (connections: unknown[]) => ({
  connections,
  site: { enabled: true, allowed_hosts: [] },
  limit: 5,
  envelope_configured: true,
});

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** The fake: the list (empty until connected), test and create; records what was sent. */
async function fakeGit(page: Page): Promise<{ bodies: string[]; urls: string[] }> {
  const seen = { bodies: [] as string[], urls: [] as string[] };
  let connected = false;
  await page.route(BASE, async (route) => {
    const req = route.request();
    seen.urls.push(req.url());
    if (req.method() === "GET") return json(route, 200, listOf(connected ? [connection] : []));
    seen.bodies.push(req.postData() ?? "");
    connected = true;
    return json(route, 201, { connection, test: report });
  });
  await page.route(`${BASE}/test`, async (route) => {
    seen.urls.push(route.request().url());
    seen.bodies.push(route.request().postData() ?? "");
    return json(route, 200, { test: report });
  });
  return seen;
}

test("Git section: connect a GitHub organization with a token (fake host)", async ({ page }) => {
  const seen = await fakeGit(page);
  await page.goto("/admin/team/git");
  const panel = panelOf(page);
  await expect(panel.getByRole("heading", { name: "Git", exact: true })).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  await expect(panel.getByText("No git organization is connected")).toBeVisible();
  await panel.getByRole("button", { name: "Connect a git organization" }).click();

  const dialog = page.getByRole("dialog", { name: "Connect a git organization" });
  await expect(dialog.getByRole("heading", { name: "Step 1 of 3: Host" })).toBeFocused();
  await dialog.getByRole("radio", { name: "GitHub", exact: true }).check();
  await dialog.getByRole("button", { name: "Next" }).click();

  await expect(dialog.getByRole("heading", { name: /Step 2 of 3/ })).toBeFocused();
  await dialog.getByRole("textbox", { name: /^Organization/ }).fill("acme-e2e");
  await dialog.getByRole("radio", { name: "Fine-grained personal access token" }).check();
  await expect(dialog.getByRole("link", { name: /New fine-grained token/ })).toHaveAttribute(
    "href",
    "https://github.com/settings/personal-access-tokens/new",
  );
  const token = dialog.getByLabel(/Access token/);
  await expect(token).toHaveAttribute("type", "password");
  await token.fill(FAKE_TOKEN);
  await dialog.getByRole("button", { name: "Next" }).click();

  await expect(dialog.getByRole("heading", { name: /Step 3 of 3/ })).toBeFocused();
  await dialog.getByRole("button", { name: "Test" }).click();
  await expect(dialog.getByRole("status")).toContainText("Test passed");
  await expect(dialog.getByRole("status")).toContainText("The token's owner, octo-e2e");
  await dialog.getByRole("button", { name: "Connect" }).click();

  await expect(dialog).toBeHidden();
  await expect(panel.getByText(/Connected acme-e2e on GitHub/)).toBeVisible();
  await expect(panel.getByRole("article", { name: "acme-e2e on GitHub" })).toBeVisible();
  await expect(panel.getByText("Credential expires soon")).toBeVisible();

  // Sent twice (test, connect), only in request bodies; never in a URL or on the page.
  expect(seen.bodies.filter((b) => b.includes(FAKE_TOKEN))).toHaveLength(2);
  expect(seen.urls.some((u) => u.includes(FAKE_TOKEN))).toBe(false);
  expect(await page.content()).not.toContain(FAKE_TOKEN);
  const values = await page
    .locator("input, textarea")
    .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
  expect(values.some((v) => v.includes(FAKE_TOKEN))).toBe(false);
});

test("My connectors: members see the Workspace's git organizations (fake host)", async ({
  page,
}) => {
  await page.route(BASE, (route) =>
    json(route, 200, {
      connections: [
        {
          id: ID,
          provider: "forgejo",
          base_url: "https://code.example.org",
          organization: "infra",
          display_name: "infra on Forgejo",
          access_level: "read_write",
          status: "ok",
        },
      ],
      site: { enabled: true },
      limit: 5,
      envelope_configured: true,
    }),
  );
  await page.goto("/me/connectors");
  const panel = panelOf(page);
  const item = panel.getByRole("listitem", { name: "infra on Forgejo" });
  await expect(item).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  await expect(item).toContainText("code.example.org");
  await expect(item).toContainText("Read and write");
  await expect(panel.getByRole("button", { name: /Connect a git organization/ })).toHaveCount(0);
});

const LIVE = {
  provider: process.env["KOBE_GIT_PROVIDER"],
  org: process.env["KOBE_GIT_ORG"],
  token: process.env["KOBE_GIT_TOKEN"],
  baseUrl: process.env["KOBE_GIT_BASE_URL"],
};

test("Git section: Test against a real host, without saving", async ({ page }) => {
  test.skip(
    !LIVE.provider || !LIVE.org || !LIVE.token,
    "set KOBE_GIT_PROVIDER, KOBE_GIT_ORG, KOBE_GIT_TOKEN (and KOBE_GIT_BASE_URL) to run",
  );
  const label =
    LIVE.provider === "github"
      ? LIVE.baseUrl
        ? "GitHub Enterprise Server"
        : "GitHub"
      : LIVE.provider === "gitea"
        ? "Gitea"
        : "Forgejo";
  await page.goto("/admin/team/git");
  const panel = panelOf(page);
  const connect = panel.getByRole("button", { name: "Connect a git organization" });
  await expect(connect).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  test.skip(await connect.isDisabled(), "Connect is not offered here (Site switch, key or cap)");
  await connect.click();
  const dialog = page.getByRole("dialog", { name: "Connect a git organization" });
  await dialog.getByRole("radio", { name: label, exact: true }).check();
  if (label !== "GitHub")
    await dialog.getByRole("textbox", { name: /Address/ }).fill(LIVE.baseUrl ?? "");
  await dialog.getByRole("button", { name: "Next" }).click();
  await dialog.getByRole("textbox", { name: /^Organization/ }).fill(LIVE.org ?? "");
  if (LIVE.provider === "github") {
    await dialog.getByRole("radio", { name: "Fine-grained personal access token" }).check();
  }
  await dialog.getByLabel(/Access token/).fill(LIVE.token ?? "");
  await dialog.getByRole("button", { name: "Next" }).click();
  const answer = page.waitForResponse((r) => r.url().endsWith("/v1/team/git/connections/test"));
  await dialog.getByRole("button", { name: "Test" }).click();
  const res = await answer;
  // Whatever the host said, the page says it in words; the token is never in the answer or page.
  await expect(dialog.getByRole("status")).not.toBeEmpty();
  expect(await res.text()).not.toContain(LIVE.token ?? "");
  expect(await page.content()).not.toContain(LIVE.token ?? "");
  await dialog.getByRole("button", { name: "Cancel" }).click();
});
