// @vitest-environment happy-dom
/**
 * Repos in the Files panel (KOBE-768, spec workspace-git G16, G17, G19, G20; ac-1, ac-2, ac-3):
 * a Repo sits among the projects with the git icon, its host and repository, the branch and the
 * member's ahead/behind; Open on <host> goes only to the connection's host; Repo details… shows
 * the mirror state with Refresh, and Relink/Detach for Workspace admins; Convert to repo… is
 * offered to owners and admins with a connection at Read and write and shows the server's
 * refusals; finished conversions and expiring credentials show as notices.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFilesApi } from "../../lib/files/api";
import { IconActionProvider } from "../shell/icon-action";
import { WorkspaceProjectsProvider } from "../projects/workspace-projects";
import { routedFetch, TEAM, wireCheckout, wireProject } from "../projects/workspace-testing";
import { FileBrowser } from "./file-browser";

const entry = (path: string) => ({
  name: path.slice(path.lastIndexOf("/") + 1),
  path,
  type: "dir",
  size_bytes: null,
  mtime: "2026-11-01T10:00:00Z",
  source: "synced",
  area: path.startsWith("projects") ? "projects" : "workspace",
});

const mirror = (over: Record<string, unknown> = {}) => ({
  head_sha: "a".repeat(40),
  refreshed_at: "2026-11-23T10:00:00Z",
  attempted_at: "2026-11-23T10:00:00Z",
  refreshing: false,
  next_attempt_at: null,
  failures: 0,
  error: null,
  too_large: false,
  ...over,
});

const wireRepo = (over: Record<string, unknown> = {}) => ({
  project_id: "p-ops",
  repository_id: "r-1",
  connection_id: "c-1",
  provider: "github",
  base_url: "https://github.com",
  full_name: "acme/kobe-ops",
  web_url: "https://github.com/acme/kobe-ops",
  default_branch: "main",
  host_state: "active",
  read_only: false,
  read_only_reason: null,
  can_manage: false,
  mirror: mirror(),
  commits: [
    {
      sha: "b".repeat(40),
      author_name: "Ada",
      authored_at: "2026-11-23T09:00:00Z",
      message: "Fix the budget <b>totals</b>",
    },
  ],
  ...over,
});

const repoStatus = (workingCopy: Record<string, unknown> | null = null) => ({
  repo: {
    default_branch: "main",
    direct_commits: false,
    can_commit: true,
    pull_request: null,
    working_copy: workingCopy,
  },
});

const connection = (over: Record<string, unknown> = {}) => ({
  id: "c-1",
  provider: "github",
  base_url: "https://github.com",
  organization: "acme",
  display_name: "Acme on GitHub",
  access_level: "read_write",
  status: "ok",
  repo_name_prefix: "kobe-",
  ...over,
});

let routes: Parameters<typeof routedFetch>[0];

beforeEach(() => {
  routes = {
    "POST /v1/workspace/wake": [202, { status: "waking" }],
    "GET /v1/workspace/files": [200, { path: "", entries: [entry("projects")] }],
    "GET /v1/workspace/files?path=projects": [
      200,
      { path: "projects", entries: [entry("projects/ops"), entry("projects/budget")] },
    ],
    "GET /v1/projects": [
      200,
      {
        projects: [
          wireProject("ops", { kind: "repo", repo_conversion: null }),
          wireProject("budget", { my_role: "owner", kind: "project", repo_conversion: null }),
        ],
      },
    ],
    "GET /v1/me/checkouts": [200, { checkouts: [wireCheckout("ops")] }],
    "GET /v1/projects/p-ops/repo": [200, { repo: wireRepo() }],
    "GET /v1/projects/p-ops/repo-status": [
      200,
      repoStatus({
        branch: "fix-totals",
        head_sha: null,
        upstream: "origin/fix-totals",
        ahead: 2,
        behind: 1,
        dirty: false,
        fetched: true,
        problem: null,
        reported_at: "2026-11-23T10:00:00Z",
      }),
    ],
    "GET /v1/team/git/connections": [
      200,
      { connections: [connection()], site: { enabled: true }, limit: 5, envelope_configured: true },
    ],
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount(pollMs?: number) {
  const { fetchFn, calls } = routedFetch(routes);
  render(
    <div data-kobe-chat>
      <IconActionProvider>
        <WorkspaceProjectsProvider teamId={TEAM} fetchFn={fetchFn} conversionPollMs={pollMs}>
          <FileBrowser
            api={createFilesApi(TEAM, fetchFn)}
            workspaceName="Marketing"
            refreshAfterWakeMs={60_000}
          />
        </WorkspaceProjectsProvider>
      </IconActionProvider>
    </div>,
  );
  return calls;
}

const projects = () => screen.getByRole("tree", { name: "Projects" });
const row = (name: string) => within(projects()).findByRole("treeitem", { name });

async function openMenu(name: string) {
  const user = userEvent.setup();
  const item = await row(name);
  await user.click(within(item).getByRole("button", { name: `Actions for ${name}` }));
  return { user, menu: await screen.findByRole("menu", { name: `Actions for ${name}` }) };
}

describe("a Repo among the projects (ac-1, G19)", () => {
  it("has the git icon, host and repository, the branch and ahead/behind", async () => {
    mount();
    const ops = await row("Ops plan");
    await waitFor(() => expect(ops.getAttribute("title")).toBe("ops · github.com · acme/kobe-ops"));
    expect(ops.querySelector("svg.lucide-git-branch")).not.toBeNull();
    expect(ops.textContent).toContain("fix-totals");
    expect(ops.textContent).toContain("↑2 ↓1");
    const described = document.getElementById(ops.getAttribute("aria-describedby") ?? "");
    expect(described?.textContent).toMatch(
      /^Repo, Not in this conversation, github\.com · acme\/kobe-ops, .*branch fix-totals, 2 ahead, 1 behind/,
    );
    // An ordinary project keeps the folder.
    const budget = await row("Budget plan");
    expect(budget.querySelector("svg.lucide-git-branch")).toBeNull();
  });

  it("opens the repository on the connection's host only, without opener or referrer", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    mount();
    await waitFor(async () =>
      expect((await row("Ops plan")).getAttribute("title")).toContain("acme"),
    );
    const { user, menu } = await openMenu("Ops plan");
    await user.click(within(menu).getByRole("menuitem", { name: "Open on github.com" }));
    expect(open).toHaveBeenCalledWith(
      "https://github.com/acme/kobe-ops",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("offers no host link when the URL is not on the connection's host", async () => {
    routes["GET /v1/projects/p-ops/repo"] = [
      200,
      { repo: wireRepo({ web_url: "https://evil.example/acme/kobe-ops" }) },
    ];
    mount();
    await waitFor(async () =>
      expect((await row("Ops plan")).getAttribute("title")).toContain("acme"),
    );
    const { menu } = await openMenu("Ops plan");
    expect(within(menu).queryByRole("menuitem", { name: /^Open on/ })).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: "Repo details…" })).toBeTruthy();
  });
});

describe("Repo details… (ac-1, G17, G20)", () => {
  it("shows the mirror and commits as text, refreshes, and says when Refresh is refused", async () => {
    routes["POST /v1/projects/p-ops/repo/refresh"] = [
      202,
      { repo: wireRepo({ mirror: mirror({ refreshing: true }) }) },
    ];
    routes["GET /v1/projects/p-ops/repo"] = [
      [200, { repo: wireRepo() }],
      [200, { repo: wireRepo({ mirror: mirror({ refreshing: true }) }) }],
    ];
    const calls = mount();
    const { user, menu } = await openMenu("Ops plan");
    await user.click(within(menu).getByRole("menuitem", { name: "Repo details…" }));
    const dialog = await screen.findByRole("dialog", { name: "Ops plan: Repo" });
    expect(within(dialog).getByText("github.com · acme/kobe-ops")).toBeTruthy();
    const link = within(dialog).getByRole("link", { name: "Open on github.com" });
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(
      within(dialog).getByText(/Your working copy: fix-totals, 2 ahead, 1 behind/),
    ).toBeTruthy();
    // Host text stays text.
    expect(dialog.querySelector("b")).toBeNull();
    expect(dialog.textContent).toContain("Fix the budget <b>totals</b>");
    expect(within(dialog).getByText(/^Last refreshed /)).toBeTruthy();
    // No admin controls for a member.
    expect(within(dialog).queryByRole("button", { name: "Relink…" })).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Refresh" }));
    expect(await within(dialog).findByText("Refreshing from the host…")).toBeTruthy();
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/repo/refresh"))).toBe(true);
  });

  it("says why Refresh was refused (the connection's limit, the host's rate limit)", async () => {
    routes["POST /v1/projects/p-ops/repo/refresh"] = [
      429,
      { code: "connection_budget", message: "The connection's hourly limit is used up." },
    ];
    mount();
    const { user, menu } = await openMenu("Ops plan");
    await user.click(within(menu).getByRole("menuitem", { name: "Repo details…" }));
    const dialog = await screen.findByRole("dialog", { name: "Ops plan: Repo" });
    await user.click(within(dialog).getByRole("button", { name: "Refresh" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "The connection's hourly limit is used up.",
    );
  });

  it("explains a read-only Repo, and lets an admin relink and detach it", async () => {
    routes["GET /v1/projects/p-ops/repo"] = [
      200,
      {
        repo: wireRepo({
          can_manage: true,
          read_only: true,
          read_only_reason: "archived",
          host_state: "archived",
          mirror: mirror({
            too_large: false,
            error: { code: "credential_forbidden", message: "The credential may not read it." },
          }),
        }),
      },
    ];
    routes["POST /v1/projects/p-ops/repo/relink"] = [
      404,
      { code: "repository_not_found", message: "That repository is not in the organization." },
    ];
    routes["POST /v1/projects/p-ops/repo/detach"] = [
      200,
      { project_id: "p-ops", commit_id: "c-9", seq: 9 },
    ];
    const calls = mount();
    const { user, menu } = await openMenu("Ops plan");
    await user.click(within(menu).getByRole("menuitem", { name: "Repo details…" }));
    const dialog = await screen.findByRole("dialog", { name: "Ops plan: Repo" });
    expect(within(dialog).getByRole("note").textContent).toMatch(/archived on the host/);
    expect(dialog.textContent).toContain("The credential may not read it.");
    await user.click(within(dialog).getByRole("button", { name: "Relink…" }));
    const name = within(dialog).getByLabelText("Repository name");
    await user.clear(name);
    await user.type(name, "kobe-ops-2");
    await user.click(within(dialog).getByRole("button", { name: "Relink" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "That repository is not in the organization.",
    );
    expect(calls.find((c) => c.url.endsWith("/repo/relink"))?.body).toEqual({
      connection_id: "c-1",
      repository: "kobe-ops-2",
    });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await user.click(within(dialog).getByRole("button", { name: "Detach…" }));
    await user.click(within(dialog).getByRole("button", { name: "Detach" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/repo/detach"))).toBe(true),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Ops plan: Repo" })).toBeNull(),
    );
  });
});

describe("Convert to repo… (ac-2, G16)", () => {
  it("is offered to the owner, prefills the name with the prefix, and shows a refusal", async () => {
    routes["GET /v1/projects/p-budget/repo-conversion"] = [200, { conversion: null }];
    routes["POST /v1/projects/p-budget/repo-conversion"] = [
      422,
      {
        code: "too_large_to_mirror",
        message:
          "The project's current files (300 MiB) are more than a Repo's mirror can show (256 MiB).",
        limit_bytes: 268435456,
        size_bytes: 314572800,
      },
    ];
    const calls = mount();
    const { user, menu } = await openMenu("Budget plan");
    await user.click(within(menu).getByRole("menuitem", { name: "Convert to repo…" }));
    const dialog = await screen.findByRole("dialog", { name: "Convert Budget plan to a repo" });
    const name = await within(dialog).findByLabelText("Repository name");
    expect((name as HTMLInputElement).value).toBe("kobe-budget");
    expect(
      within(dialog).getByText(/Git connection: Acme on GitHub \(github\.com \/ acme\)/),
    ).toBeTruthy();
    expect(within(dialog).queryByLabelText(/existing empty repository/)).toBeNull();
    await user.click(within(dialog).getByLabelText("One commit of the current files"));
    await user.click(within(dialog).getByRole("button", { name: "Convert" }));
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(
      /more than a Repo's mirror can show/,
    );
    expect(
      calls.find((c) => c.method === "POST" && c.url.endsWith("/repo-conversion"))?.body,
    ).toEqual({
      connection_id: "c-1",
      repository_name: "kobe-budget",
      carry_history: false,
    });
  });

  it("is not offered to an editor, nor without a connection at Read and write", async () => {
    routes["GET /v1/team/git/connections"] = [
      200,
      {
        connections: [connection({ access_level: "read" })],
        site: { enabled: true },
        limit: 5,
        envelope_configured: true,
      },
    ];
    mount();
    const budget = await openMenu("Budget plan");
    expect(within(budget.menu).queryByRole("menuitem", { name: "Convert to repo…" })).toBeNull();
    await budget.user.keyboard("{Escape}");
    const ops = await openMenu("Ops plan");
    expect(within(ops.menu).queryByRole("menuitem", { name: "Convert to repo…" })).toBeNull();
  });

  it("marks a project a conversion holds, and says when it is done", async () => {
    routes["GET /v1/projects"] = [
      [
        200,
        {
          projects: [
            wireProject("budget", {
              my_role: "owner",
              kind: "project",
              repo_conversion: "running",
            }),
          ],
        },
      ],
      [
        200,
        {
          projects: [
            wireProject("budget", { my_role: "owner", kind: "repo", repo_conversion: null }),
          ],
        },
      ],
    ];
    routes["GET /v1/projects/p-budget/repo"] = [
      200,
      { repo: wireRepo({ project_id: "p-budget" }) },
    ];
    routes["GET /v1/projects/p-budget/repo-status"] = [200, repoStatus()];
    const done = { status: "completed", step: "done", full_name: "acme/kobe-budget" };
    routes["GET /v1/projects/p-budget/repo-conversion"] = [
      [200, { conversion: { status: "running", step: "push" } }],
      [500, { code: "server_error", message: "x" }],
      [200, { conversion: done }],
    ];
    const calls = mount(30);
    const budget = await row("Budget plan");
    expect(budget.textContent).toContain("converting to a Repo…");
    const notices = await screen.findByRole("list", { name: "Repo notices" }, { timeout: 3000 });
    expect(within(notices).getByText("Budget plan is now a Repo.")).toBeTruthy();
    // One live region announces it.
    expect(
      screen.getAllByRole("status").some((s) => s.textContent === "Budget plan is now a Repo."),
    ).toBe(true);
    // Review M3: only that project's attempt is followed, and the list is read again once.
    const polls = calls.filter((c) => c.url === "/v1/projects/p-budget/repo-conversion");
    expect(polls.length).toBe(3);
    await waitFor(() => expect(budget.querySelector("svg.lucide-git-branch")).not.toBeNull());
    expect(calls.filter((c) => c.url === "/v1/projects").length).toBe(2);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Dismiss: Budget plan is now a Repo." }));
    expect(screen.queryByRole("list", { name: "Repo notices" })).toBeNull();
  });

  it("a reader is not followed for someone else's conversion (review L5)", async () => {
    routes["GET /v1/projects"] = [
      200,
      { projects: [wireProject("budget", { my_role: "reader", repo_conversion: "running" })] },
    ];
    routes["GET /v1/team/git/connections"] = [
      200,
      { connections: [], site: { enabled: true }, limit: 5, envelope_configured: true },
    ];
    const calls = mount(10);
    await row("Budget plan");
    await new Promise((r) => setTimeout(r, 80));
    expect(calls.some((c) => c.url.endsWith("/repo-conversion"))).toBe(false);
  });

  it("a Workspace admin listed as editor may still convert (review L1)", async () => {
    routes["GET /v1/projects"] = [
      200,
      { projects: [wireProject("budget", { my_role: "editor", kind: "project" })] },
    ];
    routes["GET /v1/team/git/connections"] = [
      200,
      {
        connections: [connection()],
        site: { enabled: true, allowed_hosts: [] },
        limit: 5,
        envelope_configured: true,
      },
    ];
    mount();
    await waitFor(async () => {
      const { menu, user } = await openMenu("Budget plan");
      expect(within(menu).queryByRole("menuitem", { name: "Convert to repo…" })).not.toBeNull();
      await user.keyboard("{Escape}");
    });
  });
});

describe("credential expiry (in-app notice)", () => {
  it("tells a Workspace admin in the Files panel, with the way to the Git section", async () => {
    routes["GET /v1/team/git/connections"] = [
      200,
      {
        connections: [
          {
            ...connection(),
            repo_name_prefix: undefined,
            credential: {
              kind: "access_token",
              hint: "••••abcd",
              github_app_id: null,
              github_installation_id: null,
              updated_at: "2026-11-01T10:00:00Z",
              expires_at: "2026-11-30T10:00:00Z",
              expires_soon: true,
            },
            repo_defaults: { visibility: "private", name_prefix: "", default_branch: "main" },
          },
        ],
        site: { enabled: true, allowed_hosts: [] },
        limit: 5,
        envelope_configured: true,
      },
    ];
    mount();
    const note = await screen.findByText(
      /The credential of the git connection Acme on GitHub expires/,
    );
    expect(
      within(note)
        .getByRole("link", { name: "Replace it in the Git section" })
        .getAttribute("href"),
    ).toBe("/admin/team/git");
  });
});
