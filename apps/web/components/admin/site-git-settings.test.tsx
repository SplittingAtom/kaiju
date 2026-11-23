// @vitest-environment happy-dom
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { must } from "../../lib/testing/must";
import { SettingsPage } from "./site/settings-page";
import { forbidNativeConfirm, renderSite, stubApi } from "./testing";

beforeEach(forbidNativeConfirm);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const settings = (over: Record<string, unknown> = {}) => ({
  requireTwoFactor: false,
  gitConnectionsEnabled: true,
  gitAllowedHosts: [],
  ...over,
});

async function gitForm() {
  return within(await screen.findByRole("form", { name: "Git connections" }));
}

describe("Site settings: git connections (KOBE-761, spec G3)", () => {
  it("shows the switch on and an empty list meaning any host, and says what off does", async () => {
    stubApi({ "GET /v1/site/settings": [200, settings()] });
    renderSite(<SettingsPage />, "admin");
    const form = await gitForm();
    const box = form.getByRole("checkbox", { name: /Allow Workspaces to connect/ });
    expect((box as HTMLInputElement).checked).toBe(true);
    expect(form.getByText(/git in sandboxes stops using existing connections/)).toBeTruthy();
    expect(form.getByText(/Leave empty to allow any host/)).toBeTruthy();
    expect(form.getByRole("button", { name: "Save git connections" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("turns git connections off", async () => {
    const calls = stubApi({
      "GET /v1/site/settings": [200, settings({ gitAllowedHosts: ["github.com"] })],
      "PUT /v1/site/settings": [
        200,
        settings({ gitConnectionsEnabled: false, gitAllowedHosts: ["github.com"] }),
      ],
    });
    renderSite(<SettingsPage />, "admin");
    const form = await gitForm();
    await userEvent.click(form.getByRole("checkbox", { name: /Allow Workspaces to connect/ }));
    await userEvent.click(form.getByRole("button", { name: "Save git connections" }));
    await screen.findByText("Git connections are now off for every Workspace.");
    const put = must(calls.find((c) => c.method === "PUT"));
    expect(JSON.parse(String(put.body))).toEqual({
      gitConnectionsEnabled: false,
      gitAllowedHosts: ["github.com"],
    });
  });

  it("names each bad host line with the server's rule and sends nothing", async () => {
    const calls = stubApi({ "GET /v1/site/settings": [200, settings()] });
    renderSite(<SettingsPage />, "admin");
    const form = await gitForm();
    const list = form.getByRole("textbox", { name: /Allowed git hosts/ });
    await userEvent.type(list, "github.com{enter}https://git.example.com{enter}*.co.uk");
    await userEvent.click(form.getByRole("button", { name: "Save git connections" }));
    const alert = await form.findByRole("alert");
    expect(alert.textContent).toMatch(
      /Line 2 \(https:\/\/git\.example\.com\): enter a host name only, without scheme, port or path\./,
    );
    expect(alert.textContent).toMatch(
      /Line 3 \(\*\.co\.uk\): a wildcard on the public suffix co\.uk/,
    );
    expect(list.getAttribute("aria-invalid")).toBe("true");
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("saves a canonical, sorted host list", async () => {
    const calls = stubApi({
      "GET /v1/site/settings": [200, settings()],
      "PUT /v1/site/settings": [
        200,
        settings({ gitAllowedHosts: ["*.corp.example", "github.com"] }),
      ],
    });
    renderSite(<SettingsPage />, "admin");
    const form = await gitForm();
    await userEvent.type(
      form.getByRole("textbox", { name: /Allowed git hosts/ }),
      "GitHub.com{enter}{enter}*.corp.example{enter}github.com",
    );
    await userEvent.click(form.getByRole("button", { name: "Save git connections" }));
    await screen.findByText(
      "Git connections are on; Workspaces may connect to *.corp.example, github.com.",
    );
    const put = must(calls.find((c) => c.method === "PUT"));
    expect(JSON.parse(String(put.body))).toEqual({
      gitConnectionsEnabled: true,
      gitAllowedHosts: ["*.corp.example", "github.com"],
    });
  });

  it("is absent on a server that predates git connections", async () => {
    stubApi({ "GET /v1/site/settings": [200, { requireTwoFactor: false }] });
    renderSite(<SettingsPage />, "admin");
    await screen.findByRole("form", { name: "Site settings" });
    expect(screen.queryByRole("form", { name: "Git connections" })).toBeNull();
  });
});
