// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BRANDING } from "../../lib/theme/branding-defaults";
import { BrandingProvider } from "../shell/branding-context";
import { SignInForm } from "./sign-in-form";

/**
 * KOBE-755: the sign-in page's panel. Email, password, Sign in and "Forgot your password?" come
 * first; one button per identity provider and the passkey button follow an "or" divider, which is
 * not there when nothing follows it. The name comes from the Site branding. The TOTP step and the
 * errors (a wrong password, `?sso_error=`) stay in the panel. Authentication is Better Auth's.
 */
const auth = vi.hoisted(() => ({
  email: vi.fn(),
  passkey: vi.fn(),
  verifyTotp: vi.fn(),
}));
vi.mock("../../lib/auth-client", () => ({
  authClient: {
    signIn: { email: auth.email, passkey: auth.passkey },
    twoFactor: { verifyTotp: auth.verifyTotp },
  },
}));
vi.mock("../../lib/admin/api/site/sso-links", () => ({
  getPendingSsoLink: vi.fn(async () => ({ ok: true, data: null })),
}));

const NAME = "Acme Agents";
const assign = vi.fn();

function renderForm(node: ReactNode) {
  return render(
    <BrandingProvider value={{ ...DEFAULT_BRANDING, appName: NAME }}>{node}</BrandingProvider>,
  );
}

