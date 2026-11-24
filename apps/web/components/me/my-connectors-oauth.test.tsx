// @vitest-environment happy-dom
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserNavigation } from "../../lib/admin/api/team/connector-grants";
import { answerConfirm, forbidNativeConfirm, renderTeam, stubApi } from "../admin/testing";
import { MyConnectorsPage } from "./my-connectors-page";

/** KOBE-835: OAuth connectors on My connectors (Connect, Reconnect, Disconnect, the result). */
const TEAM_CONNECTORS = "/v1/team/connectors";
const GRANTS = "/v1/connector-grants";
const ID = "0b4f1c2e-1111-4a2b-9c3d-123456789abc";
const START = `POST ${GRANTS}/${ID}/oauth/start`;
const MEMBER = { role: "member", permissions: ["team.chat"] } as const;
const GIT = {
  "GET /v1/team/git/connections": [
    200,
    { connections: [], site: { enabled: true }, limit: 5, envelope_configured: true },
  ],
} as const;
const massive = {
  id: ID,
  name: "massive",
  auth_kind: "oauth",
  credential_source: "member",
  site_key_ready: false,
  status: "active",
  icon_url: null,
  enabled: true,
  exposure: "all",
  enabled_tools: [],
  // No tools pinned yet: still listed, so a member can connect first.
  tools: [],
};
const grant = (expires: string | null) => ({
  connector_id: ID,
  hint: "••••",
  kind: "oauth",
  expires_at: expires,
  created_at: "2026-11-20T10:00:00Z",
  updated_at: "2026-11-20T10:00:00Z",
});
const FUTURE = new Date(Date.now() + 3_600_000).toISOString();
const PAST = new Date(Date.now() - 3_600_000).toISOString();
const AUTHORIZE = "https://auth.massive.example/authorize?client_id=x&state=s";

let assign: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  forbidNativeConfirm();
  assign = vi.spyOn(browserNavigation, "assign").mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/me/connectors");
});

const card = () => within(screen.getByRole("article", { name: "massive" }));
function routes(grants: unknown[], extra: Record<string, unknown> = {}) {
  return stubApi({
    ...GIT,
    [`GET ${TEAM_CONNECTORS}`]: [200, { connectors: [massive] }],
    [`GET ${GRANTS}`]: [200, { grants }],
    ...(extra as Record<string, never>),
  });
}

