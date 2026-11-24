// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderSite, stubApi, summary } from "../testing";
import { UsersPage } from "./users-page";

/**
 * Site console › Users, sign-in protection (KOBE-812): accounts whose sign-in is slowed after
 * repeated failures get a notice and a status badge; requests without a trusted client address
 * get a notice pointing at the trusted proxies setting.
 */
const USER = (id: string, name: string) => ({
  id,
  name,
  email: `${name.toLowerCase()}@example.test`,
  siteRole: "user",
  twoFactorEnabled: false,
  deactivatedAt: null,
  createdAt: "2026-11-01T10:00:00Z",
});
const USERS = { users: [USER("u-1", "Ada"), USER("u-2", "Bo")] };
const PROTECTION = "GET /v1/site/users/sign-in-protection";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("sign-in protection on the Users page", () => {
  it("names the throttled accounts and badges them", async () => {
    stubApi({
      "GET /v1/site/users": [200, USERS],
      [PROTECTION]: [
        200,
        { throttled: [{ userId: "u-2", until: "2099-01-01T10:15:00Z" }], unknownClientIp: null },
      ],
    });
    renderSite(<UsersPage />);
    const notice = await screen.findByText(/Sign-in is slowed down for Bo/);
    expect(notice.textContent).toContain("10 failed attempts in 15 minutes");
    const row = screen.getByRole("row", { name: /Bo/ });
    expect(within(row).getByText("Sign-in slowed")).toBeTruthy();
    expect(
      within(screen.getByRole("row", { name: /Ada/ })).queryByText("Sign-in slowed"),
    ).toBeNull();
    expect(screen.queryByText(/client address/)).toBeNull();
  });

  it("warns when requests arrived without a trusted client address", async () => {
    stubApi({
      "GET /v1/site/users": [200, USERS],
      [PROTECTION]: [200, { throttled: [], unknownClientIp: { since: "2026-11-22T08:00:00Z" } }],
    });
    renderSite(<UsersPage />);
    const notice = await screen.findByText(/without a client address Kaiju can trust/);
    expect(notice.textContent).toContain("auth.trustedProxies");
    expect(screen.queryByText(/Sign-in is slowed down/)).toBeNull();
  });

  it.each([
    ["all is well", [200, { throttled: [], unknownClientIp: null }]],
    ["the check fails", [500, { code: "internal", message: "Something went wrong." }]],
    ["the check is not there", undefined],
  ] as const)("shows nothing extra when %s, and the users still load", async (_, reply) => {
    const calls = stubApi({
      "GET /v1/site/users": [200, USERS],
      ...(reply ? { [PROTECTION]: reply } : {}),
    });
    renderSite(<UsersPage />);
    await screen.findByRole("row", { name: /Ada/ });
    await waitFor(() => expect(summary(calls)).toContain(PROTECTION));
    expect(screen.queryByText(/Sign-in is slowed down/)).toBeNull();
    expect(screen.queryByText(/client address/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
