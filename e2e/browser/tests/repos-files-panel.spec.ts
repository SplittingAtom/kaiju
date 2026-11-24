import type { Page, Route } from "@playwright/test";
import { expect, filesSection, test } from "./support/chat.js";
import { RUN_TIMEOUT_MS, SHELL_TIMEOUT_MS } from "./support/constants.js";
import { pageApi } from "./support/gate5.js";

/**
 * KOBE-768 (spec docs/specs/workspace-git.md G16, G17, G19, G20): Repos in the Files panel and the
 * Convert to repo dialog, in a real browser against a deployment. `KOBE_USER` must be a Workspace
 * admin of the active team.
 *
 * The first test needs no git host: it answers the project list (the deployment's projects plus a
 * fake Repo and a fake project the member owns), the Repo's `/repo` and `/repo-status`, the git
 * connections and the conversion start in the browser (Playwright `page.route`), so it checks the
 * row (git icon, host and repository, branch, ahead/behind), Open on <host>, Repo details… and a
 * refusal of Convert to repo in the deployment's real shell and theme. Nothing is stored.
 *
 * The second test needs a git connection at Read and write in the active Workspace and goes
 * through the dialog on a real project up to, not including, the start. Only with
 * `KOBE_GIT_E2E_CONVERT=1` (opt-in, off by default, review H1) does it also convert: that creates
 * a private repository named `<prefix>kaiju-e2e-<unique>` in the organization, which Kaiju never
 * deletes (remove it on the host afterwards). Spends no model tokens:
 * `npx playwright test repos-files-panel`.
 */
const REPO_ID = "77777777-7777-4777-8777-777777777777";
const OWNED_ID = "88888888-8888-4888-8888-888888888888";
const CONNECTION_ID = "99999999-9999-4999-8999-999999999999";
/** Now, so the fake rows sort first and never fall behind "Show all" (review L8). */
const STAMP = new Date().toISOString();

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const fakeProject = (id: string, slug: string, name: string, over: Record<string, unknown>) => ({
  id,
  team_id: "00000000-0000-4000-8000-000000000000",
  slug,
  name,
  description: "",
  instructions: "",
  default_agent_id: null,
  my_role: "owner",
  file_count: 1,
  head_commit_id: null,
  live_bytes: null,
  history_bytes: null,
  live_objects: null,
  history_objects: null,
  created_by: "00000000-0000-4000-8000-000000000001",
  created_at: STAMP,
  updated_at: STAMP,
  archived_at: null,
  ...over,
});

const connection = {
  id: CONNECTION_ID,
  provider: "github",
  base_url: "https://github.com",
  organization: "acme-e2e",
  display_name: "acme-e2e on GitHub",
  access_level: "read_write",
  status: "ok",
  repo_name_prefix: "kobe-",
};

async function fakeRepos(page: Page): Promise<{ started: string[] }> {
  const seen = { started: [] as string[] };
  await page.route("**/v1/projects", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const real = await route.fetch();
    const body = (await real.json()) as { projects: unknown[] };
    return json(route, 200, {
      projects: [
        ...body.projects,
        fakeProject(REPO_ID, "e2e-repo-768", "E2E Repo 768", {
          kind: "repo",
          repo_conversion: null,
        }),
        fakeProject(OWNED_ID, "e2e-plain-768", "E2E Plain 768", {
          kind: "project",
          repo_conversion: null,
        }),
      ],
    });
  });
  await page.route(`**/v1/projects/${REPO_ID}/repo`, (route) =>
    json(route, 200, {
      repo: {
        project_id: REPO_ID,
        repository_id: "66666666-6666-4666-8666-666666666666",
        connection_id: CONNECTION_ID,
        provider: "github",
        base_url: "https://github.com",
        full_name: "acme-e2e/kaiju-e2e-repo",
        web_url: "https://github.com/acme-e2e/kaiju-e2e-repo",
        default_branch: "main",
        host_state: "active",
        read_only: false,
        read_only_reason: null,
        can_manage: true,
        mirror: {
          head_sha: "a".repeat(40),
          refreshed_at: STAMP,
          attempted_at: STAMP,
          refreshing: false,
          next_attempt_at: null,
          failures: 0,
          error: null,
          too_large: false,
        },
        commits: [
          { sha: "b".repeat(40), author_name: "Ada", authored_at: STAMP, message: "First" },
        ],
      },
    }),
  );
  await page.route(`**/v1/projects/${REPO_ID}/repo-status`, (route) =>
    json(route, 200, {
      repo: {
        default_branch: "main",
        direct_commits: false,
        can_commit: true,
        pull_request: null,
        working_copy: {
          branch: "fix",
          head_sha: null,
          upstream: "origin/fix",
          ahead: 2,
          behind: 1,
          dirty: false,
          fetched: true,
          problem: null,
          reported_at: STAMP,
        },
      },
    }),
  );
  await page.route("**/v1/team/git/connections", (route) =>
    json(route, 200, {
      connections: [connection],
      site: { enabled: true },
      limit: 5,
      envelope_configured: true,
    }),
  );
  await page.route(`**/v1/projects/${OWNED_ID}/repo-conversion`, async (route) => {
    if (route.request().method() === "GET") return json(route, 200, { conversion: null });
    seen.started.push(route.request().postData() ?? "");
    return json(route, 422, {
      code: "too_large_to_mirror",
      message:
        "The project's current files (300 MiB) are more than a Repo's mirror can show (256 MiB): after converting, Kaiju could not show the repository's changes. Remove large files before converting.",
      limit_bytes: 268435456,
      size_bytes: 314572800,
    });
  });
  return seen;
}

const projectsTree = (page: Page) => filesSection(page).getByRole("tree", { name: "Projects" });

