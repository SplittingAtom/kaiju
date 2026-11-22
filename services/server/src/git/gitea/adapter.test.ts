import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeGitea } from "../../testing/fake-gitea.js";
import { runGitHostContract, testNet } from "../../testing/git-provider-contract.js";
import { GitHostError } from "../provider-errors.js";
import { GitSecret } from "../provider.js";
import { GiteaAdapter, errorFor } from "./adapter.js";
import { judgeVersion } from "./version.js";

function adapterFor(fake: FakeGitea, provider: "gitea" | "forgejo" = fake.product) {
  return (net = testNet(fake), baseUrl = fake.baseUrl) =>
    new GiteaAdapter({
      provider,
      baseUrl,
      organization: fake.organization,
      token: new GitSecret(fake.secret),
      net,
    });
}

for (const product of ["gitea", "forgejo"] as const) {
  const fake = new FakeGitea(product);
  runGitHostContract({
    name: product,
    product,
    fake,
    adapter: (net) => adapterFor(fake)(net),
  });
}

describe("judgeVersion", () => {
  it.each([
    ["1.27.2", "gitea", true, false],
    ["1.26.0", "gitea", true, false],
    ["v1.26.4", "gitea", true, false],
    ["1.27.0+dev-120-gabcdef", "gitea", true, false],
    ["1.25.9", "gitea", false, false],
    ["1.28.0", "gitea", true, true],
    ["17.0.1+gitea-1.22.0", "forgejo", true, false],
    ["16.0.0+gitea-1.22.0", "forgejo", true, false],
    ["15.0.3+gitea-1.22.0", "forgejo", false, false],
    ["18.1.0+gitea-1.22.0", "forgejo", true, true],
  ] as const)("%s is %s, supported %s, newer than tested %s", (raw, product, ok, newer) => {
    expect(judgeVersion(raw)).toMatchObject({ product, supported: ok, newerThanTested: newer });
  });

  it("states the minimum per product", () => {
    expect(judgeVersion("1.0.0")?.minimumVersion).toBe("1.26.0");
    expect(judgeVersion("1.0.0+gitea-1.22.0")?.minimumVersion).toBe("16.0.0");
  });

  it("rejects what is not a version and cleans what it shows", () => {
    expect(judgeVersion("development")).toBeUndefined();
    expect(judgeVersion("1.27.0<script>")?.version).toBe("1.27.0script");
  });
});

describe("errorFor", () => {
  const res = (status: number, json: unknown, headers = {}) => ({ status, json, headers });

  it("parses both Gitea scope message formats and never copies the message", () => {
    const old = errorFor(
      res(403, { message: "token does not have at least one of required scope(s): [write:issue]" }),
    );
    expect(old.details.missingScope).toBe("write:issue");
    const newer = errorFor(
      res(403, {
        message:
          "token does not have at least one of required scope(s), required=[write:repository], token scope=read:repository",
      }),
    );
    expect(newer.details.missingScope).toBe("write:repository");
    expect(newer.message).not.toContain("token scope=");
    expect(errorFor(res(403, { message: "you are not a collaborator" })).details).toEqual({
      status: 403,
    });
  });

  it.each([
    [401, "auth_failed"],
    [404, "not_found"],
    [409, "conflict"],
    [422, "invalid_request"],
    [429, "rate_limited"],
    [502, "host_unreachable"],
    [500, "unexpected"],
    [418, "unexpected"],
  ] as const)("maps %i to %s", (status, code) => {
    expect(errorFor(res(status, undefined)).code).toBe(code);
  });

  it("reads Retry-After as an HTTP date", () => {
    const at = new Date(Date.now() + 61_000).toUTCString();
    const error = errorFor(res(429, undefined, { "retry-after": at }));
    expect(error.details.retryAfterSeconds).toBeGreaterThanOrEqual(59);
    expect(error.details.retryAfterSeconds).toBeLessThanOrEqual(61);
  });
});

