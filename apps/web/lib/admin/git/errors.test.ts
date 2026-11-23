import { describe, expect, it } from "vitest";
import type { ApiError } from "../../api/client";
import { failureDetail, gitErrorMessage, healthMessage, insufficientReport } from "./errors";

const err = (code: string, message = "fixed text", test?: Record<string, unknown>): ApiError => ({
  status: 422,
  code,
  message,
  ...(test ? { details: { code, message, test } } : {}),
});

describe("gitErrorMessage (KOBE-761 mapping of KOBE-760's typed errors)", () => {
  it.each([
    ["credential_rejected", "credential_rejected", /did not accept the credential/],
    ["credential_rejected", "installation_removed", /not installed on this organization/],
    [
      "credential_rejected",
      "installation_suspended",
      /installation on this organization is suspended/,
    ],
    ["credential_rejected", "installation_account_mismatch", /belongs to another account/],
    ["credential_rejected", "invalid_private_key", /private key is not this App's/],
    ["credential_forbidden", "token_owner_mismatch", /token belongs to another account/],
    ["credential_forbidden", "user_namespace", /cannot act in a personal account/],
    ["unsupported_host", "version_unreadable", /did not say which version/],
    ["host_refused", "redirect", /redirect Kobe does not follow/],
  ])("%s / %s", (code, reason, expected) => {
    expect(gitErrorMessage(err(code, "x", { code: "auth_failed", reason }))).toMatch(expected);
  });

  it("names a missing permission the host asked for", () => {
    const e = err("credential_forbidden", "x", {
      code: "forbidden",
      missing_permission: "ignored",
      missingPermission: "issues=write",
    });
    expect(gitErrorMessage(e)).toBe(
      "The credential lacks a permission the host asked for: issues=write. Add it on the host, then test again.",
    );
  });

  it("keeps the server's own sentence where it carries the facts", () => {
    const old = err(
      "unsupported_host",
      "The git host runs Gitea 1.25.4; Kobe supports Gitea 1.26.0 and later.",
      {
        code: "unsupported_host",
        reason: "version_too_old",
      },
    );
    expect(gitErrorMessage(old)).toBe(
      "The git host runs Gitea 1.25.4; Kobe supports Gitea 1.26.0 and later.",
    );
    expect(
      gitErrorMessage(
        err("host_not_allowed", "This Site does not allow Git connections to x.org."),
      ),
    ).toBe(
      "This Site does not allow Git connections to x.org. A Site admin can add the host to the Site's allowed git hosts.",
    );
    expect(gitErrorMessage(err("connection_limit", "At most 5."))).toBe("At most 5.");
  });

  it("says when to retry after the host's rate limit", () => {
    const e = err("host_rate_limited", "x", { code: "rate_limited", retryAt: "nonsense" });
    expect(gitErrorMessage(e)).toMatch(/used up\. Try again in a few minutes\.$/);
    const at = err("host_rate_limited", "x", {
      code: "rate_limited",
      retryAt: "2026-11-22T10:30:00.000Z",
    });
    expect(gitErrorMessage(at)).toMatch(/Try again after /);
  });

  it("names the organization and the provider when it has them", () => {
    expect(
      gitErrorMessage(err("organization_not_found"), undefined, { organization: "acme" }),
    ).toMatch(/no organization or user named acme/);
    expect(
      gitErrorMessage(err("unsupported_host"), undefined, { providerLabel: "Forgejo" }),
    ).toMatch(/does not answer like a Forgejo server/);
  });

  it.each([
    ["git_disabled", /turned off for this Site/],
    ["git_unavailable", /no encryption key/],
    ["host_unreachable", /could not reach the host/],
    ["host_error", /answered with an error/],
    ["invalid_connection", /Check the organization name/],
    ["internal_not_offered", /choose Private/],
  ])("%s", (code, expected) => {
    expect(gitErrorMessage(err(code))).toMatch(expected);
  });
});

describe("failureDetail / insufficientReport", () => {
  it("reads the test codes, ignoring anything that is not a string", () => {
    expect(failureDetail(err("x", "y", { code: "forbidden", reason: 3, retryAt: "t" }))).toEqual({
      code: "forbidden",
      retryAt: "t",
    });
    expect(failureDetail(err("x"))).toBeUndefined();
  });

  it("returns the report of a credential_insufficient answer only", () => {
    const report = { ok: false, capabilities: { read: "yes" }, missing: ["write"] };
    expect(insufficientReport(err("credential_insufficient", "x", report))).toEqual(report);
    expect(insufficientReport(err("credential_rejected", "x", report))).toBeUndefined();
  });
});

describe("healthMessage", () => {
  it("maps stored codes with and without reasons, and anything else to a plain sentence", () => {
    expect(healthMessage("auth_failed:installation_removed")).toMatch(/no longer installed/);
    expect(healthMessage("auth_failed:credential_rejected")).toMatch(/no longer accepts/);
    expect(healthMessage("weird")).toBe("The last check failed.");
    expect(healthMessage(null)).toBe("The last check failed.");
  });
});
