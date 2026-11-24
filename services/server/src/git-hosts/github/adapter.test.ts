import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FAKE_APP_ID, FAKE_INST_ID, FAKE_PAT, FakeGithub } from "../../testing/fake-github.js";
import {
  contractNet,
  contractTarget,
  describeProviderContract,
} from "../../testing/git-host-contract.js";
import { gitHostTarget } from "../target.js";
import { GitHostError } from "../adapter.js";
import type { GitHostNet } from "../http.js";
import { createGitHubAdapter, type GitHubCredential } from "./adapter.js";
import { InstallationTokenCache, TOKEN_EXPIRY_MARGIN_MS } from "./app-auth.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const PUBLIC_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const OTHER_PEM = other.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const APP: GitHubCredential = {
  kind: "github_app",
  appId: FAKE_APP_ID,
  installationId: FAKE_INST_ID,
  privateKeyPem: PRIVATE_PEM,
};
const PAT: GitHubCredential = { kind: "access_token", token: FAKE_PAT };

function contractFor(name: string, credential: GitHubCredential) {
  const fake = new FakeGithub(PUBLIC_PEM);
  let cache = new InstallationTokenCache();
  describeProviderContract(name, {
    provider: "github",
    fake,
    start: () => fake.start(),
    close: () => fake.close(),
    prepare: () => {
      cache = new InstallationTokenCache();
    },
    makeAdapter: (net, target) =>
      createGitHubAdapter({
        target,
        organization: fake.organization,
        credential,
        net,
        tokenCache: cache,
      }),
    secrets: () => [FAKE_PAT, PRIVATE_PEM.slice(40, 120), ...fake.tokens.map((t) => t.token)],
  });
}

contractFor("GitHub Enterprise Server, fine-grained token", PAT);
contractFor("GitHub Enterprise Server, GitHub App", APP);

async function caught(p: Promise<unknown>): Promise<GitHostError> {
  try {
    await p;
  } catch (error) {
    if (error instanceof GitHostError) return error;
    throw error;
  }
  throw new Error("expected a GitHostError");
}

