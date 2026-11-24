// @vitest-environment happy-dom
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserNavigation } from "../../lib/admin/api/team/connector-grants";
import { ConnectorsPage } from "./site/connectors-page";
import { forbidNativeConfirm, renderSite, stubApi } from "./testing";

/**
 * KOBE-835: a site admin connects their own account to a new OAuth connector from the Site
 * console, comes back to it, and Re-probes to pin its tools.
 */
const BASE = "/v1/site/connectors";
const GRANTS = "/v1/connector-grants";
const ID = "5a0c2f9e-2222-4b3c-8d4e-abcdefabcdef";
const TEAM = "7d1e3a4b-3333-4c5d-9e6f-0123456789ab";
const OTHER = "8e2f4b5c-4444-4d6e-8f70-0123456789ab";
const AUTHORIZE = "https://auth.massive.example/authorize?state=s";
const massive = (over: Record<string, unknown> = {}) => ({
  id: ID,
  name: "massive",
  url: "https://mcp.massive.example/mcp",
  iconUrl: null,
  authKind: "oauth",
  status: "active",
  toolCount: 0,
  driftedCount: 0,
  templatesCount: 0,
  templatesDriftedCount: 0,
  credentialSource: "member",
  siteKeyHint: null,
  siteKeyStale: false,
  refreshSkipped: null,
  refreshedAt: null,
  createdAt: "2026-11-20T10:00:00.000Z",
  updatedAt: "2026-11-20T10:00:00.000Z",
  ...over,
});
const myTeams = (active: string) => ({
  activeTeamId: active,
  lastTeamId: active,
  teams: [
    { id: TEAM, name: "Team1", slug: "team1", role: "team_admin" },
    { id: OTHER, name: "Ops", slug: "ops", role: "member" },
  ],
});
const routes = (over: Record<string, unknown> = {}) => ({
  [`GET ${BASE}`]: [200, { connectors: [massive()] }],
  [`GET ${BASE}/${ID}/tools`]: [200, { tools: [] }],
  [`GET ${BASE}/${ID}/templates`]: [200, { templates: [] }],
  [`GET ${BASE}/${ID}/teams`]: [
    200,
    { teams: [{ id: TEAM, name: "Team1", slug: "team1", exposure: "all", enabledTools: 0 }] },
  ],
  "GET /v1/me/teams": [200, myTeams(TEAM)],
  [`GET ${GRANTS}`]: [200, { grants: [] }],
  ...over,
});

let assign: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  forbidNativeConfirm();
  assign = vi.spyOn(browserNavigation, "assign").mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/admin/site/connectors");
});

async function openPanel() {
  renderSite(<ConnectorsPage />);
  await userEvent.click(
    await screen.findByRole("button", { name: "Connect your account to massive" }),
  );
  const panel = await screen.findByRole("dialog", { name: "Connector massive" });
  return within(panel);
}

describe("Site console: connect an account to an OAuth connector (KOBE-835)", () => {
  it("flags a connector with no tools in the list and explains why in its details", async () => {
    stubApi(routes() as never);
    const panel = await openPanel();
    expect(screen.getByText("No tools yet: connect an account")).toBeTruthy();
    const mine = within(panel.getByRole("region", { name: "Your account" }));
    expect(mine.getByText(/site admin's own connected account/)).toBeTruthy();
    expect(await mine.findByText("Not connected")).toBeTruthy();
    expect(mine.getByText("In Team1")).toBeTruthy();
  });

  it("connects in the active workspace and asks to come back to the Site console", async () => {
    const calls = stubApi(
      routes({
        [`POST ${GRANTS}/${ID}/oauth/start`]: [200, { authorization_url: AUTHORIZE }],
      }) as never,
    );
    const panel = await openPanel();
    const mine = within(panel.getByRole("region", { name: "Your account" }));
    await mine.findByText("Not connected");
    await userEvent.click(mine.getByRole("button", { name: "Connect your account to massive" }));
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith(AUTHORIZE));
    const post = calls.find((c) => c.method === "POST");
    expect(JSON.parse(String(post?.body))).toEqual({ return_to: "site" });
    expect(post?.headers.get("x-kobe-team")).toBe(TEAM);
  });

  it("says when the active workspace has not enabled the connector, and does not start", async () => {
    stubApi(routes({ "GET /v1/me/teams": [200, myTeams(OTHER)] }) as never);
    const panel = await openPanel();
    const mine = within(panel.getByRole("region", { name: "Your account" }));
    expect(
      await mine.findByText(/your active workspace, Ops, which has not enabled massive/),
    ).toBeTruthy();
    const button = mine.getByRole("button", { name: "Connect your account to massive" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("comes back with the result, reopens the connector and pins its tools with Re-probe", async () => {
    window.history.replaceState(
      null,
      "",
      `/admin/site/connectors?connector_oauth=connected&connector=${ID}`,
    );
    const calls = stubApi(
      routes({
        [`GET ${BASE}`]: [
          [200, { connectors: [massive()] }],
          [200, { connectors: [massive({ toolCount: 120 })] }],
        ],
        [`GET ${GRANTS}`]: [
          200,
          {
            grants: [
              {
                connector_id: ID,
                hint: "••••",
                kind: "oauth",
                expires_at: new Date(Date.now() + 3_600_000).toISOString(),
                created_at: "2026-11-23T10:00:00Z",
                updated_at: "2026-11-23T10:00:00Z",
              },
            ],
          },
        ],
        [`POST ${BASE}/${ID}/refresh`]: [
          200,
          {
            connector: massive({ toolCount: 120 }),
            refresh: { status: "pinned", tools: 120, templates: 0, message: "Pinned 120 tools." },
          },
        ],
      }) as never,
    );
    renderSite(<ConnectorsPage />);
    const panel = within(await screen.findByRole("dialog", { name: "Connector massive" }));
    expect(panel.getByText("Connected your account to massive.")).toBeTruthy();
    expect(window.location.search).toBe("");
    const mine = within(panel.getByRole("region", { name: "Your account" }));
    expect(await mine.findByText("Connected")).toBeTruthy();
    await userEvent.click(mine.getByRole("button", { name: "Re-probe massive" }));
    expect(await panel.findByText("Pinned 120 tools.")).toBeTruthy();
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/refresh"))).toBe(true);
  });
});
