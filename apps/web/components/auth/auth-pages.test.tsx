// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ForgotPasswordPage from "../../app/forgot-password/page";
import InvitePage from "../../app/invite/page";
import LinkSignInPage from "../../app/link-sign-in/page";
import ResetPasswordPage from "../../app/reset-password/page";
import SetupPage from "../../app/setup/page";
import { DEFAULT_BRANDING } from "../../lib/theme/branding-defaults";
import { BrandingProvider } from "../shell/branding-context";
import { AuthPanel } from "./auth-panel";

/**
 * KOBE-755 ac-2 and ac-6: every signed-out page renders in the one AuthPanel (centred, at most
 * 400 px wide, 16 px gutter, the themed page background), named by its title, with the Site's
 * logo when there is one.
 */
vi.mock("../../lib/auth-client", () => ({ authClient: {} }));
vi.mock("../../lib/admin/api/site/sso-links", () => ({
  getPendingSsoLink: vi.fn(async () => ({ ok: true, data: null })),
  confirmPendingSsoLink: vi.fn(),
  discardPendingSsoLink: vi.fn(),
}));

const NAME = "Acme Agents";

function renderPage(node: ReactNode, logo: (typeof DEFAULT_BRANDING)["logo"] = null) {
  return render(
    <BrandingProvider value={{ ...DEFAULT_BRANDING, appName: NAME, logo }}>
      {node}
    </BrandingProvider>,
  );
}

const panelEl = () => document.querySelector("[data-auth-panel]");

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url === "/v1/setup"
        ? new Response(JSON.stringify({ required: true }))
        : new Response(null, { status: 404 }),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AuthPanel (ac-2)", () => {
  it("centres one panel of at most 400 px on the themed page, 16 px gutter on a phone", () => {
    renderPage(
      <AuthPanel title="A title" footer={<a href="/sign-in">Back</a>}>
        <p>Body</p>
      </AuthPanel>,
    );
    const page = must(document.querySelector("[data-auth-page]"));
    expect(page.className).toMatch(/bg-console-panel/);
    expect(page.className).toMatch(/font-sans/);
    const main = must(page.querySelector("main"));
    expect(main.className).toMatch(/items-center/);
    expect(main.className).toMatch(/justify-center/);
    expect(main.className).toMatch(/px-4/); // 16 px
    const panel = screen.getByRole("region", { name: "A title" });
    expect(panel.className).toMatch(/max-w-\[400px\]/);
    expect(panel.className).toMatch(/w-full/);
    expect(panel.className).toMatch(/bg-console-bg/);
    // Self-contained: no class whose rules live only under the chat or console roots.
    expect(panel.className).not.toMatch(/(^|\s)kaiju-panel(\s|$)/);
    expect(panel.className).toContain("hover:border-[var(--kaiju-panel-border-hover)]");
    expect(within(panel).getByRole("contentinfo").textContent).toBe("Back");
  });

  it("shows the Site's logo when there is one, and no logo row without", () => {
    renderPage(<AuthPanel title="T">x</AuthPanel>);
    expect(document.querySelector("[data-auth-logo]")).toBeNull();
    cleanup();
    renderPage(<AuthPanel title="T">x</AuthPanel>, {
      url: "/v1/site/branding/assets/logo.png",
      dark: null,
      inline: null,
      width: 100,
      height: 40,
    } as unknown as (typeof DEFAULT_BRANDING)["logo"]);
    const logo = must(document.querySelector("[data-auth-logo]"));
    expect(logo.querySelector("img")?.getAttribute("src")).toBe(
      "/v1/site/branding/assets/logo.png",
    );
  });
});

describe("the signed-out pages share the AuthPanel (ac-6)", () => {
  it("forgot password", () => {
    renderPage(<ForgotPasswordPage />);
    const panel = screen.getByRole("region", { name: "Reset your password" });
    expect(panel).toBe(panelEl());
    expect(within(panel).getByLabelText("Email").getAttribute("autocomplete")).toBe("username");
    expect(within(panel).getByRole("link", { name: "Back to sign in" })).toBeTruthy();
  });

  it("reset password", async () => {
    window.history.replaceState(null, "", "/reset-password#token=abcdefghijklmnop0123");
    renderPage(<ResetPasswordPage />);
    const panel = await screen.findByRole("region", { name: "Choose a new password" });
    expect(panel).toBe(panelEl());
    expect(within(panel).getByLabelText("New password").getAttribute("autocomplete")).toBe(
      "new-password",
    );
  });

  it("invite (an invalid link)", async () => {
    renderPage(<InvitePage />);
    const panel = await screen.findByRole("region", { name: "Invitation not valid" });
    expect(panel).toBe(panelEl());
  });

  it("setup", async () => {
    renderPage(<SetupPage />);
    const panel = await screen.findByRole("region", { name: `Set up ${NAME}` });
    expect(panel).toBe(panelEl());
    expect(within(panel).getByLabelText("Setup token")).toBeTruthy();
  });

  it("setup says plainly when there were too many attempts (KOBE-813)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === "POST"
          ? new Response(JSON.stringify({ code: "rate_limited", message: "x" }), { status: 429 })
          : new Response(JSON.stringify({ required: true })),
      ),
    );
    const user = userEvent.setup();
    renderPage(<SetupPage />);
    const panel = await screen.findByRole("region", { name: `Set up ${NAME}` });
    await user.type(within(panel).getByLabelText("Setup token"), "guess");
    await user.type(within(panel).getByLabelText("Name"), "Owner");
    await user.type(within(panel).getByLabelText("Email"), "owner@example.test");
    await user.type(within(panel).getByLabelText("Password"), "a long enough password");
    await user.click(within(panel).getByRole("button", { name: "Create Owner" }));
    expect(
      await within(panel).findByText("Too many setup attempts. Wait a few minutes and try again."),
    ).toBeTruthy();
  });

  it("link sign-in", async () => {
    renderPage(<LinkSignInPage />);
    const panel = screen.getByRole("region", { name: "Link your organization sign-in" });
    expect(panel).toBe(panelEl());
    expect(await within(panel).findByText("Nothing is waiting to be linked.")).toBeTruthy();
  });
});

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("missing");
  return value;
}
