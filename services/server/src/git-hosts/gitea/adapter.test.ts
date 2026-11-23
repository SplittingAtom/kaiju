import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { serializeError } from "../../log-safety.js";
import { FAKE_GITEA_TOKEN, FAKE_VERSIONS, FakeGitea } from "../../testing/fake-gitea.js";
import {
  contractNet,
  contractTarget,
  describeProviderContract,
} from "../../testing/git-host-contract.js";
import { GitHostError, type GitHostAdapter } from "../adapter.js";
import type { GitHostNet } from "../http.js";
import { createGiteaAdapter } from "./adapter.js";
import { giteaError } from "./errors.js";
import { judgeVersion } from "./version.js";

function factory(fake: FakeGitea, provider: "gitea" | "forgejo" = fake.product) {
  return (net: GitHostNet = contractNet(fake), baseUrl = fake.baseUrl): GitHostAdapter =>
    createGiteaAdapter({
      provider,
      target: contractTarget(baseUrl),
      organization: fake.organization,
      token: fake.token,
      net,
    });
}

for (const product of ["gitea", "forgejo"] as const) {
  const fake = new FakeGitea(product);
  describeProviderContract(product === "gitea" ? "Gitea" : "Forgejo", {
    provider: product,
    fake,
    start: () => fake.start(),
    close: () => fake.close(),
    makeAdapter: (net, target) =>
      createGiteaAdapter({
        provider: product,
        target,
        organization: fake.organization,
        token: fake.token,
        net,
      }),
    secrets: () => [FAKE_GITEA_TOKEN],
  });
}

async function caught(p: Promise<unknown>): Promise<GitHostError> {
  try {
    await p;
  } catch (error) {
    if (error instanceof GitHostError) return error;
    throw error;
  }
  throw new Error("expected a GitHostError");
}

describe("judgeVersion", () => {
  it.each([
    ["1.27.2", "gitea", true],
    ["1.26.0", "gitea", true],
    ["v1.26.4", "gitea", true],
    ["1.27.0+dev-120-gabcdef", "gitea", true],
    ["1.25.9", "gitea", false],
    ["1.20.0", "gitea", false],
    ["17.0.1+gitea-1.22.0", "forgejo", true],
    ["16.0.5+gitea-1.22.0", "forgejo", true],
    ["15.0.0+gitea-1.22.0", "forgejo", true],
    ["14.0.2+gitea-1.22.0", "forgejo", false],
    ["7.0.0+gitea-1.22.0", "forgejo", false],
  ] as const)("%s is %s, supported %s", (raw, product, ok) => {
    expect(judgeVersion(raw)).toMatchObject({ product, supported: ok });
  });

  it("states the minimum per product", () => {
    expect(judgeVersion("1.0.0")?.minimumVersion).toBe("1.26.0");
    expect(judgeVersion("1.0.0+gitea-1.22.0")?.minimumVersion).toBe("15.0.0");
  });

  it("rejects what is not a version and cleans what it shows", () => {
    expect(judgeVersion("development")).toBeUndefined();
    expect(judgeVersion("1.27.0<script>")?.version).toBe("1.27.0script");
  });
});

describe("giteaError", () => {
  const res = (status: number, json: unknown, headers = {}) => ({ status, json, headers });

  it("parses both scope message formats and never copies the host's message", () => {
    const older = giteaError(
      res(403, { message: "token does not have at least one of required scope(s): [write:issue]" }),
      0,
    );
    expect(older.missingPermission).toBe("write:issue");
    const newer = giteaError(
      res(403, {
        message:
          "token does not have at least one of required scope(s), required=[write:repository], token scope=read:repository",
      }),
      0,
    );
    expect(newer.missingPermission).toBe("write:repository");
    expect(newer.message).not.toContain("token scope=");
    expect(giteaError(res(403, { message: "not a collaborator" }), 0).missingPermission).toBe(
      undefined,
    );
  });

  it.each([
    [401, "auth_failed"],
    [404, "not_found"],
    [409, "conflict"],
    [422, "invalid_request"],
    [429, "rate_limited"],
    [502, "host_unreachable"],
    [418, "unexpected"],
  ] as const)("maps %i to %s", (status, code) => {
    expect(giteaError(res(status, undefined), 0).code).toBe(code);
  });

  it("reads Retry-After as an HTTP date", () => {
    const now = Date.UTC(2026, 10, 22, 12, 0, 0);
    const at = new Date(now + 61_000).toUTCString();
    const error = giteaError(res(429, undefined, { "retry-after": at }), now);
    expect(error.resetAt?.getTime()).toBe(now + 61_000);
  });
});

