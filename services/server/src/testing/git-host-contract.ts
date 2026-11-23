import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTestLoopback } from "@kobe/address-policy/testing";
import { serializeError } from "../log-safety.js";
import { GitHostError, type GitHostAdapter, type GitProvider } from "../git-hosts/adapter.js";
import type { GitHostNet } from "../git-hosts/http.js";
import { gitHostTarget, type GitHostTarget } from "../git-hosts/target.js";

/** The fakes' host name (resolved to 127.0.0.1 by {@link contractNet}): a name, never an IP literal. */
export const FAKE_GIT_HOST = "git.fake.test";

/**
 * The provider adapter contract (spec workspace-git §5, §9; KOBE-758): one suite every git host
 * adapter passes against its own fake upstream (GitHub's in `fake-github.ts`; Gitea and
 * Forgejo in `fake-gitea.ts`). A fake implements {@link GitHostContractFake}; the adapter's own tests call
 * {@link describeProviderContract} with a factory. Provider-specific behaviour (token narrowing,
 * header names, version checks) is tested next to each adapter.
 */

/** Failures a fake can be told to answer every API request with, until `fail(null)`/`reset()`. */
export type ContractFailure =
  | "auth"
  | "forbidden"
  | "rate_limited"
  | "secondary_rate_limited"
  | "server_error"
  | "redirect_foreign";

export interface GitHostContractFake {
  /** The connection's base URL (`http://git.fake.test:<port>`; the adapter derives its API root). */
  readonly baseUrl: string;
  readonly port: number;
  /** The organization the fake hosts; the adapter is connected to it. */
  readonly organization: string;
  reset(): void;
  fail(failure: ContractFailure | null): void;
  seedRepositories(names: readonly string[]): void;
  /** A file in a seeded repository of the organization (every repository has `README.md`). */
  seedFile(repository: string, path: string, text: string): void;
  /** A repository in another organization; returns its id. */
  seedForeignRepository(owner: string, name: string): string;
  /** API requests received, without credential minting. */
  apiHits(): readonly { method: string; path: string }[];
}

export interface ContractSetup {
  readonly provider: GitProvider;
  readonly fake: GitHostContractFake;
  start(): Promise<void>;
  close(): Promise<void>;
  /** Called after `reset()`, before each test: prepare credentials and fake options. */
  prepare?(): void;
  /** Builds the adapter for the Site's decision `target` (`gitHostTarget()`). */
  makeAdapter(net: GitHostNet, target: GitHostTarget): GitHostAdapter;
  /** Every secret the adapter holds or received; no error may carry one. */
  secrets(): readonly string[];
}

export interface ContractNetOptions {
  readonly resolve?: readonly string[];
  readonly allowHttp?: boolean;
}

export interface ContractSiteOptions {
  /** The Site switch (default on). */
  readonly enabled?: boolean;
  /** The Site's host limit (default any host). */
  readonly allowedHosts?: readonly string[];
}

/**
 * The Site's decision for a fake's base URL. Plain HTTP is accepted at the decision (the fakes
 * serve HTTP); the net's address policy still decides whether HTTP may be sent.
 */
export function contractTarget(baseUrl: string, o: ContractSiteOptions = {}): GitHostTarget {
  return gitHostTarget(
    { enabled: o.enabled ?? true, allowedHosts: o.allowedHosts ?? [] },
    baseUrl,
    { allowHttp: true },
  );
}

