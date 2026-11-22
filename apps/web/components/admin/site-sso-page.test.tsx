// @vitest-environment happy-dom
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { must } from "../../lib/testing/must";
import { SiteSsoPage } from "./site/sso-page";
import { answerConfirm, forbidNativeConfirm, renderSite, stubApi } from "./testing";

const TENANT = "11111111-2222-4333-8444-555555555555";
const BASE = "/v1/site/sso/providers";
const SECRET = "typed-secret-value-123";

const provider = (over: Record<string, unknown> = {}) => ({
  id: "p-1",
  slug: "contoso",
  display_name: "Contoso",
  kind: "entra",
  issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
  tenant_id: TENANT,
  client_id: "app-id",
  subject_claim: "oid",
  access_claim: "roles",
  mfa_rule: { amr_any: ["mfa"], acr_any: [], acrs_any: ["c1"] },
  allowed_email_domains: [],
  jit_provisioning: true,
  max_session_hours: null,
  enabled: false,
  managed_by: "console",
  client_secret: "set",
  redirect_uri: "https://kobe.example.com/api/auth/sso/callback/contoso",
  linked_identities: 0,
  created_at: "2026-11-11T10:00:00Z",
  updated_at: "2026-11-11T10:00:00Z",
  ...over,
});
const HELM = provider({
  id: "p-2",
  slug: "corp",
  display_name: "Corp",
  managed_by: "helm",
  enabled: true,
  client_secret: "missing",
});
const PASSED = {
  ok: true,
  issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
  checks: [
    { id: "tenant_pinned", ok: true, message: "The issuer is tenant-specific." },
    { id: "pkce_s256", ok: true, message: "PKCE with S256 is supported." },
  ],
};

beforeEach(forbidNativeConfirm);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const body = (calls: ReturnType<typeof stubApi>, method: string) =>
  JSON.parse(String(must(calls.find((c) => c.method === method)).body)) as Record<string, unknown>;