for (const product of ["gitea", "forgejo"] as const) {
  describe(`${product} specifics (KOBE-759)`, () => {
    const fake = new FakeGitea(product);
    const make = factory(fake);
    beforeAll(() => fake.start());
    afterAll(() => fake.close());
    beforeEach(() => {
      fake.reset();
      fake.seedRepositories(["docs"]);
    });

    it("probes the product, the version and abilities", async () => {
      const probe = await make().probe();
      expect(probe).toMatchObject({
        provider: product,
        hostVersion: FAKE_VERSIONS[product].current,
        actor: { kind: "token", login: fake.login },
        capabilities: { create: "yes", read: "yes", write: "yes", admin: "no" },
        excess: [],
        credentialExpiresAt: null,
      });
    });

    it("refuses a version older than supported, naming the minimum, before any other call", async () => {
      fake.makeTooOld();
      const adapter = make();
      const error = await caught(adapter.probe());
      expect(error).toMatchObject({ code: "unsupported_host", reason: "version_too_old" });
      const min = product === "gitea" ? "Gitea 1.26.0" : "Forgejo 15.0.0";
      expect(error.message).toContain(`Kobe supports ${min} and later`);
      expect((await caught(adapter.getRepository({ name: "docs" }))).code).toBe("unsupported_host");
      expect(fake.apiHits().every((h) => h.path === "/api/v1/version")).toBe(true);
    });

    it("sends the token only as `token …`", async () => {
      await make().describeOrganization();
      expect(fake.apiHits().every((h) => h.authorization === `token ${fake.token}`)).toBe(true);
    });

    it("reads the version once per adapter", async () => {
      const adapter = make();
      await adapter.describeOrganization();
      await adapter.getRepository({ name: "docs" });
      expect(fake.apiHits().filter((h) => h.path === "/api/v1/version")).toHaveLength(1);
    });

    it("names the missing token scope", async () => {
      fake.scopes.delete("write:issue");
      const error = await caught(make().createIssue({ repository: "docs", title: "t", body: "b" }));
      expect(error).toMatchObject({ code: "forbidden", missingPermission: "write:issue" });
      expect(error.message).toContain("write:issue");
      fake.scopes.delete("write:organization");
      const create = await caught(make().createRepository({ name: "x", visibility: "private" }));
      expect(create.missingPermission).toBe("write:organization");
    });

    it("names extra permissions of an owner and site administrator", async () => {
      fake.isOrgOwner = true;
      fake.siteAdmin = true;
      const probe = await make().probe();
      expect(probe.capabilities.admin).toBe("yes");
      expect(probe.excess).toEqual([
        "organization owner (can delete repositories)",
        "organization administration",
        "site administration",
      ]);
    });

    it("hands out the token, not narrowed, only for access the host grants", async () => {
      const cred = await make().repositoryCredential("docs", "write");
      expect(cred).toMatchObject({
        username: fake.login,
        password: fake.token,
        narrowed: false,
        expiresAt: null,
        access: "write",
      });
      fake.canWrite = false;
      expect((await caught(make().repositoryCredential("docs", "write"))).code).toBe("forbidden");
      expect((await make().repositoryCredential("docs", "read")).access).toBe("read");
      expect((await caught(make().repositoryCredential("nope", "read"))).code).toBe("not_found");
    });

    it("refuses internal visibility (the host has none), sending nothing", async () => {
      const error = await caught(make().createRepository({ name: "x", visibility: "internal" }));
      expect(error.code).toBe("invalid_request");
      expect(fake.apiHits()).toEqual([]);
    });

    it("reports a new empty repository with no default branch yet", async () => {
      const repo = await make().createRepository({ name: "fresh", visibility: "private" });
      expect(repo).toMatchObject({ empty: true, defaultBranch: null, visibility: "private" });
    });

    it("pages by X-Total-Count when the host sends no Link header", async () => {
      fake.omitLink = true;
      fake.seedRepositories(["a", "b"]);
      const first = await make().listRepositories({ perPage: 2 });
      expect(first.next).toBe("2");
      expect((await make().listRepositories({ perPage: 2, cursor: "2" })).next).toBeNull();
    });

    it("caps the answer size and refuses an answer that is not the API", async () => {
      const adapter = make();
      await adapter.getRepository({ name: "docs" });
      fake.answerNext("oversized");
      expect((await caught(adapter.describeOrganization())).code).toBe("unexpected");
      fake.answerNext("garbage");
      const error = await caught(adapter.describeOrganization());
      expect(error.code).toBe("unexpected");
      expect(JSON.stringify(serializeError(error))).not.toContain(fake.token);
    });

    it("marks a draft pull request with Gitea's WIP prefix", async () => {
      const pr = await make().openPullRequest({
        repository: "docs",
        title: "Change",
        body: "b",
        head: "feature",
        base: "main",
        draft: true,
      });
      expect(pr.number).toBeGreaterThan(0);
    });

    it("works under a sub-path install", async () => {
      const error = await caught(make(contractNet(fake), `${fake.baseUrl}/gitea/`).probe());
      expect(error.code).toBe("not_found");
      expect(fake.apiHits().at(-1)?.path).toBe("/gitea/api/v1/version");
    });

    it("refuses a base URL with credentials or a query", () => {
      expect(() => make(contractNet(fake), "https://user:pw@git.example.test")).toThrow(
        GitHostError,
      );
      expect(() => make(contractNet(fake), "https://git.example.test/?x=1")).toThrow(GitHostError);
      expect(() => make(contractNet(fake), "not a url")).toThrow(GitHostError);
    });

    it("times out a host that does not answer", async () => {
      fake.delayMs = 500;
      const error = await caught(make({ ...contractNet(fake), timeoutMs: 100 }).probe());
      expect(error.code).toBe("host_unreachable");
    });
  });
}