const panel = () => screen.getByRole("region", { name: `Sign in to ${NAME}` });
const field = (label: string) => within(panel()).getByLabelText(label) as HTMLInputElement;
/** Whether the elements are in this order in the document. */
function inOrder(...els: Element[]) {
  for (let i = 1; i < els.length; i += 1) {
    const prev = els[i - 1];
    const next = els[i];
    if (prev === undefined || next === undefined) continue;
    expect(prev.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
}
const divider = () => document.querySelector("[data-auth-divider]");

beforeEach(() => {
  window.history.replaceState(null, "", "/sign-in");
  vi.spyOn(window.location, "assign").mockImplementation(assign);
  auth.email.mockReset();
  auth.passkey.mockReset();
  auth.verifyTotp.mockReset();
  assign.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function withPasskeys() {
  vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
}

describe("the sign-in panel's order (ac-3)", () => {
  it("with no provider and no passkeys: the password form alone, no empty divider", async () => {
    vi.stubGlobal("PublicKeyCredential", undefined);
    renderForm(<SignInForm providers={[]} />);
    const email = field("Email");
    const password = field("Password");
    const submit = within(panel()).getByRole("button", { name: "Sign in" });
    const forgot = within(panel()).getByRole("link", { name: "Forgot your password?" });
    inOrder(screen.getByRole("heading", { level: 1, name: `Sign in to ${NAME}` }), email);
    inOrder(email, password, submit, forgot);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Sign in with a passkey" })).toBeNull(),
    );
    expect(divider()).toBeNull();
    expect(screen.queryByRole("group", { name: "Other ways to sign in" })).toBeNull();
  });

  it("with no provider: the passkey button below the divider", () => {
    withPasskeys();
    renderForm(<SignInForm providers={[]} />);
    const forgot = within(panel()).getByRole("link", { name: "Forgot your password?" });
    const group = within(panel()).getByRole("group", { name: "Other ways to sign in" });
    const passkey = within(group).getByRole("button", { name: "Sign in with a passkey" });
    inOrder(forgot, must(divider()), passkey);
    expect(within(group).queryByRole("list", { name: "Single sign-on" })).toBeNull();
  });

  it("with one provider: its button, labelled with its display name, after the divider", () => {
    withPasskeys();
    renderForm(<SignInForm providers={[{ slug: "entra", displayName: "Microsoft Entra ID" }]} />);
    const submit = within(panel()).getByRole("button", { name: "Sign in" });
    const entra = within(panel()).getByRole("link", { name: "Sign in with Microsoft Entra ID" });
    expect(entra.getAttribute("href")).toBe("/api/auth/sso/start/entra?returnTo=%2F");
    expect(entra.className).toMatch(/w-full/);
    const passkey = within(panel()).getByRole("button", { name: "Sign in with a passkey" });
    inOrder(submit, must(divider()), entra, passkey);
  });

  it("with several providers: one button each, in the server's order", () => {
    vi.stubGlobal("PublicKeyCredential", undefined);
    renderForm(
      <SignInForm
        providers={[
          { slug: "kc", displayName: "Keycloak" },
          { slug: "corp", displayName: "Contoso" },
          { slug: "entra", displayName: "Microsoft Entra ID" },
        ]}
      />,
    );
    const list = within(panel()).getByRole("list", { name: "Single sign-on" });
    expect(
      within(list)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(["Sign in with Keycloak", "Sign in with Contoso", "Sign in with Microsoft Entra ID"]);
    inOrder(field("Password"), must(divider()), list);
  });

  it("reads the providers in the browser when the server render could not", async () => {
    withPasskeys();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ providers: [{ slug: "corp", displayName: "Contoso" }] })),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderForm(<SignInForm providers={null} />);
    await within(panel()).findByRole("link", { name: "Sign in with Contoso" });
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/sso/providers", expect.anything());
  });

  it("does not ask the browser when the server render had the list", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderForm(<SignInForm providers={[]} />);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the autocomplete attributes password managers and passkeys rely on", () => {
    renderForm(<SignInForm providers={[]} />);
    expect(field("Email").getAttribute("autocomplete")).toBe("username webauthn");
    expect(field("Email").type).toBe("email");
    expect(field("Password").getAttribute("autocomplete")).toBe("current-password");
    expect(field("Password").type).toBe("password");
  });

  it("takes the name from the branding (no product name hard-coded)", () => {
    renderForm(<SignInForm providers={[]} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(`Sign in to ${NAME}`);
  });
});

describe("signing in (ac-5)", () => {
  it("a password sign-in goes to the app", async () => {
    auth.email.mockResolvedValue({ data: {}, error: null });
    renderForm(<SignInForm providers={[]} />);
    const user = userEvent.setup();
    await user.type(field("Email"), "ada@example.com");
    await user.type(field("Password"), "correct horse battery");
    await user.click(within(panel()).getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
    expect(auth.email).toHaveBeenCalledWith({
      email: "ada@example.com",
      password: "correct horse battery",
    });
  });

  it("a wrong password shows an alert in the panel", async () => {
    auth.email.mockResolvedValue({ data: null, error: { status: 401 } });
    renderForm(<SignInForm providers={[]} />);
    const user = userEvent.setup();
    await user.type(field("Email"), "ada@example.com");
    await user.type(field("Password"), "wrong");
    await user.click(within(panel()).getByRole("button", { name: "Sign in" }));
    const alert = await within(panel()).findByRole("alert");
    expect(alert.textContent).toContain("Email or password is incorrect.");
    expect(assign).not.toHaveBeenCalled();
  });

  it("too many attempts (429) says to wait, for the password and the code (KOBE-812)", async () => {
    auth.email
      .mockResolvedValueOnce({ data: null, error: { status: 429 } })
      .mockResolvedValueOnce({ data: { twoFactorRedirect: true }, error: null });
    auth.verifyTotp.mockResolvedValueOnce({ data: null, error: { status: 429 } });
    renderForm(<SignInForm providers={[]} />);
    const user = userEvent.setup();
    await user.type(field("Email"), "ada@example.com");
    await user.type(field("Password"), "wrong");
    await user.click(within(panel()).getByRole("button", { name: "Sign in" }));
    expect((await within(panel()).findByRole("alert")).textContent).toBe(
      "Too many sign-in attempts. Wait a minute, then try again.",
    );
    await user.click(within(panel()).getByRole("button", { name: "Sign in" }));
    const code = await within(panel()).findByLabelText("Authenticator code");
    await user.type(code, "123456");
    await user.click(within(panel()).getByRole("button", { name: "Verify" }));
    await waitFor(() =>
      expect(within(panel()).getByRole("alert").textContent).toBe(
        "Too many sign-in attempts. Wait a minute, then try again.",
      ),
    );
    expect(assign).not.toHaveBeenCalled();
  });

  it("with 2FA: the authenticator code in the same panel, then the app; a bad code alerts", async () => {
    auth.email.mockResolvedValue({ data: { twoFactorRedirect: true }, error: null });
    auth.verifyTotp
      .mockResolvedValueOnce({ data: null, error: { status: 401 } })
      .mockResolvedValueOnce({ data: {}, error: null });
    withPasskeys();
    renderForm(<SignInForm providers={[{ slug: "corp", displayName: "Contoso" }]} />);
    const user = userEvent.setup();
    await user.type(field("Email"), "ada@example.com");
    await user.type(field("Password"), "correct horse battery");
    await user.click(within(panel()).getByRole("button", { name: "Sign in" }));
    const code = (await within(panel()).findByLabelText("Authenticator code")) as HTMLInputElement;
    expect(code.getAttribute("autocomplete")).toBe("one-time-code");
    expect(code.getAttribute("inputmode")).toBe("numeric");
    // The other ways to sign in are not offered in the middle of a password sign-in.
    expect(screen.queryByRole("group", { name: "Other ways to sign in" })).toBeNull();
    expect(screen.queryByLabelText("Password")).toBeNull();
    await user.type(code, "123456");
    await user.click(within(panel()).getByRole("button", { name: "Verify" }));
    expect((await within(panel()).findByRole("alert")).textContent).toContain(
      "That code didn't work.",
    );
    await user.clear(code);
    await user.type(code, "654321");
    await user.click(within(panel()).getByRole("button", { name: "Verify" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
    expect(auth.verifyTotp).toHaveBeenLastCalledWith({ code: "654321" });
  });

  it("a failed SSO sign-in's ?sso_error= shows as an alert in the panel", async () => {
    window.history.replaceState(null, "", "/sign-in?sso_error=state_invalid");
    renderForm(<SignInForm providers={[{ slug: "corp", displayName: "Contoso" }]} />);
    const alert = await within(panel()).findByRole("alert");
    expect(alert.textContent).toBeTruthy();
    // The form and the provider buttons are still there to try again.
    expect(field("Email")).toBeTruthy();
    expect(within(panel()).getByRole("link", { name: "Sign in with Contoso" })).toBeTruthy();
  });

  it("a passkey sign-in failure alerts; a pending SSO link goes to its confirmation", async () => {
    withPasskeys();
    auth.passkey.mockResolvedValueOnce({ error: { status: 400 } });
    renderForm(<SignInForm providers={[]} />);
    const user = userEvent.setup();
    await user.click(within(panel()).getByRole("button", { name: "Sign in with a passkey" }));
    expect((await within(panel()).findByRole("alert")).textContent).toContain(
      "Passkey sign-in failed.",
    );
    const links = await import("../../lib/admin/api/site/sso-links");
    vi.mocked(links.getPendingSsoLink).mockResolvedValueOnce({
      ok: true,
      data: { providerName: "Contoso", email: "ada@contoso.com" },
    } as Awaited<ReturnType<typeof links.getPendingSsoLink>>);
    auth.passkey.mockResolvedValueOnce({ data: {}, error: null });
    await user.click(within(panel()).getByRole("button", { name: "Sign in with a passkey" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/link-sign-in"));
  });
});

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("missing");
  return value;
}

describe("when the Site requires single sign-on (KOBE-774)", () => {
  const corp = { slug: "corp", displayName: "Contoso" };

  it("offers only the provider buttons: no password, reset link or passkey", () => {
    withPasskeys();
    renderForm(<SignInForm providers={[corp]} ssoRequired />);
    expect(within(panel()).queryByLabelText("Email")).toBeNull();
    expect(within(panel()).queryByLabelText("Password")).toBeNull();
    expect(within(panel()).queryByRole("link", { name: "Forgot your password?" })).toBeNull();
    expect(within(panel()).queryByRole("button", { name: /passkey/i })).toBeNull();
    expect(divider()).toBeNull();
    expect(within(panel()).getByRole("link", { name: "Sign in with Contoso" })).toBeTruthy();
    expect(within(panel()).getByText(/requires single sign-on/i)).toBeTruthy();
  });

  it("asks the browser when the server render could not, and follows its answer", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ providers: [corp], ssoRequired: true })),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderForm(<SignInForm providers={null} />);
    await waitFor(() => expect(within(panel()).queryByLabelText("Password")).toBeNull());
    expect(within(panel()).getByRole("link", { name: "Sign in with Contoso" })).toBeTruthy();
  });

  it("keeps the password form when the setting is off", () => {
    renderForm(<SignInForm providers={[corp]} ssoRequired={false} />);
    expect(field("Password")).toBeTruthy();
  });
});
