import { describe, expect, it } from "vitest";
import {
  GIT_ACCESS_LEVEL_VALUES,
  GIT_CREDENTIAL_KIND_VALUES,
  GIT_PROVIDER_VALUES,
  GIT_REPO_VISIBILITY_VALUES,
  GIT_CAPABILITY_VALUES,
} from "@kobe/db";
import {
  GIT_CONNECTION_ACCESS_LEVELS,
  GIT_CONNECTION_CAPABILITY_VALUES,
  GIT_CONNECTION_CREDENTIAL_KINDS,
  GIT_CONNECTION_PROVIDERS,
  GIT_CONNECTION_REPO_VISIBILITIES,
} from "@kobe/protocol";
import { GitHostError, type GitHostProbe } from "../git-hosts/adapter.js";
import {
  gitConnectionCreateBodySchema,
  gitConnectionTestBodySchema,
  gitConnectionUpdateBodySchema,
} from "./connection-schemas.js";
import { assessProbe, healthErrorCode, testFailure, testReport } from "./connection-test.js";
import { gitExpiryMessage } from "./expiry-notify.js";
import { GitHostBackoff } from "./health-job.js";

/** KOBE-760 (spec workspace-git G4, G6): judging a test, mapping failures, schemas, back-off. */

const probe = (over: Partial<GitHostProbe> = {}): GitHostProbe => ({
  provider: "github",
  organization: { id: "1", login: "acme", name: "Acme", kind: "organization", webUrl: "" },
  hostVersion: null,
  actor: { kind: "token", login: "bot" },
  capabilities: { create: "yes", read: "yes", write: "yes", admin: "no" },
  excess: [],
  credentialExpiresAt: null,
  rateLimit: null,
  ...over,
});

describe("assessProbe (G4)", () => {
  it("accepts a credential that does what the level needs", () => {
    expect(assessProbe(probe(), "read_write")).toEqual({ missing: [], warnings: [] });
  });

  it("refuses one that cannot read, or cannot write at Read and write", () => {
    const cannotRead = probe({
      capabilities: { create: "no", read: "no", write: "no", admin: "no" },
    });
    expect(assessProbe(cannotRead, "read").missing).toEqual(["read"]);
    const readOnly = probe({
      capabilities: { create: "no", read: "yes", write: "no", admin: "no" },
    });
    expect(assessProbe(readOnly, "read").missing).toEqual([]);
    expect(assessProbe(readOnly, "read_write").missing).toEqual(["write"]);
  });

  it("warns about excess permissions, more than the level, and what the host could not say", () => {
    const a = assessProbe(probe({ excess: ["administration:write"] }), "read");
    expect(a.missing).toEqual([]);
    expect(a.warnings).toEqual([
      { code: "excess_permissions", permissions: ["administration:write"] },
      { code: "more_than_level", capabilities: ["write", "create"] },
    ]);
    const fineGrained = probe({
      capabilities: { create: "unknown", read: "yes", write: "unknown", admin: "unknown" },
    });
    expect(assessProbe(fineGrained, "read_write")).toEqual({
      missing: [],
      warnings: [{ code: "unverified", capabilities: ["write", "create"] }],
    });
  });

  it("reports what the credential may do, without anything secret", () => {
    const report = testReport(probe(), assessProbe(probe(), "read"));
    expect(report).toMatchObject({ ok: true, provider: "github", actor: { login: "bot" } });
    expect(Object.keys(report)).not.toContain("credential");
  });
});

describe("testFailure", () => {
  it("maps adapter codes to answers with fixed messages", () => {
    const cases: [GitHostError, number, string][] = [
      [
        new GitHostError("auth_failed", "rejected", { reason: "credential_rejected" }),
        422,
        "credential_rejected",
      ],
      [
        new GitHostError("forbidden", "lacks", { missingPermission: "contents=write" }),
        422,
        "credential_forbidden",
      ],
      [new GitHostError("not_found", "nf"), 422, "organization_not_found"],
      [
        new GitHostError("unsupported_host", "old", { reason: "version_too_old" }),
        422,
        "unsupported_host",
      ],
      [new GitHostError("host_unreachable", "down"), 502, "host_unreachable"],
      [
        new GitHostError("rate_limited", "slow", { resetAt: new Date(0) }),
        503,
        "host_rate_limited",
      ],
      [new GitHostError("host_refused", "off", { reason: "site_git_off" }), 403, "git_disabled"],
      [
        new GitHostError("host_refused", "no", { reason: "site_host_limit" }),
        403,
        "host_not_allowed",
      ],
      [
        new GitHostError("host_refused", "private", { reason: "private_address" }),
        422,
        "host_refused",
      ],
      [new GitHostError("unexpected", "?"), 502, "host_error"],
    ];
    for (const [error, status, code] of cases) {
      const f = testFailure(error);
      expect([f.status, f.body.code], error.code).toEqual([status, code]);
      expect(f.body.test.code).toBe(error.code);
    }
    expect(testFailure(cases[1]?.[0]).body.test.missing_permission).toBe("contents=write");
    expect(testFailure(cases[5]?.[0]).body.test.retry_at).toBe(new Date(0).toISOString());
  });

  it("drops a reason that is not a code, and rethrows anything but a host error", () => {
    const odd = new GitHostError("auth_failed", "x", { reason: "has spaces: token=abc" });
    expect(testFailure(odd).body.test).toEqual({ code: "auth_failed" });
    expect(healthErrorCode(odd)).toBe("auth_failed");
    expect(
      healthErrorCode(new GitHostError("auth_failed", "x", { reason: "installation_removed" })),
    ).toBe("auth_failed:installation_removed");
    expect(() => testFailure(new Error("boom"))).toThrow("boom");
  });
});