describe("Gitea/Forgejo specifics", () => {
  const fake = new FakeGitea("forgejo");
  const make = adapterFor(fake);
  beforeAll(() => fake.start());
  afterAll(() => fake.close());
  beforeEach(() => fake.reset());

  it("sends the token as `token …` and never anywhere else", async () => {
    await make().getOrganization();
    const auth = fake.requests().map((r) => r.authorization);
    expect(auth.every((a) => a === `token ${fake.secret}`)).toBe(true);
  });

  it("notes a provider that differs from the product detected", async () => {
    const test = await adapterFor(fake, "gitea")().testConnection();
    expect(test.host.product).toBe("forgejo");
    expect(test.notes.join(" ")).toContain("forgejo");
  });

  it("names extra permissions of an owner and site administrator", async () => {
    fake.isOrgOwner = true;
    fake.siteAdmin = true;
    const test = await make().testConnection();
    expect(test.abilities.administer).toBe(true);
    expect(test.extraPermissions).toEqual([
      "organization owner (can delete repositories)",
      "organization administration",
      "site administration",
    ]);
    expect(test.credentialExpiresAt).toBeNull();
  });

  it("reads the version once per adapter", async () => {
    const adapter = make();
    await adapter.getOrganization();
    await adapter.getRepository("docs");
    expect(fake.requests().filter((r) => r.path === "/api/v1/version")).toHaveLength(1);
  });

  it("pages by X-Total-Count when the host sends no Link header", async () => {
    fake.omitLink = true;
    fake.seedRepositories(3);
    const first = await make().listRepositories({ pageSize: 2 });
    expect(first.nextCursor).toBe("2");
    const last = await make().listRepositories({ pageSize: 2, cursor: "2" });
    expect(last.nextCursor).toBeNull();
  });

  it.each(["0", "x", "-1", "1.5"])("refuses the cursor %j", async (cursor) => {
    await expect(make().listRepositories({ cursor })).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("never reports a repository of another owner", async () => {
    fake.foreignRepo = true;
    await expect(make().listRepositories()).rejects.toMatchObject({ code: "not_found" });
  });

  it("works under a sub-path install", async () => {
    // The fake serves /api/v1 at the root, so a sub-path base must not reach it.
    await expect(make(testNet(fake), `${fake.baseUrl}/gitea/`).probe()).rejects.toMatchObject({
      code: "not_found",
    });
    expect(fake.requests().at(-1)?.path).toBe("/gitea/api/v1/version");
  });

  it("refuses a base URL with credentials or a query", () => {
    expect(() => make(testNet(fake), "https://user:pw@git.example.com")).toThrow(GitHostError);
    expect(() => make(testNet(fake), "https://git.example.com/?x=1")).toThrow(GitHostError);
    expect(() => make(testNet(fake), "not a url")).toThrow(GitHostError);
  });

  it("times out a host that does not answer", async () => {
    fake.delayMs = 500;
    const adapter = make(testNet(fake, { timeoutMs: 100 }));
    await expect(adapter.probe()).rejects.toMatchObject({ code: "host_unreachable" });
  });

  it("builds the transport credential from the bot login and the token", async () => {
    const cred = await make().transportCredential("docs", "write");
    const basic = cred.authorization.reveal().replace(/^Basic /, "");
    expect(Buffer.from(basic, "base64").toString()).toBe(`${fake.login}:${fake.secret}`);
    expect(cred).toMatchObject({ narrowed: false, expiresAt: null, access: "write" });
  });

  it("creates a repository private and empty unless initialized", async () => {
    const repo = await make().createRepository({
      name: "inner",
      visibility: "internal",
      defaultBranch: "trunk",
    });
    expect(repo).toMatchObject({ private: true, empty: true, defaultBranch: "trunk" });
  });

  it("names the scope missing for creating a repository", async () => {
    fake.removeScopeFor("createRepository");
    await expect(
      make().createRepository({ name: "x", visibility: "private" }),
    ).rejects.toMatchObject({ code: "forbidden", details: { missingScope: "write:organization" } });
  });
});
