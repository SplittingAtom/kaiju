// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BRANDING } from "../../lib/theme/branding-defaults";
import { BrandingProvider } from "../shell/branding-context";
import { InviteForm } from "./invite-form";

/**
 * The invitation page (U1) and KOBE-774: while the Site requires single sign-on, an invited person
 * gets the provider buttons instead of the name and password form (the server refuses a password
 * invitation then).
 */
const corp = { slug: "corp", displayName: "Contoso" };

function stub(providers: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/auth/invitation/lookup") {
        return new Response(JSON.stringify({ email: "new@example.com", expiresAt: "x" }));
      }
      if (url === "/api/auth/sso/providers") return new Response(JSON.stringify(providers));
      return new Response("{}", { status: 404 });
    }),
  );
}

function renderForm() {
  return render(
    <BrandingProvider value={{ ...DEFAULT_BRANDING, appName: "Acme" }}>
      <InviteForm />
    </BrandingProvider>,
  );
}

beforeEach(() => {
  window.history.replaceState(null, "", "/invite#token=abcdefghijklmnopqrstuvwx");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("InviteForm", () => {
  it("asks for a name and password while local sign-in is allowed", async () => {
    stub({ providers: [corp], ssoRequired: false });
    renderForm();
    expect(await screen.findByLabelText("Password")).toBeTruthy();
    expect(screen.getByText("new@example.com")).toBeTruthy();
  });

  it("offers only the provider buttons while the Site requires single sign-on", async () => {
    stub({ providers: [corp], ssoRequired: true });
    renderForm();
    expect(await screen.findByRole("link", { name: "Sign in with Contoso" })).toBeTruthy();
    expect(screen.getByText(/requires single sign-on/i)).toBeTruthy();
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create account" })).toBeNull();
  });
});