test("Repos in Files: git icon, host link, branch, ahead/behind, details, a refused conversion (fake host)", async ({
  chat,
  page,
}) => {
  const seen = await fakeRepos(page);
  await chat.open();
  const tree = projectsTree(page);
  const repo = tree.getByRole("treeitem", { name: "E2E Repo 768" });
  await expect(repo).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  await expect(repo).toHaveAttribute("title", "e2e-repo-768 · github.com · acme-e2e/kaiju-e2e-repo");
  await expect(repo.locator("svg.lucide-git-branch")).toHaveCount(1);
  await expect(repo).toContainText("fix");
  await expect(repo).toContainText("↑2 ↓1");

  await repo.hover();
  await repo.getByRole("button", { name: "Actions for E2E Repo 768" }).click();
  const menu = page.getByRole("menu", { name: "Actions for E2E Repo 768" });
  await expect(menu.getByRole("menuitem", { name: "Open on github.com" })).toBeVisible();
  await menu.getByRole("menuitem", { name: "Repo details…" }).click();
  const details = page.getByRole("dialog", { name: "E2E Repo 768: Repo" });
  await expect(details.getByText("github.com · acme-e2e/kaiju-e2e-repo")).toBeVisible();
  const link = details.getByRole("link", { name: "Open on github.com" });
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await expect(link).toHaveAttribute("href", "https://github.com/acme-e2e/kaiju-e2e-repo");
  await expect(details.getByText(/Your working copy: fix, 2 ahead, 1 behind/)).toBeVisible();
  await expect(details.getByRole("button", { name: "Relink…" })).toBeVisible();
  await expect(details.getByRole("button", { name: "Close" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(details).toBeHidden();

  const plain = tree.getByRole("treeitem", { name: "E2E Plain 768" });
  await plain.hover();
  await plain.getByRole("button", { name: "Actions for E2E Plain 768" }).click();
  await page
    .getByRole("menu", { name: "Actions for E2E Plain 768" })
    .getByRole("menuitem", { name: "Convert to repo…" })
    .click();
  const dialog = page.getByRole("dialog", { name: "Convert E2E Plain 768 to a repo" });
  const name = dialog.getByRole("textbox", { name: "Repository name" });
  await expect(name).toBeFocused();
  await expect(name).toHaveValue("kaiju-e2e-plain-768");
  await dialog.getByRole("radio", { name: "One commit of the current files" }).check();
  await dialog.getByRole("button", { name: "Convert" }).click();
  await expect(dialog.getByRole("alert")).toContainText("more than a Repo's mirror can show");
  expect(JSON.parse(seen.started[0] ?? "{}")).toEqual({
    connection_id: CONNECTION_ID,
    repository_name: "kaiju-e2e-plain-768",
    carry_history: false,
  });
});

interface Connection {
  readonly id: string;
  readonly access_level: string;
}

test("Convert to repo on a real project (needs a git connection at Read and write; converts only with KOBE_GIT_E2E_CONVERT=1)", async ({
  chat,
  page,
}) => {
  const convert = process.env["KOBE_GIT_E2E_CONVERT"] === "1";
  await chat.open();
  const list = await pageApi<{ connections?: Connection[]; site?: { enabled: boolean } }>(
    page,
    "GET",
    "/v1/team/git/connections",
  );
  const writable = (list.json.connections ?? []).filter((c) => c.access_level === "read_write");
  test.skip(
    list.status !== 200 || list.json.site?.enabled !== true || writable.length === 0,
    "no git connection at Read and write in this Workspace",
  );
  test.setTimeout(RUN_TIMEOUT_MS);
  const unique = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const made = await pageApi<{ id: string; slug: string; name: string }>(
    page,
    "POST",
    "/v1/projects",
    { name: `Kaiju e2e ${unique}`, slug: `kaiju-e2e-${unique}` },
  );
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const uploaded = await page.evaluate(async (id) => {
    const team = window.localStorage.getItem("kobe.lastTeamId");
    const form = new FormData();
    form.set("file", new File(["# Hello\n"], "README.md", { type: "text/markdown" }));
    const res = await fetch(`/v1/projects/${id}/files`, {
      method: "POST",
      headers: team ? { "x-kobe-team": team } : {},
      body: form,
    });
    return res.status;
  }, made.json.id);
  expect(uploaded).toBe(201);
  try {
    await page.reload();
    await chat.open();
    const tree = projectsTree(page);
    const row = tree.getByRole("treeitem", { name: made.json.name });
    await expect(row).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await row.hover();
    await row.getByRole("button", { name: `Actions for ${made.json.name}` }).click();
    await page
      .getByRole("menu", { name: `Actions for ${made.json.name}` })
      .getByRole("menuitem", { name: "Convert to repo…" })
      .click();
    const dialog = page.getByRole("dialog", { name: `Convert ${made.json.name} to a repo` });
    await expect(dialog.getByRole("textbox", { name: "Repository name" })).toHaveValue(
      new RegExp(`kaiju-e2e-${unique}$`),
    );
    await expect(dialog.getByText(/^An? (private|internal) repository in /)).toBeVisible();
    await dialog.getByRole("radio", { name: "One commit of the current files" }).check();
    if (!convert) {
      // Off by default: nothing is created on the host.
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toBeHidden();
      return;
    }
    await dialog.getByRole("button", { name: "Convert" }).click();
    await expect(dialog.getByText(/The project is now a Repo/)).toBeVisible({
      timeout: RUN_TIMEOUT_MS,
    });
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(row.locator("svg.lucide-git-branch")).toHaveCount(1, {
      timeout: SHELL_TIMEOUT_MS,
    });
  } finally {
    await pageApi(page, "PATCH", `/v1/projects/${made.json.id}`, { archived: true });
  }
});