describe("My connectors: OAuth (KOBE-835)", () => {
  it("is titled for accounts and keys, not keys only", async () => {
    routes([]);
    renderTeam(<MyConnectorsPage />, MEMBER);
    expect(await screen.findByRole("heading", { name: "My connectors" })).toBeTruthy();
    expect(
      screen.getByText(/connect your own account \(OAuth\) or add your own API key/),
    ).toBeTruthy();
  });

  it("connects: starts the flow and sends the browser to the authorization server", async () => {
    const calls = routes([], { [START]: [200, { authorization_url: AUTHORIZE }] });
    renderTeam(<MyConnectorsPage />, MEMBER);
    await screen.findByRole("article", { name: "massive" });
    expect(card().getByText("Not connected")).toBeTruthy();
    expect(card().queryByRole("button", { name: /Disconnect/ })).toBeNull();
    await userEvent.click(card().getByRole("button", { name: "Connect massive" }));
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith(AUTHORIZE));
    const post = calls.find((c) => c.method === "POST");
    expect(JSON.parse(String(post?.body))).toEqual({});
    expect(post?.headers.get("x-kobe-team")).toBeTruthy();
  });

  it("never follows an authorization URL that is not http(s)", async () => {
    routes([], { [START]: [200, { authorization_url: "javascript:alert(1)" }] });
    renderTeam(<MyConnectorsPage />, MEMBER);
    await screen.findByRole("article", { name: "massive" });
    await userEvent.click(card().getByRole("button", { name: "Connect massive" }));
    expect(await screen.findByText(/sign-in page could not be opened/)).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
  });

  it.each([
    [
      422,
      "oauth_unsupported",
      "This connector's authorization server cannot be used safely with Kobe.",
    ],
    [429, "rate_limited", "Too many connection attempts. Try again in a few minutes."],
    [502, "oauth_unreachable", "Could not reach the connector's authorization server."],
    [503, "credentials_unavailable", "This site cannot store credentials yet."],
  ])("shows the server's sentence for a %i on start", async (status, code, message) => {
    routes([], { [START]: [status, { code, message }] });
    renderTeam(<MyConnectorsPage />, MEMBER);
    await screen.findByRole("article", { name: "massive" });
    await userEvent.click(card().getByRole("button", { name: "Connect massive" }));
    expect(await screen.findByText(message)).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
  });

  it("shows a connected account with Reconnect and Disconnect; Disconnect deletes the grant", async () => {
    const calls = stubApi({
      ...GIT,
      [`GET ${TEAM_CONNECTORS}`]: [200, { connectors: [massive] }],
      [`GET ${GRANTS}`]: [
        [200, { grants: [grant(FUTURE)] }],
        [200, { grants: [] }],
      ],
      [`DELETE ${GRANTS}/${ID}`]: [204],
      [START]: [200, { authorization_url: AUTHORIZE }],
    });
    renderTeam(<MyConnectorsPage />, MEMBER);
    await screen.findByText("Connected");
    expect(card().getByRole("button", { name: "Reconnect massive" })).toBeTruthy();
    await userEvent.click(card().getByRole("button", { name: "Disconnect massive" }));
    await answerConfirm("Disconnect your account from massive?", "Cancel");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await userEvent.click(card().getByRole("button", { name: "Disconnect massive" }));
    expect(await answerConfirm("Disconnect your account from massive?", "Disconnect")).toMatch(
      /deletes your sign-in/,
    );
    expect(await screen.findByText("Disconnected from massive.")).toBeTruthy();
    expect(await screen.findByText("Not connected")).toBeTruthy();
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  it("says when the sign-in expired and offers Reconnect", async () => {
    routes([grant(PAST)], { [START]: [200, { authorization_url: AUTHORIZE }] });
    renderTeam(<MyConnectorsPage />, MEMBER);
    expect(await screen.findByText("Sign-in expired")).toBeTruthy();
    await userEvent.click(card().getByRole("button", { name: "Reconnect massive" }));
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith(AUTHORIZE));
  });
});

describe("the sign-in result (KOBE-835)", () => {
  it("shows a success notice naming the connector from the page's own list, then clears the address", async () => {
    window.history.replaceState(
      null,
      "",
      `/me/connectors?connector_oauth=connected&connector=${ID}&keep=1`,
    );
    routes([grant(FUTURE)]);
    renderTeam(<MyConnectorsPage />, MEMBER);
    expect(await screen.findByText("Connected your account to massive.")).toBeTruthy();
    expect(window.location.search).toBe("?keep=1");
  });

  it("shows a failure with Kobe's own sentence for a known reason", async () => {
    window.history.replaceState(
      null,
      "",
      `/me/connectors?connector_oauth=failed&connector=${ID}&reason=access_denied`,
    );
    routes([]);
    renderTeam(<MyConnectorsPage />, MEMBER);
    const alert = await screen.findByText(/Could not connect your account to massive/);
    expect(alert.textContent).toContain("cancelled or refused at the service");
    expect(window.location.search).toBe("");
  });

  it("never shows query text as given: unknown reasons and connectors get fixed words", async () => {
    const evil = encodeURIComponent('<img src=x onerror="alert(1)">');
    window.history.replaceState(
      null,
      "",
      `/me/connectors?connector_oauth=failed&connector=${evil}&reason=${evil}`,
    );
    routes([]);
    renderTeam(<MyConnectorsPage />, MEMBER);
    expect(
      await screen.findByText(
        "Could not connect your account to the connector. Try connecting again.",
      ),
    ).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
    expect(document.body.textContent).not.toContain("onerror");
  });
});