describe("request schemas", () => {
  const token = { kind: "access_token", token: "t0ken-value-123456" };
  it("refuses a GitHub App on Gitea or Forgejo, and Gitea without a base URL", () => {
    const app = { kind: "github_app", app_id: 1, installation_id: 2, private_key: "x" };
    expect(
      gitConnectionTestBodySchema.safeParse({
        provider: "gitea",
        base_url: "https://git.example.com",
        organization: "acme",
        credential: app,
      }).success,
    ).toBe(false);
    expect(
      gitConnectionTestBodySchema.safeParse({
        provider: "forgejo",
        organization: "acme",
        credential: token,
      }).success,
    ).toBe(false);
    expect(
      gitConnectionTestBodySchema.safeParse({
        provider: "github",
        organization: "acme",
        credential: token,
      }).success,
    ).toBe(true);
  });

  it("refuses unknown fields, bad branches and an empty update", () => {
    const base = { provider: "github", organization: "acme", credential: token };
    expect(gitConnectionCreateBodySchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(
      gitConnectionCreateBodySchema.safeParse({ ...base, default_branch: "a..b" }).success,
    ).toBe(false);
    expect(
      gitConnectionCreateBodySchema.safeParse({ ...base, repo_visibility: "public" }).success,
    ).toBe(false);
    expect(gitConnectionUpdateBodySchema.safeParse({}).success).toBe(false);
    expect(gitConnectionUpdateBodySchema.safeParse({ access_level: "off" }).success).toBe(true);
  });

  it("keeps the protocol's value lists equal to @kobe/db's", () => {
    expect([...GIT_CONNECTION_PROVIDERS]).toEqual([...GIT_PROVIDER_VALUES]);
    expect([...GIT_CONNECTION_CREDENTIAL_KINDS]).toEqual([...GIT_CREDENTIAL_KIND_VALUES]);
    expect([...GIT_CONNECTION_ACCESS_LEVELS]).toEqual([...GIT_ACCESS_LEVEL_VALUES]);
    expect([...GIT_CONNECTION_REPO_VISIBILITIES]).toEqual([...GIT_REPO_VISIBILITY_VALUES]);
    expect([...GIT_CONNECTION_CAPABILITY_VALUES]).toEqual([...GIT_CAPABILITY_VALUES]);
  });
});

describe("expiry email (G6)", () => {
  it("names the connection, host and date; says when it already lapsed", () => {
    const now = Date.parse("2026-11-22T00:00:00Z");
    const connection = {
      displayName: "Acme on GitHub",
      organization: "acme",
      baseUrl: "https://github.com",
      credentialExpiresAt: new Date("2026-12-01T00:00:00Z"),
    };
    const m = gitExpiryMessage({
      to: "a@example.com",
      appName: "Kaiju",
      teamName: "Team1",
      connection,
      consoleUrl: "http://kobe.test/admin/team/git",
      now,
    });
    expect(m.subject).toContain("expires on 2026-12-01");
    expect(m.text).toContain("acme on github.com");
    expect(m.text).toContain("http://kobe.test/admin/team/git");
    const lapsed = gitExpiryMessage({
      to: "a@example.com",
      appName: "Kaiju",
      teamName: "Team1",
      connection: { ...connection, credentialExpiresAt: new Date(now - 1) },
      consoleUrl: "x",
      now,
    });
    expect(lapsed.subject).toContain("needs a new token");
  });
});

describe("GitHostBackoff", () => {
  it("doubles per failure, honours the host's reset, clears on success", () => {
    const b = new GitHostBackoff();
    const t = 1_000_000;
    expect(b.blocked("h", t)).toBe(false);
    b.fail("h", t);
    expect(b.blocked("h", t + 14 * 60_000)).toBe(true);
    expect(b.blocked("h", t + 16 * 60_000)).toBe(false);
    b.fail("h", t);
    expect(b.blocked("h", t + 29 * 60_000)).toBe(true);
    b.fail("x", t, new Date(t + 2 * 3600_000));
    expect(b.blocked("x", t + 3600_000)).toBe(true);
    b.ok("h");
    expect(b.blocked("h", t + 1)).toBe(false);
  });
});