describe("GitHub adapter specifics (KOBE-758)", () => {
  const fake = new FakeGithub(PUBLIC_PEM);
  let cache: InstallationTokenCache;
  let clock: number;
  beforeAll(() => fake.start());
  afterAll(() => fake.close());
  beforeEach(() => {
    fake.reset();
    fake.seedRepositories(["docs", "site"]);
    cache = new InstallationTokenCache();
    clock = Date.now();
  });
  const make = (credential: GitHubCredential = APP, net: GitHostNet = contractNet(fake)) =>
    createGitHubAdapter({
      target: contractTarget(fake.baseUrl),
      organization: fake.organization,
      credential,
      net,
      tokenCache: cache,
      now: () => clock,
    });

  describe("installation tokens (ac-1)", () => {
    it("mints a token narrowed to one repository and read or write", async () => {
      const a = make();
      const read = await a.repositoryCredential("docs", "read");
      const write = await a.repositoryCredential("docs", "write");
      expect(read.username).toBe("x-access-token");
      expect(read.password).not.toBe(write.password);
      expect(read.expiresAt?.getTime()).toBeGreaterThan(clock);
      expect(fake.mintRequests).toEqual([
        { repositories: ["docs"], permissions: { contents: "read", metadata: "read" } },
        { repositories: ["docs"], permissions: { contents: "write", metadata: "read" } },
      ]);
    });

    it("narrows tool calls to the repository and the permission they need", async () => {
      await make().openPullRequest({
        repository: "site",
        title: "t",
        body: "b",
        head: "feature",
        base: "main",
      });
      expect(fake.mintRequests.at(-1)).toEqual({
        repositories: ["site"],
        permissions: { pull_requests: "write", contents: "read", metadata: "read" },
      });
      const used = fake.tokens.at(-1);
      expect(used?.repositories).toEqual(["site"]);
    });

    it("reuses a cached token until the expiry margin, then mints again", async () => {
      const a = make();
      const first = await a.repositoryCredential("docs", "read");
      const again = await a.repositoryCredential("docs", "read");
      expect(again.password).toBe(first.password);
      expect(fake.mintRequests).toHaveLength(1);
      clock = (first.expiresAt?.getTime() ?? 0) - TOKEN_EXPIRY_MARGIN_MS + 1;
      const fresh = await a.repositoryCredential("docs", "read");
      expect(fresh.password).not.toBe(first.password);
      expect(fake.mintRequests).toHaveLength(2);
    });

    it("mints once for concurrent callers", async () => {
      const a = make();
      const both = await Promise.all([
        a.repositoryCredential("docs", "read"),
        a.repositoryCredential("docs", "read"),
      ]);
      expect(both[0].password).toBe(both[1].password);
      expect(fake.mintRequests).toHaveLength(1);
    });

    it("never shares cached tokens across credentials naming the same installation", async () => {
      await make().repositoryCredential("docs", "read");
      const intruder = make({ ...(APP as object), privateKeyPem: OTHER_PEM } as GitHubCredential);
      const error = await caught(intruder.repositoryCredential("docs", "read"));
      expect(error).toMatchObject({ code: "auth_failed" });
      expect(cache.size).toBe(1);
    });

    it("re-mints once when the host rejects a cached token (expired token, ac-3)", async () => {
      const a = make();
      await a.getRepository({ name: "docs" });
      fake.revokeTokens();
      expect(await a.getRepository({ name: "docs" })).toMatchObject({ name: "docs" });
      expect(fake.mintRequests).toHaveLength(2);
    });

    it("reports a removed installation (revoked, ac-3)", async () => {
      fake.options = { installationRemoved: true };
      const error = await caught(make().getRepository({ name: "docs" }));
      expect(error).toMatchObject({ code: "auth_failed", reason: "installation_removed" });
    });

    it("reports a suspended installation", async () => {
      fake.options = { installationSuspended: true };
      const error = await caught(make().probe());
      expect(error).toMatchObject({ code: "auth_failed", reason: "installation_suspended" });
    });

    it("refuses an installation on another account", async () => {
      fake.options = { installationAccount: "someone-else" };
      const error = await caught(make().repositoryCredential("docs", "write"));
      expect(error).toMatchObject({ code: "auth_failed", reason: "installation_account_mismatch" });
      expect(fake.mintRequests).toEqual([]);
    });

    it("names the permission an installation was not granted", async () => {
      fake.options = { installationPermissions: { metadata: "read", contents: "read" } };
      const error = await caught(make().repositoryCredential("docs", "write"));
      expect(error.code).toBe("forbidden");
      expect(error.missingPermission).toContain("contents=write");
    });

    it("refuses a key that does not parse, without quoting it", async () => {
      const pem =
        "-----BEGIN RSA PRIVATE KEY-----\nnot-a-key-secret-material\n-----END RSA PRIVATE KEY-----";
      const error = await caught(
        make({ ...(APP as object), privateKeyPem: pem } as GitHubCredential).probe(),
      );
      expect(error).toMatchObject({ code: "auth_failed", reason: "invalid_private_key" });
      expect(JSON.stringify({ m: error.message, s: error.stack })).not.toContain("secret-material");
    });

    it("refuses non-numeric App and installation ids before sending", async () => {
      const error = await caught(
        make({ ...(APP as object), installationId: "../1" } as GitHubCredential).probe(),
      );
      expect(error.code).toBe("invalid_request");
      expect(fake.hits).toEqual([]);
    });
  });

  describe("capability probe (ac-2)", () => {
    it("lists create/read/write/admin and flags excess App permissions", async () => {
      fake.options = {
        enterpriseVersion: "3.19.2",
        installationPermissions: {
          metadata: "read",
          contents: "write",
          pull_requests: "write",
          issues: "write",
          administration: "write",
          organization_administration: "write",
          members: "write",
          secrets: "read",
        },
      };
      const probe = await make().probe();
      expect(probe).toMatchObject({
        provider: "github",
        hostVersion: "3.19.2",
        actor: { kind: "app", login: "kaiju-test-app[bot]" },
        capabilities: { create: "yes", read: "yes", write: "yes", admin: "yes" },
        excess: ["members:write", "organization_administration:write", "secrets:read"],
        credentialExpiresAt: null,
      });
      expect(probe.rateLimit).toMatchObject({ limit: 5000, remaining: 4999 });
    });

    it("shows a read-only App as read only", async () => {
      fake.options = { installationPermissions: { metadata: "read", contents: "read" } };
      expect((await make().probe()).capabilities).toEqual({
        create: "no",
        read: "yes",
        write: "no",
        admin: "no",
      });
    });

    it("reads a fine-grained token's owner and expiry", async () => {
      fake.options = { patExpiration: "2026-12-31 08:00:00 +0100" };
      const probe = await make(PAT).probe();
      expect(probe).toMatchObject({
        actor: { kind: "token", login: "kobe-bot-test" },
        capabilities: { read: "yes", create: "unknown", write: "unknown", admin: "unknown" },
        excess: [],
      });
      expect(probe.credentialExpiresAt?.toISOString()).toBe("2026-12-31T07:00:00.000Z");
    });

    it("flags a classic token and its extra scopes", async () => {
      fake.options = { classicScopes: "repo, delete_repo, admin:org" };
      const probe = await make(PAT).probe();
      expect(probe.excess).toEqual(["classic_token", "scope:admin:org", "scope:delete_repo"]);
      expect(probe.capabilities).toMatchObject({ write: "yes", admin: "yes" });
    });

    it("reports an expired or revoked token as auth failed", async () => {
      fake.options = { patRejected: true };
      const error = await caught(make(PAT).probe());
      expect(error).toMatchObject({ code: "auth_failed", status: 401 });
    });
  });

  describe("errors and transport", () => {
    it("names the missing permission from x-accepted-github-permissions", async () => {
      fake.fail("forbidden");
      const error = await caught(make(PAT).getRepository({ name: "docs" }));
      expect(error).toMatchObject({ code: "forbidden", missingPermission: "contents=write" });
    });

    it("takes the primary rate limit's reset time from the header", async () => {
      fake.fail("rate_limited");
      clock = 1900000123 * 1000 - 3_600_000; // an hour before the reset the fake reports
      const error = await caught(make(PAT).getRepository({ name: "docs" }));
      expect(error).toMatchObject({ code: "rate_limited", reason: "primary" });
      expect(error.resetAt?.getTime()).toBe(1900000123 * 1000);
      // A reset further away than a day is capped (review L3).
      clock = Date.now();
      const capped = await caught(make(PAT).getRepository({ name: "docs" }));
      expect(capped.resetAt?.getTime()).toBe(clock + 86_400_000);
    });

    it("takes a secondary rate limit's wait from retry-after", async () => {
      fake.fail("secondary_rate_limited");
      const error = await caught(make(PAT).getRepository({ name: "docs" }));
      expect(error).toMatchObject({ code: "rate_limited", reason: "secondary" });
      expect(error.resetAt?.getTime()).toBe(clock + 30_000);
    });

    it("follows a same-origin redirect to a renamed repository", async () => {
      fake.options = { renamed: { "old-docs": "docs" } };
      expect(await make(PAT).getRepository({ name: "old-docs" })).toMatchObject({ name: "docs" });
    });

    it("sends Enterprise Server requests under /api/v3", async () => {
      await make(PAT).describeOrganization();
      expect(fake.hits.map((h) => h.path)).toEqual([`/api/v3/orgs/${fake.organization}`]);
    });

    it("sends github.com requests to api.github.com through the address policy", async () => {
      const seen: string[] = [];
      const net: GitHostNet = {
        policy: {
          allowHttp: false,
          allowedPorts: [443],
          allowedInternalCidrs: [],
          deniedCidrs: [],
          resolve: () => Promise.resolve(["140.82.112.6"]),
        },
        request: (url) => {
          seen.push(url.toString());
          return Promise.resolve({
            status: 200,
            headers: {},
            text: JSON.stringify({ id: 1, login: "acme-test", html_url: "x" }),
          });
        },
      };
      const a = createGitHubAdapter({
        target: gitHostTarget(
          { enabled: true, allowedHosts: ["github.com"] },
          "https://github.com/",
        ),
        organization: "acme-test",
        credential: PAT,
        net,
      });
      const org = await a.describeOrganization();
      expect(seen).toEqual(["https://api.github.com/orgs/acme-test"]);
      // A non-URL html_url is dropped, not passed on (review M2).
      expect(org.webUrl).toBe("");
    });

    it("keeps github.com web links and drops API-origin or foreign ones", async () => {
      const answers: Record<string, string> = {
        "/orgs/acme-test": JSON.stringify({
          id: 1,
          login: "acme-test",
          html_url: "https://github.com/acme-test",
        }),
        "/orgs/other": JSON.stringify({
          id: 2,
          login: "other",
          html_url: "https://api.github.com/orgs/other",
        }),
      };
      const net: GitHostNet = {
        policy: {
          allowHttp: false,
          allowedPorts: [443],
          allowedInternalCidrs: [],
          deniedCidrs: [],
          resolve: () => Promise.resolve(["140.82.112.6"]),
        },
        request: (url) =>
          Promise.resolve({ status: 200, headers: {}, text: answers[url.pathname] ?? "{}" }),
      };
      const target = gitHostTarget({ enabled: true, allowedHosts: [] }, "https://github.com");
      const mk = (organization: string) =>
        createGitHubAdapter({ target, organization, credential: PAT, net });
      expect((await mk("acme-test").describeOrganization()).webUrl).toBe(
        "https://github.com/acme-test",
      );
      expect((await mk("other").describeOrganization()).webUrl).toBe("");
    });

    it.each([
      ["javascript:alert(1)", ""],
      ["https://evil.example/acme-test/docs", ""],
    ])("drops a hostile html_url %s and never uses the host's clone_url", async (html, want) => {
      fake.options = {
        hostileHtmlUrl: html,
        hostileCloneUrl: "https://evil.example/x.git",
      };
      const repo = await make(PAT).getRepository({ name: "docs" });
      expect(repo.webUrl).toBe(want);
      expect(repo.cloneUrl).toBe(`${fake.baseUrl}/${fake.organization}/docs.git`);
    });

    it("refuses a token of another account on a user namespace (review M3)", async () => {
      fake.options = { userNamespace: true, patLogin: "bob" };
      const probe = await caught(make(PAT).probe());
      expect(probe).toMatchObject({ code: "forbidden", reason: "token_owner_mismatch" });
      const create = await caught(make(PAT).createRepository({ name: "x", visibility: "private" }));
      expect(create).toMatchObject({ code: "forbidden", reason: "token_owner_mismatch" });
      expect(fake.createdRepositories).toEqual([]);
      expect(fake.hits.some((h) => h.method === "POST")).toBe(false);
    });

    it("creates in a user namespace only with that user's own token", async () => {
      fake.options = { userNamespace: true, patLogin: fake.organization };
      const probe = await make(PAT).probe();
      expect(probe.organization.kind).toBe("user");
      const repo = await make(PAT).createRepository({ name: "mine", visibility: "private" });
      expect(repo.fullName).toBe(`${fake.organization}/mine`);
      const app = await caught(make(APP).createRepository({ name: "x", visibility: "private" }));
      expect(app.code).toBe("forbidden");
    });

    it("checks the repository and the token's access before handing out a token (L1)", async () => {
      fake.options = { repoPermissions: { pull: true, push: false } };
      expect((await make(PAT).repositoryCredential("docs", "read")).narrowed).toBe(false);
      const write = await caught(make(PAT).repositoryCredential("docs", "write"));
      expect(write.code).toBe("forbidden");
      expect((await caught(make(PAT).repositoryCredential("nope", "read"))).code).toBe("not_found");
    });

    it("lists repositories created through an App installation", async () => {
      const page = await make().listRepositories();
      expect(page.items.map((r) => r.name)).toEqual(["docs", "site"]);
      expect(fake.hits.some((h) => h.path === "/api/v3/installation/repositories")).toBe(true);
    });

    it("creates a repository with private visibility and the admin permission scope", async () => {
      await make().createRepository({ name: "made", visibility: "private" });
      expect(fake.createdRepositories).toEqual([
        { name: "made", private: true, visibility: "private" },
      ]);
      expect(fake.mintRequests.at(-1)).toEqual({
        permissions: { administration: "write", metadata: "read" },
      });
    });
  });
});
