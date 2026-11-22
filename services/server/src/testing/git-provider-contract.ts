import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTestLoopback } from "@kobe/address-policy/testing";
import type { GitHostNet } from "../git/net.js";
import { GitHostError, type GitHostErrorCode } from "../git/provider-errors.js";
import { GitSecret, type GitHostAdapter, type GitProvider } from "../git/provider.js";

/**
 * The shared provider-adapter contract (spec workspace-git §10: one interface, more providers
 * later; KOBE-758/759). Every adapter runs it against its own fake host; a fake implements
 * {@link GitHostFake} in provider-neutral terms. Tests only.
 */

export type GitHostFailure =
  "rate_limited" | "unavailable" | "redirect_elsewhere" | "oversized" | "garbage";

export interface GitHostFake {
  readonly baseUrl: string;
  readonly port: number;
  readonly organization: string;
  /** The valid credential's secret, to prove it never leaks. */
  readonly secret: string;
  start(): Promise<void>;
  close(): Promise<void>;
  /** Back to: credential valid with every scope, read/write, one repository named `docs`. */
  reset(): void;
  seedRepositories(count: number): void;
  repositoryNames(): string[];
  revokeCredential(): void;
  makeVersionTooOld(): void;
  /** Takes away what `op` needs; returns the scope the host will name, or null if it names none. */
  removeScopeFor(op: "createIssue" | "createRepository"): string | null;
  /** The credential may read but not write repositories. */
  denyWrite(): void;
  /** The next API call (not the version probe) fails this way. */
  failNext(kind: GitHostFailure): void;
  requests(): readonly { method: string; path: string; authorization: string | undefined }[];
}

export interface GitHostContractTarget {
  readonly name: string;
  readonly product: GitProvider;
  readonly fake: GitHostFake;
  adapter(net: GitHostNet): GitHostAdapter;
}

/** The test network: loopback (the fake) allowed by an injected checker, plain HTTP. */
export function testNet(fake: GitHostFake, overrides: Partial<GitHostNet> = {}): GitHostNet {
  return {
    timeoutMs: 3000,
    maxResponseBytes: 2 * 1024 * 1024,
    policy: {
      allowHttp: true,
      allowedPorts: [fake.port],
      allowedInternalCidrs: [],
      deniedCidrs: [],
      addresses: withTestLoopback(),
      resolve: () => Promise.resolve(["127.0.0.1"]),
    },
    ...overrides,
  };
}

async function failure(work: Promise<unknown>): Promise<GitHostError> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(GitHostError);
    return error as GitHostError;
  }
  throw new Error("expected a GitHostError");
}

async function expectCode(work: Promise<unknown>, code: GitHostErrorCode): Promise<GitHostError> {
  const error = await failure(work);
  expect(error.code).toBe(code);
  return error;
}