describe("site single sign-on page (KOBE-626)", () => {
  it("lists providers; a Helm provider is read-only (ac-4)", async () => {
    stubApi({ [`GET ${BASE}`]: [200, { providers: [provider(), HELM] }] });
    renderSite(<SiteSsoPage />);
    const helmRow = must((await screen.findByRole("rowheader", { name: /^Corp/ })).closest("tr"));
    expect(within(helmRow).getByText("Set in Helm values")).toBeTruthy();
    expect(within(helmRow).getByText("Missing")).toBeTruthy();
    expect(within(helmRow).getByRole("button", { name: /Test/ })).toBeTruthy();
    for (const name of [/Edit/, /Turn (on|off)/, /Delete/]) {
      expect(within(helmRow).queryByRole("button", { name })).toBeNull();
    }
    const consoleRow = must(screen.getByRole("rowheader", { name: /^Contoso/ }).closest("tr"));
    for (const name of [/Edit/, /Turn on/, /Delete/]) {
      expect(within(consoleRow).getByRole("button", { name })).toBeTruthy();
    }
    expect(consoleRow.textContent).toContain("/api/auth/sso/callback/contoso");
  });

  it("adds an Entra provider and clears the secret field after saving", async () => {
    const calls = stubApi({
      [`GET ${BASE}`]: [
        [200, { providers: [] }],
        [200, { providers: [provider()] }],
      ],
      [`POST ${BASE}`]: [201, { provider: provider(), discovery: PASSED }],
    });
    renderSite(<SiteSsoPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Add provider" }));
    const form = screen.getByRole("form", { name: "Add a provider" });
    await userEvent.type(within(form).getByLabelText(/Display name/), "Contoso");
    await userEvent.type(within(form).getByLabelText(/Slug/), "contoso");
    await userEvent.type(within(form).getByLabelText(/Directory \(tenant\) ID/), TENANT);
    await userEvent.type(within(form).getByLabelText(/Client ID/), "app-id");
    const secret = within(form).getByLabelText(/Client secret/) as HTMLInputElement;
    expect(secret.type).toBe("password");
    await userEvent.type(secret, SECRET);
    await userEvent.click(within(form).getByRole("button", { name: "Add provider" }));
    expect(await screen.findByText(/Added Contoso/)).toBeTruthy();
    expect(body(calls, "POST")).toEqual({
      kind: "entra",
      tenantId: TENANT,
      slug: "contoso",
      displayName: "Contoso",
      clientId: "app-id",
      clientSecret: SECRET,
      accessClaim: "roles",
    });
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it("tests discovery on the form and shows each check", async () => {
    const calls = stubApi({
      [`GET ${BASE}`]: [200, { providers: [] }],
      [`POST ${BASE}/test`]: [
        200,
        {
          discovery: {
            ok: false,
            issuer: null,
            failure: "multi_tenant_issuer",
            message: "Kobe accepts only a tenant-specific issuer.",
            checks: [
              {
                id: "tenant_pinned",
                ok: false,
                message: "Kobe accepts only a tenant-specific issuer.",
              },
            ],
          },
        },
      ],
    });
    renderSite(<SiteSsoPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Add provider" }));
    await userEvent.type(screen.getByLabelText(/Directory \(tenant\) ID/), "common");
    await userEvent.click(screen.getByRole("button", { name: "Test discovery" }));
    expect(await screen.findByText("Discovery failed")).toBeTruthy();
    const checks = screen.getByRole("list", { name: "Discovery checks" });
    expect(checks.textContent).toContain("Failed: Kobe accepts only a tenant-specific issuer.");
    expect(body(calls, "POST")).toEqual({ kind: "entra", tenantId: "common" });
  });

  it("edits without sending a secret unless one is typed", async () => {
    const calls = stubApi({
      [`GET ${BASE}`]: [200, { providers: [provider()] }],
      [`PATCH ${BASE}/p-1`]: [200, { provider: provider({ display_name: "Contoso Ltd" }) }],
    });
    renderSite(<SiteSsoPage />);
    await userEvent.click(await screen.findByRole("button", { name: /Edit/ }));
    const form = screen.getByRole("form", { name: "Edit provider" });
    expect((within(form).getByLabelText(/Client secret/) as HTMLInputElement).value).toBe("");
    const name = within(form).getByLabelText(/Display name/);
    await userEvent.clear(name);
    await userEvent.type(name, "Contoso Ltd");
    await userEvent.click(within(form).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved Contoso Ltd.")).toBeTruthy();
    const sent = body(calls, "PATCH");
    expect(sent).not.toHaveProperty("clientSecret");
    expect(sent).toMatchObject({ displayName: "Contoso Ltd", tenantId: TENANT });
  });

  it("asks before turning a provider off", async () => {
    const calls = stubApi({
      [`GET ${BASE}`]: [200, { providers: [provider({ enabled: true })] }],
      [`PATCH ${BASE}/p-1`]: [200, { provider: provider() }],
    });
    renderSite(<SiteSsoPage />);
    await userEvent.click(await screen.findByRole("button", { name: /Turn off/ }));
    const text = await answerConfirm(/Turn off Contoso/, "Turn off");
    expect(text).toContain("sessions end now");
    expect(await screen.findByText("Contoso is off.")).toBeTruthy();
    expect(body(calls, "PATCH")).toEqual({ enabled: false });
  });
});

describe("Require single sign-on (KOBE-774)", () => {
  const SETTINGS = "/v1/site/sso/settings";
  const enabledProvider = provider({ enabled: true });

  it("can't be turned on from a session that did not sign in with a provider", async () => {
    stubApi({
      [`GET ${BASE}`]: [200, { providers: [enabledProvider] }],
      [`GET ${SETTINGS}`]: [200, { require_sso: false, in_force: false, can_turn_on: false }],
    });
    renderSite(<SiteSsoPage />);
    const toggle = await screen.findByRole("switch", { name: "Require single sign-on" });
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/sign in with an enabled identity provider/i)).toBeTruthy();
  });

  it("turns on after a confirmation that names the break-glass command", async () => {
    const calls = stubApi({
      [`GET ${BASE}`]: [200, { providers: [enabledProvider] }],
      [`GET ${SETTINGS}`]: [
        [200, { require_sso: false, in_force: false, can_turn_on: true }],
        [200, { require_sso: true, in_force: true, can_turn_on: true }],
      ],
      [`PUT ${SETTINGS}`]: [200, { require_sso: true, in_force: true, can_turn_on: true }],
    });
    renderSite(<SiteSsoPage />);
    await userEvent.click(await screen.findByRole("switch", { name: "Require single sign-on" }));
    const text = await answerConfirm(/Require single sign-on\?/, "Require single sign-on");
    expect(text).toContain("kobe sso allow-local-sign-in");
    expect(text).toMatch(/password/i);
    expect(body(calls, "PUT")).toEqual({ requireSso: true });
    expect(await screen.findByText(/Single sign-on is now required/)).toBeTruthy();
  });

  it("turns off after a confirmation", async () => {
    const calls = stubApi({
      [`GET ${BASE}`]: [200, { providers: [enabledProvider] }],
      [`GET ${SETTINGS}`]: [200, { require_sso: true, in_force: true, can_turn_on: true }],
      [`PUT ${SETTINGS}`]: [200, { require_sso: false, in_force: false, can_turn_on: true }],
    });
    renderSite(<SiteSsoPage />, "owner");
    await userEvent.click(await screen.findByRole("switch", { name: "Require single sign-on" }));
    await answerConfirm(/Stop requiring single sign-on\?/, "Stop requiring");
    expect(body(calls, "PUT")).toEqual({ requireSso: false });
  });

  it("only the Owner can turn it off", async () => {
    stubApi({
      [`GET ${BASE}`]: [200, { providers: [enabledProvider] }],
      [`GET ${SETTINGS}`]: [200, { require_sso: true, in_force: true, can_turn_on: true }],
    });
    renderSite(<SiteSsoPage />, "admin");
    const toggle = await screen.findByRole("switch", { name: "Require single sign-on" });
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Only the Owner can turn this off/)).toBeTruthy();
  });

  it("says when it is stored on but not in force", async () => {
    stubApi({
      [`GET ${BASE}`]: [200, { providers: [] }],
      [`GET ${SETTINGS}`]: [200, { require_sso: true, in_force: false, can_turn_on: false }],
    });
    renderSite(<SiteSsoPage />);
    expect(await screen.findByText(/not in force/i)).toBeTruthy();
  });
});
