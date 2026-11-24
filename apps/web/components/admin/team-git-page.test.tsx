// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeamGitPage } from "./team/git/git-page";
import { MyGitConnections } from "./team/git/member-view";
import {
  GIT_BASE,
  ID,
  ID2,
  adminConnection,
  list,
  memberConnection,
  report,
  tokenConnection,
} from "./git-test-data";
import { answerConfirm, forbidNativeConfirm, renderTeam, stubApi, summary } from "./testing";

const ADMIN = { permissions: ["team.audit.read", "team.git.manage"] };
const MEMBER = { role: "member", permissions: ["team.chat"] } as const;

beforeEach(forbidNativeConfirm);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const card = (name: string) => within(screen.getByRole("article", { name }));

describe("Git section: states (KOBE-761)", () => {
  it("says it is loading, then shows an error with Try again that loads again", async () => {
    const calls = stubApi({
      [`GET ${GIT_BASE}`]: [
        [500, { code: "boom" }],
        [200, list([])],
      ],
    });
    renderTeam(<TeamGitPage />, ADMIN);
    expect(screen.getByRole("status").textContent).toMatch(/Loading git connections/);
    await screen.findByText(/Kobe had a problem/);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("No git organization is connected");
    expect(summary(calls).filter((c) => c === `GET ${GIT_BASE}`)).toHaveLength(2);
  });

  it("shows an empty state with Connect offered", async () => {
    stubApi({ [`GET ${GIT_BASE}`]: [200, list([])] });
    renderTeam(<TeamGitPage />, ADMIN);
    await screen.findByText("No git organization is connected");
    const connect = screen.getByRole("button", { name: "Connect a git organization" });
    expect((connect as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/0 of 5/)).toBeTruthy();
  });

  it("lists connections with provider, host, organization, level, health and expiry", async () => {
    stubApi({ [`GET ${GIT_BASE}`]: [200, list([adminConnection(), tokenConnection()])] });
    renderTeam(<TeamGitPage />, ADMIN);
    await screen.findByRole("article", { name: "acme on GitHub" });
    const gh = card("acme on GitHub");
    expect(gh.getByText("Read and write")).toBeTruthy();
    expect(gh.getByText("Working")).toBeTruthy();
    expect(gh.getByText("github.com")).toBeTruthy();
    expect(gh.getByText(/GitHub App 4242, installation 777/)).toBeTruthy();
    expect(gh.getByText(/Never \(one-hour tokens/)).toBeTruthy();
    expect(gh.getByRole("list", { name: /may do/ }).textContent).toMatch(
      /Create repositories: Yes.*Administer the organization or its repositories: No/,
    );
    const fj = card("infra on Forgejo");
    expect(fj.getByText("Forgejo")).toBeTruthy();
    expect(fj.getByText("code.example.org")).toBeTruthy();
    expect(fj.getByText(/Access token ••••9f3a/)).toBeTruthy();
    expect(fj.getByText("No expiry reported")).toBeTruthy();
  });

  it("explains when the Site switch is off, with a link for Site admins only", async () => {
    stubApi({
      [`GET ${GIT_BASE}`]: [200, list([adminConnection()], { site: { enabled: false } })],
    });
    renderTeam(<TeamGitPage />, { ...ADMIN, siteAdmin: true });
    await screen.findByText("Git connections are turned off for this Site");
    const link = screen.getByRole("link", { name: "Open Site settings" });
    expect(link.getAttribute("href")).toBe("/admin/site/settings#git-connections");
    expect(
      (screen.getByRole("button", { name: "Connect a git organization" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    cleanup();
    stubApi({ [`GET ${GIT_BASE}`]: [200, list([], { site: { enabled: false } })] });
    renderTeam(<TeamGitPage />, ADMIN);
    await screen.findByText("Git connections are turned off for this Site");
    expect(screen.queryByRole("link", { name: "Open Site settings" })).toBeNull();
    expect(screen.getByText("Ask a Site admin if you need it.")).toBeTruthy();
  });

  it("refuses to connect without the Site's encryption key", async () => {
    stubApi({ [`GET ${GIT_BASE}`]: [200, list([], { envelope_configured: false })] });
    renderTeam(<TeamGitPage />, ADMIN);
    await screen.findByText("Credentials cannot be stored yet");
    expect(
      (screen.getByRole("button", { name: "Connect a git organization" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("stops offering Connect at the cap of 5 and says why", async () => {
    const five = [1, 2, 3, 4, 5].map((n) =>
      adminConnection({
        id: `0000000${n}-1111-4111-8111-111111111111`,
        organization: `org${n}`,
        display_name: `org${n}`,
      }),
    );
    stubApi({ [`GET ${GIT_BASE}`]: [200, list(five)] });
    renderTeam(<TeamGitPage />, ADMIN);
    await screen.findByText(/has 5 connections, the most it can have/);
    expect(
      (screen.getByRole("button", { name: "Connect a git organization" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("warns about a token expiring soon or expired, in words", async () => {
    const soon = tokenConnection({
      credential: {
        ...tokenConnection().credential,
        expires_at: "2099-01-01T00:00:00.000Z",
        expires_soon: true,
      },
    });
    const gone = adminConnection({
      credential: {
        ...tokenConnection().credential,
        expires_at: "2020-01-01T00:00:00.000Z",
        expires_soon: true,
      },
    });
    stubApi({ [`GET ${GIT_BASE}`]: [200, list([gone, soon])] });
    renderTeam(<TeamGitPage />, ADMIN);
    await screen.findByText("Credential expires soon");
    expect(screen.getAllByText("Credential expired").length).toBeGreaterThan(0);
    expect(card("infra on Forgejo").getByText("Expires soon")).toBeTruthy();
    expect(screen.getAllByText(/use Replace credential/).length).toBe(2);
  });

  it("shows a failing connection's health as a sentence, never the host's words", async () => {
    stubApi({
      [`GET ${GIT_BASE}`]: [
        200,
        list([
          adminConnection({
            health: {
              status: "failing",
              last_checked_at: "2026-11-22T09:00:00.000Z",
              last_ok_at: "2026-11-21T09:00:00.000Z",
              last_error: "auth_failed:installation_removed",
            },
          }),
        ]),
      ],
    });
    renderTeam(<TeamGitPage />, ADMIN);
    await screen.findByRole("article", { name: "acme on GitHub" });
    const gh = card("acme on GitHub");
    expect(gh.getByText("Failing")).toBeTruthy();
    expect(gh.getByText(/no longer installed on the organization/)).toBeTruthy();
    expect(gh.queryByText(/auth_failed/)).toBeNull();
  });

  it("shows not_allowed health distinctly, with what to do for each Site refusal", async () => {
    const refused = (lastError: string, id: string, name: string) =>
      adminConnection({
        id,
        display_name: name,
        organization: name,
        health: {
          status: "not_allowed",
          last_checked_at: "2026-11-22T09:00:00.000Z",
          last_ok_at: null,
          last_error: lastError,
        },
      });
    stubApi({
      [`GET ${GIT_BASE}`]: [
        200,
        list([
          refused("host_refused:site_host_limit", ID, "limited"),
          refused("host_refused:site_git_off", ID2, "switched"),
        ]),
      ],
    });
    renderTeam(<TeamGitPage />, ADMIN);
    await screen.findByRole("article", { name: "limited" });
    const limited = card("limited");
    expect(limited.getByText("Not allowed by the Site")).toBeTruthy();
    expect(limited.queryByText("Failing")).toBeNull();
    expect(
      limited.getByText(/add the host to the Site's allowed git hosts, or disconnect it/),
    ).toBeTruthy();
    expect(
      card("switched").getByText(/turned off for this Site: agents cannot use this connection/),
    ).toBeTruthy();
  });

  it("marks a connection whose host the Site no longer allows", async () => {
    stubApi({
      [`GET ${GIT_BASE}`]: [
        200,
        list([tokenConnection()], { site: { enabled: true, allowed_hosts: ["github.com"] } }),
      ],
    });
    renderTeam(<TeamGitPage />, ADMIN);
    await screen.findByText(/does not allow git connections to code.example.org any more/);
    expect(screen.getByText(/This Site allows connections to: github.com/)).toBeTruthy();
  });

  it("shows members the read-only list without settings or credential details", async () => {
    stubApi({
      [`GET ${GIT_BASE}`]: [200, list([memberConnection()], { site: { enabled: true } })],
    });
    renderTeam(<TeamGitPage />, MEMBER);
    await screen.findByText(/Only Workspace admins can connect/);
    const item = within(screen.getByRole("listitem", { name: "acme on GitHub" }));
    expect(item.getByText("Read and write")).toBeTruthy();
    expect(item.getByText("Working")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Connect|Settings|Disconnect/ })).toBeNull();
  });
});

describe("Git section: per-connection actions (KOBE-761)", () => {
  it("Check now reports a pass, or the failure in Kobe's words", async () => {
    const calls = stubApi({
      [`GET ${GIT_BASE}`]: [200, list([adminConnection()])],
      [`POST ${GIT_BASE}/${ID}/check`]: [
        [200, { connection: adminConnection(), test: report(), error: null }],
        [
          200,
          {
            connection: adminConnection(),
            test: null,
            error: {
              code: "credential_rejected",
              message: "host text",
              test: { code: "auth_failed", reason: "installation_suspended" },
            },
          },
        ],
      ],
    });
    renderTeam(<TeamGitPage />, ADMIN);
    await screen.findByRole("article", { name: "acme on GitHub" });
    await userEvent.click(screen.getByRole("button", { name: "Check now for acme on GitHub" }));
    await screen.findByText("acme on GitHub works: checked just now.");
    await userEvent.click(screen.getByRole("button", { name: "Check now for acme on GitHub" }));
    const alert = await screen.findByText(/Check failed for acme on GitHub/);
    expect(alert.textContent).toMatch(/installation on this organization is suspended/);
    expect(summary(calls).filter((c) => c.startsWith("POST"))).toHaveLength(2);
  });

  it("Disconnect asks first, says repositories stay and access ends within 30 s, then deletes", async () => {
    const calls = stubApi({
      [`GET ${GIT_BASE}`]: [
        [200, list([adminConnection()])],
        [200, list([])],
      ],
      [`DELETE ${GIT_BASE}/${ID}`]: [200, { id: ID, repositories_kept: 2 }],
    });
    renderTeam(<TeamGitPage />, ADMIN);
    await screen.findByRole("article", { name: "acme on GitHub" });
    await userEvent.click(screen.getByRole("button", { name: "Disconnect acme on GitHub" }));
    const text = await answerConfirm("Disconnect acme on GitHub?", "Disconnect");
    expect(text).toMatch(/repositories there stay/);
    expect(text).toMatch(/up to 30 seconds/);
    await screen.findByText(/Disconnected acme on GitHub\. 2 repository record\(s\) kept/);
    expect(summary(calls)).toContain(`DELETE ${GIT_BASE}/${ID}`);
  });

  it("Disconnect does nothing when cancelled", async () => {
    const calls = stubApi({ [`GET ${GIT_BASE}`]: [200, list([adminConnection()])] });
    renderTeam(<TeamGitPage />, ADMIN);
    await screen.findByRole("article", { name: "acme on GitHub" });
    await userEvent.click(screen.getByRole("button", { name: "Disconnect acme on GitHub" }));
    await answerConfirm("Disconnect acme on GitHub?", "Cancel");
    expect(summary(calls).some((c) => c.startsWith("DELETE"))).toBe(false);
  });

  it("Settings saves level, defaults, push limit, direct commits and chosen agents", async () => {
    const saved = adminConnection({ access_level: "read" });
    const calls = stubApi({
      [`GET ${GIT_BASE}`]: [200, list([adminConnection()])],
      ["GET /v1/agents?scope=team&include_archived=true"]: [
        200,
        {
          agents: [
            { id: "a-1", name: "Builder", scope: "team", status: "active" },
            { id: "a-2", name: "Old", scope: "team", status: "active", archived_at: "2026-01-01" },
          ],
        },
      ],
      [`PATCH ${GIT_BASE}/${ID}`]: [200, { connection: saved }],
    });
    renderTeam(<TeamGitPage />, ADMIN);
    await screen.findByRole("article", { name: "acme on GitHub" });
    await userEvent.click(screen.getByRole("button", { name: "Settings for acme on GitHub" }));
    const dialog = within(
      await screen.findByRole("dialog", { name: "Settings for acme on GitHub" }),
    );
    await userEvent.click(dialog.getByRole("radio", { name: "Read" }));
    await userEvent.type(dialog.getByRole("textbox", { name: /Name prefix/ }), "kobe-");
    const push = dialog.getByRole("spinbutton", { name: /Push size limit/ });
    await userEvent.clear(push);
    await userEvent.type(push, "2048");
    // KOBE-767: Kobe's commit dialog enforces it (off by default: pull requests).
    const direct = dialog.getByRole("checkbox", { name: /straight to the default branch/ });
    expect((direct as HTMLInputElement).checked).toBe(false);
    await userEvent.click(direct);
    await userEvent.click(dialog.getByRole("radio", { name: "Only the agents I choose" }));
    await userEvent.click(dialog.getByRole("button", { name: "Save settings" }));
    expect(await dialog.findByText("Choose at least one agent.")).toBeTruthy();
    await userEvent.click(await dialog.findByRole("checkbox", { name: "Builder" }));
    expect(dialog.queryByRole("checkbox", { name: "Old" })).toBeNull();
    await userEvent.click(dialog.getByRole("button", { name: "Save settings" }));
    await screen.findByText("Saved the settings of acme on GitHub.");
    const patch = calls.find((c) => c.method === "PATCH");
    expect(JSON.parse(String(patch?.body))).toEqual({
      display_name: "acme on GitHub",
      repo_visibility: "private",
      repo_name_prefix: "kobe-",
      default_branch: "main",
      access_level: "read",
      push_limit_bytes: 2048 * 1024 * 1024,
      direct_commits: true,
      agent_ids: ["a-1"],
    });
  });

  it("Settings refuses an invalid branch and prefix before sending", async () => {
    const calls = stubApi({
      [`GET ${GIT_BASE}`]: [200, list([tokenConnection()])],
      ["GET /v1/agents?scope=team&include_archived=true"]: [200, { agents: [] }],
    });
    renderTeam(<TeamGitPage />, ADMIN);
    await screen.findByRole("article", { name: "infra on Forgejo" });
    await userEvent.click(screen.getByRole("button", { name: "Settings for infra on Forgejo" }));
    const dialog = within(await screen.findByRole("dialog"));
    // Forgejo has no internal repositories: the choice is not offered.
    expect(dialog.queryByRole("option", { name: /Internal/ })).toBeNull();
    const branch = dialog.getByRole("textbox", { name: "Default branch" });
    await userEvent.clear(branch);
    await userEvent.type(branch, "bad..name");
    await userEvent.type(dialog.getByRole("textbox", { name: /Name prefix/ }), "no spaces");
    await userEvent.click(dialog.getByRole("button", { name: "Save settings" }));
    expect(await dialog.findByText("Enter a valid branch name, such as main.")).toBeTruthy();
    expect(dialog.getByText(/Letters, digits, dots, hyphens and underscores only/)).toBeTruthy();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });
});

describe("members' read-only view on My connectors (KOBE-761)", () => {
  it("lists which organizations the Workspace reaches, with no settings", async () => {
    stubApi({
      [`GET ${GIT_BASE}`]: [
        200,
        list(
          [
            memberConnection(),
            memberConnection({
              id: ID2,
              provider: "gitea",
              base_url: "https://git.example.com",
              organization: "ops",
              display_name: "Ops",
              access_level: "off",
              status: "failing",
            }),
          ],
          { site: { enabled: true } },
        ),
      ],
    });
    renderTeam(<MyGitConnections teamId="t-1" />, MEMBER);
    const ops = within(await screen.findByRole("listitem", { name: "Ops" }));
    expect(ops.getByText("Not in use")).toBeTruthy();
    expect(ops.getByText("Failing")).toBeTruthy();
    expect(ops.getByText("git.example.com")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Git organizations" })).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("says when nothing is connected, and when the Site switch is off", async () => {
    stubApi({ [`GET ${GIT_BASE}`]: [200, list([], { site: { enabled: true } })] });
    renderTeam(<MyGitConnections teamId="t-1" />, MEMBER);
    await screen.findByText("This Workspace is not connected to a git organization");
    cleanup();
    stubApi({
      [`GET ${GIT_BASE}`]: [200, list([memberConnection()], { site: { enabled: false } })],
    });
    renderTeam(<MyGitConnections teamId="t-1" />, MEMBER);
    await waitFor(() =>
      expect(screen.getByText(/turned off for this Site, so agents cannot use them/)).toBeTruthy(),
    );
  });
});

describe("Commit author email (KOBE-761, G13, GQ10)", () => {
  const SETTINGS = "/v1/team/git/settings";
  const EXAMPLE = "0123456789+ada@users.noreply.kobe.example";

  it("shows both choices with what ends up in git history and the admin's own no-reply example", async () => {
    stubApi({
      [`GET ${GIT_BASE}`]: [200, list([])],
      [`GET ${SETTINGS}`]: [200, { commit_email: "member", noreply_example: EXAMPLE }],
    });
    renderTeam(<TeamGitPage />, ADMIN);
    const form = within(await screen.findByRole("form", { name: "Commit author email" }));
    const member = form.getByRole("radio", { name: "Member's Kobe email" });
    expect(member).toHaveProperty("checked", true);
    expect(form.getByText(/email they sign in to Kobe with/)).toBeTruthy();
    expect(form.getByText(EXAMPLE)).toBeTruthy();
    expect(screen.getByText(/keep it in their history for good/)).toBeTruthy();
    expect(form.getByRole("button", { name: "Save commit email" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("switches to the no-reply address and says so", async () => {
    const calls = stubApi({
      [`GET ${GIT_BASE}`]: [200, list([])],
      [`GET ${SETTINGS}`]: [
        [200, { commit_email: "member", noreply_example: EXAMPLE }],
        [200, { commit_email: "noreply", noreply_example: EXAMPLE }],
      ],
      [`PATCH ${SETTINGS}`]: [200, { commit_email: "noreply", noreply_example: EXAMPLE }],
    });
    renderTeam(<TeamGitPage />, ADMIN);
    const form = within(await screen.findByRole("form", { name: "Commit author email" }));
    await userEvent.click(form.getByRole("radio", { name: "No-reply address" }));
    await userEvent.click(form.getByRole("button", { name: "Save commit email" }));
    await screen.findByText("New commits in sandboxes now use each member's no-reply address.");
    const patch = calls.find((c) => c.method === "PATCH");
    expect(JSON.parse(String(patch?.body))).toEqual({ commit_email: "noreply" });
  });

  it("is not shown to members without team.git.manage", async () => {
    const calls = stubApi({
      [`GET ${GIT_BASE}`]: [200, list([memberConnection()], { site: { enabled: true } })],
    });
    renderTeam(<TeamGitPage />, MEMBER);
    await screen.findByText(/Only Workspace admins can connect/);
    expect(screen.queryByRole("form", { name: "Commit author email" })).toBeNull();
    expect(calls.some((c) => c.url === SETTINGS)).toBe(false);
  });
});