export function runGitHostContract(target: GitHostContractTarget): void {
  const { fake } = target;
  const make = (overrides: Partial<GitHostNet> = {}) => target.adapter(testNet(fake, overrides));
  const leaks = (error: GitHostError) => {
    const dump = `${error.message} ${JSON.stringify(error)} ${String(error.stack)}`;
    expect(dump).not.toContain(fake.secret);
    expect(dump).not.toContain(fake.baseUrl);
  };

  describe(`git host adapter contract: ${target.name}`, () => {
    beforeAll(() => fake.start());
    afterAll(() => fake.close());
    beforeEach(() => fake.reset());

    it("probes the product and a supported version", async () => {
      const probe = await make().probe();
      expect(probe).toMatchObject({ product: target.product, supported: true });
      expect(probe.minimumVersion).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it("tests the connection: organization, actor and abilities", async () => {
      const test = await make().testConnection();
      expect(test.organization.name).toBe(fake.organization);
      expect(test.actor.login).not.toBe("");
      expect(test.abilities).toMatchObject({ read: true, write: true, createRepositories: true });
      expect(test.extraPermissions).toEqual([]);
      expect(test.host.product).toBe(target.product);
    });

    it("refuses a version older than supported, with a clear message, before any other call", async () => {
      fake.makeVersionTooOld();
      const adapter = make();
      const probe = await adapter.probe();
      expect(probe.supported).toBe(false);
      const error = await expectCode(adapter.testConnection(), "version_unsupported");
      expect(error.message).toContain(probe.minimumVersion);
      expect(error.message).toMatch(/does not support|supports/);
      await expectCode(adapter.listRepositories(), "version_unsupported");
      expect(fake.requests().every((r) => r.path.endsWith("/version"))).toBe(true);
    });

    it("pages through every repository", async () => {
      fake.seedRepositories(7);
      const adapter = make();
      const names: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await adapter.listRepositories({ pageSize: 3, ...(cursor ? { cursor } : {}) });
        names.push(...page.items.map((r) => r.name));
        cursor = page.nextCursor ?? undefined;
        pages++;
      } while (cursor && pages < 10);
      expect(pages).toBe(3);
      expect(names.sort()).toEqual(fake.repositoryNames());
    });

    it("reads a repository with its default branch, and reports a missing one", async () => {
      const repo = await make().getRepository("docs");
      expect(repo).toMatchObject({
        name: "docs",
        fullName: `${fake.organization}/docs`,
        defaultBranch: "main",
        private: true,
      });
      await expectCode(make().getRepository("nope"), "not_found");
    });

    it.each(["../etc", "a/b", "..", ""])("refuses the repository name %j", async (name) => {
      await expectCode(make().getRepository(name), "invalid_request");
    });

    it("creates a private repository, and reports a name already taken", async () => {
      const adapter = make();
      const repo = await adapter.createRepository({ name: "new-one", visibility: "private" });
      expect(repo).toMatchObject({ name: "new-one", private: true });
      await expectCode(
        adapter.createRepository({ name: "new-one", visibility: "private" }),
        "conflict",
      );
    });

    it("opens a pull request, creates an issue and comments", async () => {
      const adapter = make();
      const pr = await adapter.openPullRequest({
        repository: "docs",
        title: "Change",
        body: "Opened by a test",
        head: "feature",
        base: "main",
      });
      expect(pr).toMatchObject({ title: "Change", state: "open" });
      expect(pr.number).toBeGreaterThan(0);
      const issue = await adapter.createIssue({ repository: "docs", title: "Bug", body: "x" });
      expect(issue.number).toBeGreaterThan(0);
      const comment = await adapter.comment({
        repository: "docs",
        number: issue.number,
        body: "noted",
      });
      expect(comment.webUrl).not.toBe("");
    });

    it("names a missing token scope when the host does", async () => {
      const scope = fake.removeScopeFor("createIssue");
      const error = await expectCode(
        make().createIssue({ repository: "docs", title: "Bug", body: "x" }),
        "forbidden",
      );
      if (scope) {
        expect(error.details.missingScope).toBe(scope);
        expect(error.message).toContain(scope);
      }
    });

    it("hands out a transport credential only for access the host grants", async () => {
      const adapter = make();
      const read = await adapter.transportCredential("docs", "read");
      expect(read).toMatchObject({ repository: `${fake.organization}/docs`, access: "read" });
      expect(read.authorization).toBeInstanceOf(GitSecret);
      expect(read.authorization.reveal()).not.toBe("");
      expect(JSON.stringify(read)).not.toContain(fake.secret);
      expect(String(read.authorization)).toBe("[redacted]");
      fake.denyWrite();
      await expectCode(make().transportCredential("docs", "write"), "forbidden");
      await expectCode(make().transportCredential("nope", "read"), "not_found");
    });

    it("maps a refused credential to auth_failed", async () => {
      fake.revokeCredential();
      leaks(await expectCode(make().getOrganization(), "auth_failed"));
    });

    it("maps throttling to rate_limited with the wait", async () => {
      const adapter = make();
      await adapter.probe();
      fake.failNext("rate_limited");
      const error = await expectCode(adapter.getOrganization(), "rate_limited");
      expect(error.details.retryAfterSeconds).toBe(30);
    });

    it("maps an unavailable host to host_unreachable", async () => {
      const adapter = make();
      await adapter.probe();
      fake.failNext("unavailable");
      leaks(await expectCode(adapter.getOrganization(), "host_unreachable"));
    });

    it("refuses to follow a redirect", async () => {
      const adapter = make();
      await adapter.probe();
      fake.failNext("redirect_elsewhere");
      leaks(await expectCode(adapter.getOrganization(), "host_not_allowed"));
    });

    it("caps the answer size and refuses an answer that is not the API", async () => {
      const adapter = make();
      await adapter.probe();
      fake.failNext("oversized");
      await expectCode(adapter.getOrganization(), "unexpected");
      fake.failNext("garbage");
      await expectCode(adapter.getOrganization(), "unexpected");
    });

    it("refuses a private address the Site does not allow, without sending anything", async () => {
      const net = testNet(fake);
      // The production checker: loopback and private ranges refused unless listed.
      const adapter = target.adapter({
        ...net,
        policy: {
          allowHttp: true,
          allowedPorts: [fake.port],
          allowedInternalCidrs: [],
          deniedCidrs: [],
          resolve: net.policy.resolve,
        },
      });
      leaks(await expectCode(adapter.probe(), "host_not_allowed"));
      expect(fake.requests()).toEqual([]);
    });

    it("refuses a host outside the Site's host limit, without sending anything", async () => {
      const adapter = make({ isHostAllowed: (host) => host === "git.example.com" });
      await expectCode(adapter.probe(), "host_not_allowed");
      expect(fake.requests()).toEqual([]);
    });

    it("refuses plain http unless the policy allows it", async () => {
      const net = testNet(fake);
      const adapter = target.adapter({ ...net, policy: { ...net.policy, allowHttp: false } });
      await expectCode(adapter.probe(), "host_not_allowed");
      expect(fake.requests()).toEqual([]);
    });

    it("reports a host that does not answer as host_unreachable", async () => {
      const adapter = make({ request: () => Promise.reject(new Error("ECONNREFUSED")) });
      await expectCode(adapter.probe(), "host_unreachable");
    });
  });
}
