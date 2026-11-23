import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTestLoopback } from "@kobe/address-policy/testing";
import { serializeError } from "../log-safety.js";
import { GitHostError, type GitHostAdapter, type GitProvider } from "../git-hosts/adapter.js";
import type { GitHostNet } from "../git-hosts/http.js";

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
  /** The connection's base URL (`http://127.0.0.1:<port>`; the adapter derives its API root). */
  readonly baseUrl: string;
  readonly port: number;
  /** The organization the fake hosts; the adapter is connected to it. */
  readonly organization: string;
  reset(): void;
  fail(failure: ContractFailure | null): void;
  seedRepositories(names: readonly string[]): void;
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
  makeAdapter(net: GitHostNet, overrides?: { readonly baseUrl?: string }): GitHostAdapter;
  /** Every secret the adapter holds or received; no error may carry one. */
  secrets(): readonly string[];
}

export interface ContractNetOptions {
  readonly resolve?: readonly string[];
  readonly allowedHosts?: readonly string[];
  readonly allowHttp?: boolean;
}

/** A net for the local fake: plain HTTP on its port, loopback allowed only through the test hook. */
export function contractNet(fake: GitHostContractFake, o: ContractNetOptions = {}): GitHostNet {
  return {
    timeoutMs: 3000,
    ...(o.allowedHosts ? { allowedHosts: o.allowedHosts } : {}),
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
    setup.makeAdapter(contractNet(fake, o), baseUrl ? { baseUrl } : undefined);
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

    it("refuses a host outside the Site's host limit", async () => {
      const error = await caught(adapter({ allowedHosts: ["git.example.test"] }).probe());
      expect(error).toMatchObject({ code: "host_refused", reason: "site_host_limit" });
      expect(fake.apiHits()).toEqual([]);
    });

    it("reports an unresolvable host as unreachable", async () => {
      const net = contractNet(fake);
      const failing: GitHostNet = {
        ...net,
        policy: { ...net.policy, resolve: () => Promise.reject(new Error("nxdomain")) },
      };
      const error = await caught(
        setup.makeAdapter(failing, { baseUrl: `http://nowhere.test:${fake.port}` }).probe(),
      );
      expect(error.code).toBe("host_unreachable");
    });
  });
}