/** A net for the local fake: plain HTTP on its port, loopback allowed only through the test hook. */
export function contractNet(fake: GitHostContractFake, o: ContractNetOptions = {}): GitHostNet {
  return {
    timeoutMs: 3000,
    policy: {
      allowHttp: o.allowHttp ?? true,
      allowedPorts: [fake.port],
      allowedInternalCidrs: [],
      deniedCidrs: [],
      addresses: withTestLoopback(),
      resolve: () => Promise.resolve(o.resolve ?? ["127.0.0.1"]),
    },
  };
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

export function describeProviderContract(name: string, setup: ContractSetup): void {
  const { fake } = setup;
  const adapter = (o?: ContractNetOptions, baseUrl?: string) =>
    setup.makeAdapter(contractNet(fake, o), contractTarget(baseUrl ?? fake.baseUrl));
  const noSecrets = (error: GitHostError) => {
    const text = `${error.message} ${JSON.stringify(serializeError(error))} ${JSON.stringify(error)}`;
    for (const s of setup.secrets()) expect(text).not.toContain(s);
  };

  describe(`git host adapter contract: ${name}`, () => {
    beforeAll(() => setup.start());
    afterAll(() => setup.close());
    beforeEach(() => {
      fake.reset();
      setup.prepare?.();
    });

    it("probes the connection: provider, organization, capabilities", async () => {
      const probe = await adapter().probe();
      expect(probe.provider).toBe(setup.provider);
      expect(probe.organization.login.toLowerCase()).toBe(fake.organization.toLowerCase());
      for (const c of Object.values(probe.capabilities)) {
        expect(["yes", "no", "unknown"]).toContain(c);
      }
      expect(Array.isArray(probe.excess)).toBe(true);
    });

    it("describes the organization", async () => {
      const org = await adapter().describeOrganization();
      expect(org).toMatchObject({ kind: "organization" });
      expect(org.id).not.toBe("");
    });

    it("pages through repositories", async () => {
      fake.seedRepositories(Array.from({ length: 150 }, (_, i) => `repo-${i}`));
      const a = adapter();
      // Hosts cap the page size (GitHub at 100, Gitea at 50 by default): follow `next`.
      const names = new Set<string>();
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page = await a.listRepositories({ perPage: 100, cursor });
        expect(page.items.length).toBeGreaterThan(0);
        expect(page.items.length).toBeLessThanOrEqual(100);
        for (const r of page.items) names.add(r.name);
        cursor = page.next;
        pages += 1;
      } while (cursor !== null && pages < 10);
      expect(cursor).toBeNull();
      expect(pages).toBeGreaterThanOrEqual(2);
      expect(names.size).toBe(150);
    });

    it("reads a repository by name and by id, with its default branch", async () => {
      fake.seedRepositories(["docs"]);
      const a = adapter();
      const repo = await a.getRepository({ name: "docs" });
      expect(repo).toMatchObject({ name: "docs", visibility: "private", defaultBranch: "main" });
      expect(repo.fullName.toLowerCase()).toBe(`${fake.organization}/docs`.toLowerCase());
      expect(await a.getRepository({ id: repo.id })).toMatchObject({ name: "docs" });
    });

    it("reports a missing repository as not found", async () => {
      fake.seedRepositories(["docs"]);
      expect((await caught(adapter().getRepository({ name: "nope" }))).code).toBe("not_found");
    });

    it("treats a repository of another organization as not found", async () => {
      const id = fake.seedForeignRepository("other-org", "secret");
      expect((await caught(adapter().getRepository({ id }))).code).toBe("not_found");
    });

    it.each(["../x", "a/b", "", ".", "x.git", "a b"])(
      "refuses the repository name %j before sending",
      async (bad) => {
        const error = await caught(adapter().getRepository({ name: bad }));
        expect(error.code).toBe("invalid_request");
        expect(fake.apiHits()).toEqual([]);
      },
    );

    it("creates a private repository and refuses a taken name", async () => {
      const a = adapter();
      const repo = await a.createRepository({ name: "new-repo", visibility: "private" });
      expect(repo).toMatchObject({ name: "new-repo", visibility: "private" });
      expect(await a.getRepository({ name: "new-repo" })).toMatchObject({ id: repo.id });
      const again = await caught(a.createRepository({ name: "new-repo", visibility: "private" }));
      expect(again.code).toBe("conflict");
    });

    it("never creates a public repository", async () => {
      const error = await caught(
        adapter().createRepository({ name: "x", visibility: "public" as "private" }),
      );
      expect(error.code).toBe("invalid_request");
      expect(fake.apiHits()).toEqual([]);
    });

    it.each(["read", "write"] as const)("gives a %s transport credential", async (access) => {
      fake.seedRepositories(["docs"]);
      const cred = await adapter().repositoryCredential("docs", access);
      expect(cred.access).toBe(access);
      expect(cred.username).not.toBe("");
      expect(cred.password).not.toBe("");
    });

    it("opens a pull request, comments and creates an issue", async () => {
      fake.seedRepositories(["docs"]);
      const a = adapter();
      const pr = await a.openPullRequest({
        repository: "docs",
        title: "Change",
        body: "Body",
        head: "feature",
        base: "main",
      });
      expect(pr.number).toBeGreaterThan(0);
      expect(pr.webUrl).not.toBe("");
      const comment = await a.comment({
        repository: "docs",
        number: pr.number ?? 0,
        on: "pull_request",
        body: "Note",
      });
      expect(comment).toMatchObject({ number: null });
      const issue = await a.createIssue({ repository: "docs", title: "Bug", body: "Details" });
      expect(issue.number).toBeGreaterThan(0);
    });

    it("refuses a pull request head in another namespace", async () => {
      fake.seedRepositories(["docs"]);
      const error = await caught(
        adapter().openPullRequest({
          repository: "docs",
          title: "t",
          body: "b",
          head: "attacker:feature",
          base: "main",
        }),
      );
      expect(error.code).toBe("invalid_request");
    });

    it("lists branches and creates one from a branch and from a commit (KOBE-762)", async () => {
      fake.seedRepositories(["docs"]);
      const a = adapter();
      const first = await a.listBranches("docs");
      const main = first.items.find((b) => b.name === "main");
      expect(main?.commitSha).toMatch(/^[0-9a-f]{40}$/);
      const made = await a.createBranch({ repository: "docs", name: "kobe/feature", from: "main" });
      expect(made).toMatchObject({ name: "kobe/feature", commitSha: main?.commitSha });
      const bySha = await a.createBranch({
        repository: "docs",
        name: "from-sha",
        from: main?.commitSha ?? "",
      });
      expect(bySha.commitSha).toBe(main?.commitSha);
      const names = (await a.listBranches("docs")).items.map((b) => b.name);
      expect(names).toEqual(expect.arrayContaining(["main", "kobe/feature", "from-sha"]));
      const again = await caught(
        a.createBranch({ repository: "docs", name: "kobe/feature", from: "main" }),
      );
      expect(again.code).toBe("conflict");
    });

    it.each(["bad..name", "owner:branch", "-x", "a b"])(
      "refuses the branch name %j before sending",
      async (bad) => {
        fake.seedRepositories(["docs"]);
        const error = await caught(
          adapter().createBranch({ repository: "docs", name: bad, from: "main" }),
        );
        expect(error.code).toBe("invalid_request");
        expect(fake.apiHits()).toEqual([]);
      },
    );

    it("reads a file, a directory, and says when a file is binary (KOBE-762)", async () => {
      fake.seedRepositories(["docs"]);
      fake.seedFile("docs", "src/app.ts", "export const x = 1;\n");
      fake.seedFile("docs", "img.bin", "a\u0000b");
      const a = adapter();
      expect(await a.readFile("docs", "README.md")).toMatchObject({
        kind: "file",
        path: "README.md",
        binary: false,
        truncated: false,
        content: "# Hello\n",
      });
      const dir = await a.readFile("docs", "");
      expect(dir.kind).toBe("directory");
      if (dir.kind === "directory") {
        expect(dir.entries.map((e) => e.name)).toEqual(
          expect.arrayContaining(["README.md", "src"]),
        );
      }
      expect(await a.readFile("docs", "src/app.ts", "main")).toMatchObject({
        content: "export const x = 1;\n",
      });
      expect(await a.readFile("docs", "img.bin")).toMatchObject({ binary: true, content: "" });
      expect((await caught(a.readFile("docs", "nope.md"))).code).toBe("not_found");
    });

    it.each(["../etc/passwd", "a/../b", "a//b", "x\u0000y"])(
      "refuses the file path %j before sending",
      async (bad) => {
        fake.seedRepositories(["docs"]);
        const error = await caught(adapter().readFile("docs", bad));
        expect(error.code).toBe("invalid_request");
        expect(fake.apiHits()).toEqual([]);
      },
    );

    it("lists and reads pull requests and issues apart (KOBE-762)", async () => {
      fake.seedRepositories(["docs"]);
      const a = adapter();
      await a.createBranch({ repository: "docs", name: "feature", from: "main" });
      const pr = await a.openPullRequest({
        repository: "docs",
        title: "Change",
        body: "PR body",
        head: "feature",
        base: "main",
      });
      const issue = await a.createIssue({ repository: "docs", title: "Bug", body: "Issue body" });
      const prs = await a.listPullRequests("docs", { state: "open" });
      expect(prs.items.map((p) => p.number)).toContain(pr.number);
      expect(prs.items[0]).not.toHaveProperty("body");
      expect(await a.getPullRequest("docs", pr.number ?? 0)).toMatchObject({
        title: "Change",
        body: "PR body",
        head: "feature",
        base: "main",
        state: "open",
      });
      const issues = await a.listIssues("docs");
      expect(issues.items.map((i) => i.number)).toEqual([issue.number]);
      expect(await a.getIssue("docs", issue.number ?? 0)).toMatchObject({
        title: "Bug",
        body: "Issue body",
        state: "open",
      });
      expect((await caught(a.getIssue("docs", pr.number ?? 0))).code).toBe("not_found");
    });

    it.each([
      ["auth", "auth_failed"],
      ["forbidden", "forbidden"],
      ["rate_limited", "rate_limited"],
      ["secondary_rate_limited", "rate_limited"],
      ["server_error", "host_unreachable"],
      ["redirect_foreign", "host_refused"],
    ] as const)("maps %s to %s without leaking a secret", async (failure, code) => {
      fake.seedRepositories(["docs"]);
      const a = adapter();
      await a.getRepository({ name: "docs" });
      fake.fail(failure);
      const error = await caught(a.getRepository({ name: "docs" }));
      expect(error.code).toBe(code);
      if (code === "rate_limited") {
        expect(error.resetAt?.getTime()).toBeGreaterThan(Date.now());
      }
      noSecrets(error);
    });

    it.each(["10.0.0.5", "169.254.169.254", "192.168.50.10"])(
      "refuses a base URL that resolves to %s, sending nothing",
      async (address) => {
        const error = await caught(
          adapter({ resolve: [address] }, `http://git.internal.test:${fake.port}`).probe(),
        );
        expect(error.code).toBe("host_refused");
        expect(fake.apiHits()).toEqual([]);
      },
    );

    it("refuses plain HTTP when the policy wants https", async () => {
      const error = await caught(adapter({ allowHttp: false }).probe());
      expect(error.code).toBe("host_refused");
      expect(fake.apiHits()).toEqual([]);
    });

    it("refuses a host outside the Site's host limit: no adapter, nothing sent", () => {
      expect(() => contractTarget(fake.baseUrl, { allowedHosts: ["git.example.test"] })).toThrow(
        expect.objectContaining({ code: "host_refused", reason: "site_host_limit" }),
      );
      expect(fake.apiHits()).toEqual([]);
    });

    it("accepts a host the Site limit covers by pattern", async () => {
      const target = contractTarget(fake.baseUrl, { allowedHosts: ["*.fake.test"] });
      const probe = await setup.makeAdapter(contractNet(fake), target).probe();
      expect(probe.provider).toBe(setup.provider);
    });

    it("refuses everything while the Site switch is off: no adapter, nothing sent", () => {
      expect(() => contractTarget(fake.baseUrl, { enabled: false })).toThrow(
        expect.objectContaining({ code: "host_refused", reason: "site_git_off" }),
      );
      expect(fake.apiHits()).toEqual([]);
    });

    it("cannot be built without the Site's decision", () => {
      const forged = { baseUrl: fake.baseUrl, host: FAKE_GIT_HOST } as unknown as GitHostTarget;
      expect(() => setup.makeAdapter(contractNet(fake), forged)).toThrow(
        expect.objectContaining({ code: "host_refused", reason: "no_site_decision" }),
      );
      expect(fake.apiHits()).toEqual([]);
    });

    it("refuses an IP-literal base URL at the decision", () => {
      expect(() => contractTarget(`http://127.0.0.1:${fake.port}`)).toThrow(
        expect.objectContaining({ code: "invalid_request" }),
      );
    });

    it("builds the clone URL from the base URL, and web links stay on the host", async () => {
      fake.seedRepositories(["docs"]);
      const repo = await adapter().getRepository({ name: "docs" });
      expect(repo.cloneUrl).toBe(`${fake.baseUrl}/${fake.organization}/docs.git`);
      expect(repo.webUrl === "" || repo.webUrl.startsWith(`${fake.baseUrl}/`)).toBe(true);
    });

    it("hands out a transport credential only after the host confirms access", async () => {
      fake.seedRepositories(["docs"]);
      const cred = await adapter().repositoryCredential("docs", "read");
      expect(typeof cred.narrowed).toBe("boolean");
      const missing = await caught(adapter().repositoryCredential("nope", "read"));
      expect(["not_found", "forbidden", "invalid_request"]).toContain(missing.code);
    });

    it("reports an unresolvable host as unreachable", async () => {
      const net = contractNet(fake);
      const failing: GitHostNet = {
        ...net,
        policy: { ...net.policy, resolve: () => Promise.reject(new Error("nxdomain")) },
      };
      const error = await caught(
        setup.makeAdapter(failing, contractTarget(`http://nowhere.test:${fake.port}`)).probe(),
      );
      expect(error.code).toBe("host_unreachable");
    });
  });
}
