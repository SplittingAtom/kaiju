// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { findSection } from "../../lib/admin/nav/registry";
import { must } from "../../lib/testing/must";
import { ConsoleLinks } from "./console-links";
import { ConsoleOverview } from "./overview";
import { SectionPlaceholder } from "./placeholder";
import { forbidNativeConfirm, ME, renderSite, renderTeam, stubApi } from "./testing";

beforeEach(forbidNativeConfirm);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("console overview", () => {
  it("lists the site sections with what each is for, none a placeholder (KOBE-606)", () => {
    stubApi({});
    renderSite(<ConsoleOverview kind="site" />);
    expect(screen.getByRole("heading", { level: 1, name: "Site console" })).toBeTruthy();
    const people = screen.getByRole("region", { name: "People" });
    expect(within(people).getByRole("link", { name: "Users" }).getAttribute("href")).toBe(
      "/admin/site/users",
    );
    const models = screen.getByRole("region", { name: "Models and connectors" });
    expect(models.textContent).not.toMatch(/On hold|Coming in|Web search/);
  });

  it("lists only the team sections the role covers", () => {
    renderTeam(<ConsoleOverview kind="team" />);
    expect(screen.getAllByRole("link").map((a) => a.textContent)).toEqual([
      "Members and roles",
      "Invitations",
      "Team agents",
      "Inventory",
      "Audit view",
      "Break-glass access",
    ]);
    // The list and the Inventory moved to the Agents page's Team tab (KOBE-570).
    expect(screen.getByRole("link", { name: "Team agents" }).getAttribute("href")).toBe(
      "/agents?tab=team",
    );
  });
});

describe("site health notices (KOBE-811)", () => {
  const HEALTH = "GET /v1/site/health";
  const DOCS = "docs/install.md#rate-limit-at-the-ingress-optional";
  const health = (check: Record<string, unknown>) =>
    [200, { checks: [{ id: "ingress_rate_limit", ...check }] }] as const;

  it("says when no rate limit is configured at the ingress, as information with a pointer", async () => {
    stubApi({ [HEALTH]: health({ level: "info", state: "none", docs: DOCS }) });
    renderSite(<ConsoleOverview kind="site" />);
    const notice = await screen.findByRole("status", { name: /No rate limit at the ingress/ });
    expect(notice.textContent).toMatch(/one address/);
    expect(notice.textContent).toMatch(/Rate limit at the ingress/);
    const link = within(notice).getByRole("link", { name: /Site admin overview/ });
    expect(link.getAttribute("href")).toBe("/docs/admin/site-admin#ingress-rate-limit");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says when Kaiju cannot tell, and how to declare an edge limit", async () => {
    stubApi({ [HEALTH]: health({ level: "info", state: "unknown", docs: DOCS }) });
    renderSite(<ConsoleOverview kind="site" />);
    const notice = await screen.findByRole("status", { name: /Ingress rate limit unknown/ });
    expect(notice.textContent).toMatch(/ingress\.rateLimit\.external/);
  });

  it("shows nothing when a limit is configured", async () => {
    const calls = stubApi({
      [HEALTH]: health({ level: "ok", state: "configured", source: "chart" }),
    });
    renderSite(<ConsoleOverview kind="site" />);
    await waitFor(() => expect(calls.some((c) => c.url === "/v1/site/health")).toBe(true));
    expect(screen.queryByRole("status", { name: /rate limit/i })).toBeNull();
  });

  it("is not asked for by a user who is not a site admin", async () => {
    const calls = stubApi({});
    renderSite(<ConsoleOverview kind="site" />, "user", ["memory_steward"]);
    await screen.findByRole("heading", { level: 1, name: "Site console" });
    expect(calls.some((c) => c.url === "/v1/site/health")).toBe(false);
  });
});

describe("section placeholder", () => {
  it("names the ticket that builds it", () => {
    const section = {
      ...must(findSection("site", "settings")),
      status: { kind: "placeholder", ticket: "KOBE-999" } as const,
    };
    render(<SectionPlaceholder section={section} />);
    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
    expect(screen.getByRole("note").textContent).toBe("Coming in KOBE-999.");
  });

  it("says why a section is on hold (KOBE-291)", () => {
    const section = {
      ...must(findSection("site", "settings")),
      status: {
        kind: "placeholder",
        ticket: "KOBE-999",
        onHold: "Settings are on hold while the options are chosen.",
      } as const,
    };
    render(<SectionPlaceholder section={section} />);
    const note = screen.getByRole("note");
    expect(note.textContent).toMatch(/^On hold/);
    expect(note.textContent).toMatch(/while the options are chosen.*\(KOBE-999\)/);
    expect(note.textContent).not.toMatch(/Coming in/);
  });
});

describe("console links on the home page", () => {
  const me = (siteRole: string | null) =>
    [200, { user: { ...ME, twoFactorEnabled: false }, siteRole }] as const;
  const team = (role: string, permissions: string[]) =>
    [200, { team: { id: "t-1", slug: "fin", name: "Finance" }, role, permissions }] as const;

  it("shows both consoles to an Owner who is a team admin", async () => {
    stubApi({
      "GET /v1/me": me("owner"),
      "GET /v1/team": team("team_admin", ["team.members.manage"]),
    });
    render(<ConsoleLinks />);
    const nav = await screen.findByRole("navigation", { name: "Administration" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((a) => a.getAttribute("href")),
    ).toEqual(["/admin/site", "/admin/team"]);
  });

  it("shows nothing to a member", async () => {
    const calls = stubApi({
      "GET /v1/me": me(null),
      "GET /v1/team": team("member", ["team.read", "team.members.read"]),
    });
    render(<ConsoleLinks />);
    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(3));
    expect(screen.queryByRole("navigation", { name: "Administration" })).toBeNull();
  });

  it("shows the site console to an Admin with no active team", async () => {
    stubApi({ "GET /v1/me": me("admin"), "GET /v1/team": [409, { code: "no_active_team" }] });
    render(<ConsoleLinks />);
    const nav = await screen.findByRole("navigation", { name: "Administration" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(["Site console"]);
  });
});
