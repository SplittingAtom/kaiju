import type { GitCredentialKind } from "@kobe/db";
import {
  assertBranch,
  assertNumber,
  assertRepositoryName,
  cursorPage,
  GitHostError,
  safeWebUrl,
  type GitAccess,
  type GitCommentInput,
  type GitCreated,
  type GitCreateIssueInput,
  type GitCreateRepositoryInput,
  type GitHostAdapter,
  type GitHostProbe,
  type GitOpenPullRequestInput,
  type GitOrganization,
  type GitRepository,
  type GitRepositoryCredential,
  type GitRepositoryRef,
} from "../adapter.js";
import { assertGitHostTarget, type GitHostTarget } from "../target.js";
import {
  header,
  hostRequest,
  type GitHostNet,
  type HostRequestInit,
  type HostResponse,
} from "../http.js";
import {
  appHeaders,
  assertAppIds,
  sharedTokenCache,
  forgetAppToken,
  installationToken,
  scopeKey,
  type AppAuthContext,
  type GitHubAppCredential,
  type InstallationScope,
  type InstallationTokenCache,
} from "./app-auth.js";
import { githubError, rateLimitOf } from "./errors.js";
import {
  appCapabilities,
  assertGithubLogin,
  classicCapabilities,
  githubUrls,
  nextPage,
  ownerLogin,
  toOrganization,
  toRepository,
  tokenExpiry,
} from "./mapping.js";

/**
 * The GitHub provider adapter (spec workspace-git G5, G6, §9; KOBE-758): github.com and GitHub
 * Enterprise Server, with a GitHub App installation (a token minted per use, narrowed to the
 * repository and permissions of that use) or a fine-grained personal access token (the whole
 * grant, G6). Stateless apart from the in-memory installation token cache.
 */

/** A fine-grained personal access token (or a classic one, reported as excess). */
export interface GitHubTokenCredential {
  readonly kind: Extract<GitCredentialKind, "access_token">;
  readonly token: string;
}

export type GitHubCredential = GitHubAppCredential | GitHubTokenCredential;

export interface GitHubAdapterOptions {
  /**
   * The Site's decision for the connection's base URL (`gitHostTarget()`, G3): `https://github.com`
   * or an Enterprise Server's. There is no way to build the adapter without one.
   */
  readonly target: GitHostTarget;
  readonly organization: string;
  /** Unsealed by the caller; never stored, logged or returned. */
  readonly credential: GitHubCredential;
  readonly net: GitHostNet;
  readonly now?: () => number;
  readonly tokenCache?: InstallationTokenCache;
}

/** The user name GitHub expects with a token over smart-HTTP. */
const GIT_USERNAME = "x-access-token";
const API_VERSION = "2022-11-28";
const DEFAULT_PER_PAGE = 30;
const MAX_PER_PAGE = 100;
const METADATA: InstallationScope = { permissions: { metadata: "read" } };

const sameLogin = (a: string | null, b: string) =>
  a !== null && a.toLowerCase() === b.toLowerCase();

function created(json: unknown, withNumber: boolean, webBase: string): GitCreated {
  const j = (json ?? {}) as { id?: unknown; number?: unknown; html_url?: unknown };
  if (typeof j.id !== "number" && typeof j.id !== "string") {
    throw new GitHostError("unexpected", "GitHub returned no id for what it created.");
  }
  return {
    id: String(j.id),
    number: withNumber && typeof j.number === "number" ? j.number : null,
    webUrl: safeWebUrl(j.html_url, webBase),
  };
}

export function createGitHubAdapter(options: GitHubAdapterOptions): GitHostAdapter {
  const { net, credential, target } = options;
  assertGitHostTarget(target);
  const org = options.organization;
  const now = options.now ?? Date.now;
  const urls = (() => {
    try {
      return { ok: true as const, ...githubUrls(target.baseUrl) };
    } catch (error) {
      return { ok: false as const, error };
    }
  })();
  const app: AppAuthContext | null =
    credential.kind === "github_app" && urls.ok
      ? {
          net,
          target,
          apiRoot: urls.apiRoot,
          credential,
          cache: options.tokenCache ?? sharedTokenCache,
          now,
        }
      : null;
  let orgKind: "organization" | "user" | null = null;

  /** Every call starts here: URL, organization, ids (the Site's decision is re-checked per request). */
  function preflight(): { apiRoot: string; webBase: string } {
    if (!urls.ok) throw urls.error;
    assertGithubLogin(org);
    if (credential.kind === "github_app") assertAppIds(credential);
    return { apiRoot: urls.apiRoot, webBase: urls.webBase };
  }

  const baseHeaders = (token: string): Record<string, string> => ({
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": API_VERSION,
  });

  const send = (path: string, init: Omit<HostRequestInit, "headers">, token: string) => {
    const { apiRoot } = preflight();
    return hostRequest(net, target, apiRoot, `${apiRoot}${path}`, {
      ...init,
      headers: baseHeaders(token),
    });
  };

  /**
   * One API call with the credential: the token as is, or an installation token for `scope`. A
   * cached installation token the host rejects (revoked, expired early) is dropped and the call
   * made once more with a fresh one.
   */
  async function call(
    path: string,
    init: Omit<HostRequestInit, "headers">,
    scope: InstallationScope,
  ): Promise<HostResponse> {
    preflight();
    if (credential.kind === "access_token") return send(path, init, credential.token);
    const ctx = app as AppAuthContext;
    await verifyAppAccount(ctx);
    const first = await send(path, init, (await installationToken(ctx, scope)).token);
    if (first.status !== 401) return first;
    forgetAppToken(ctx, scope);
    return send(path, init, (await installationToken(ctx, scope)).token);
  }

  async function ok(res: Promise<HostResponse>, expected: readonly number[] = [200]) {
    const r = await res;
    if (!expected.includes(r.status)) throw githubError(r, now());
    return r;
  }

  /** The installation as GitHub describes it, read with the App's JWT. */
  async function installation(ctx: AppAuthContext): Promise<HostResponse> {
    const { apiRoot } = preflight();
    const res = await hostRequest(
      net,
      target,
      apiRoot,
      `${apiRoot}/app/installations/${ctx.credential.installationId}`,
      { method: "GET", headers: appHeaders(ctx) },
    );
    if (res.status === 404) {
      throw new GitHostError("auth_failed", "The GitHub App installation was not found.", {
        status: 404,
        reason: "installation_removed",
      });
    }
    if (res.status !== 200) throw githubError(res, now());
    const j = (res.json ?? {}) as { account?: { login?: unknown }; suspended_at?: unknown };
    if (j.suspended_at !== null && j.suspended_at !== undefined) {
      throw new GitHostError("auth_failed", "The GitHub App installation is suspended.", {
        reason: "installation_suspended",
      });
    }
    // The installation must be on the connected organization: tokens act on its account only.
    if (!sameLogin(typeof j.account?.login === "string" ? j.account.login : null, org)) {
      throw new GitHostError("auth_failed", "That installation belongs to another account.", {
        reason: "installation_account_mismatch",
      });
    }
    return res;
  }

  async function verifyAppAccount(ctx: AppAuthContext): Promise<void> {
    const key = `${scopeKey(ctx.apiRoot, ctx.credential, { permissions: {} })}:${org.toLowerCase()}`;
    if (ctx.cache.isVerified(key, now())) return;
    await installation(ctx);
    ctx.cache.markVerified(key, now());
  }

  async function readOrganization(scope = METADATA): Promise<{
    org: GitOrganization;
    res: HostResponse;
  }> {
    const res = await call(`/orgs/${org}`, { method: "GET" }, scope);
    if (res.status === 200) {
      orgKind = "organization";
      return { org: toOrganization(res.json, "organization", web()), res };
    }
    if (res.status !== 404) throw githubError(res, now());
    const user = await ok(call(`/users/${org}`, { method: "GET" }, scope));
    orgKind = "user";
    return { org: toOrganization(user.json, "user", web()), res: user };
  }

  async function kind(): Promise<"organization" | "user"> {
    if (orgKind === null) await readOrganization();
    return orgKind ?? "organization";
  }

  const repoPath = (name: string) => `/repos/${org}/${assertRepositoryName(name)}`;
  const web = () => preflight().webBase;

  /** A repository answer that is not in the organization reads as not found (§9). */
  function confined(json: unknown): GitRepository {
    if (!sameLogin(ownerLogin(json), org)) {
      throw new GitHostError("not_found", "Not found in the connected organization.");
    }
    return toRepository(json, web(), org);
  }

  /**
   * The login a token belongs to (`/user`), read once per adapter. In a user namespace a token
   * acts on its owner's account, so the connected owner must be that login (review M3).
   */
  let tokenLogin: Promise<string | null> | undefined;
  function loginOf(token: string): Promise<string | null> {
    tokenLogin ??= ok(send("/user", { method: "GET" }, token))
      .then((me) => {
        const login = (me.json as { login?: unknown } | undefined)?.login;
        return typeof login === "string" ? login : null;
      })
      .catch((error: unknown) => {
        tokenLogin = undefined;
        throw error;
      });
    return tokenLogin;
  }

  const ownerMismatch = () =>
    new GitHostError("forbidden", "The token belongs to another account than the connected one.", {
      reason: "token_owner_mismatch",
    });

  /** In a user namespace, a token may act only when it is that user's own (review M3). */
  async function assertOwnNamespace(): Promise<void> {
    if ((await kind()) !== "user" || credential.kind !== "access_token") return;
    if (!sameLogin(await loginOf(credential.token), org)) throw ownerMismatch();
  }

  async function probeApp(ctx: AppAuthContext): Promise<GitHostProbe> {
    const inst = await installation(ctx);
    const j = (inst.json ?? {}) as {
      permissions?: Record<string, unknown>;
      app_slug?: unknown;
      target_type?: unknown;
    };
    const { org: organization, res } = await readOrganization();
    const { capabilities, excess } = appCapabilities(j.permissions ?? {}, organization.kind);
    return {
      provider: "github",
      organization,
      hostVersion: header(res, "x-github-enterprise-version") ?? null,
      actor: {
        kind: "app",
        login: typeof j.app_slug === "string" ? `${j.app_slug}[bot]` : null,
      },
      capabilities,
      excess,
      credentialExpiresAt: null,
      rateLimit: rateLimitOf(res, now()),
    };
  }

  async function probeToken(token: string): Promise<GitHostProbe> {
    const me = await ok(send("/user", { method: "GET" }, token));
    const login = (me.json as { login?: unknown } | undefined)?.login;
    const { org: organization, res } = await readOrganization();
    // A user namespace: the token must be that user's (review M3), else it acts elsewhere.
    if (organization.kind === "user" && !sameLogin(typeof login === "string" ? login : null, org)) {
      throw ownerMismatch();
    }
    const scopes = header(me, "x-oauth-scopes");
    let result: Pick<GitHostProbe, "capabilities" | "excess">;
    if (scopes !== undefined) {
      result = classicCapabilities(scopes);
    } else {
      // A fine-grained token's permissions cannot be read back: reading is shown by listing.
      const list = await send(
        organization.kind === "organization"
          ? `/orgs/${org}/repos?per_page=1`
          : `/user/repos?affiliation=owner&per_page=1`,
        { method: "GET" },
        token,
      );
      const listed = list.status === 200 && Array.isArray(list.json) && list.json.length > 0;
      result = {
        capabilities: {
          create: "unknown",
          read: listed ? "yes" : "unknown",
          write: "unknown",
          admin: "unknown",
        },
        excess: [],
      };
    }
    return {
      provider: "github",
      organization,
      hostVersion: header(res, "x-github-enterprise-version") ?? null,
      actor: { kind: "token", login: typeof login === "string" ? login : null },
      ...result,
      credentialExpiresAt: tokenExpiry(header(me, "github-authentication-token-expiration")),
      rateLimit: rateLimitOf(res, now()),
    };
  }

  return {
    provider: "github",

    async probe() {
      preflight();
      return credential.kind === "access_token"
        ? probeToken(credential.token)
        : probeApp(app as AppAuthContext);
    },

    async describeOrganization() {
      return (await readOrganization()).org;
    },

    async listRepositories(opts = {}) {
      const page = cursorPage(opts.cursor);
      const perPage = Math.min(
        Math.max(1, Math.floor(opts.perPage ?? DEFAULT_PER_PAGE)),
        MAX_PER_PAGE,
      );
      const query = `per_page=${perPage}&page=${page}`;
      let path: string;
      if (credential.kind === "github_app") path = `/installation/repositories?${query}`;
      else if ((await kind()) === "organization") path = `/orgs/${org}/repos?type=all&${query}`;
      else {
        await assertOwnNamespace();
        path = `/user/repos?affiliation=owner&visibility=all&${query}`;
      }
      const res = await ok(call(path, { method: "GET" }, METADATA));
      const raw = Array.isArray(res.json)
        ? (res.json as unknown[])
        : (((res.json as { repositories?: unknown } | undefined)?.repositories ?? []) as unknown[]);
      if (!Array.isArray(raw)) throw new GitHostError("unexpected", "GitHub returned no list.");
      const items = raw
        .filter((r) => sameLogin(ownerLogin(r), org))
        .map((r) => toRepository(r, web(), org));
      const next = nextPage(header(res, "link"));
      return { items, next: next !== null && next > page ? String(next) : null };
    },

    async getRepository(ref: GitRepositoryRef) {
      if ("name" in ref) {
        const scope = { repositories: [assertRepositoryName(ref.name)], ...METADATA };
        return confined((await ok(call(repoPath(ref.name), { method: "GET" }, scope))).json);
      }
      if (!/^\d{1,20}$/.test(ref.id)) {
        throw new GitHostError("invalid_request", "That is not a valid repository id.");
      }
      return confined(
        (await ok(call(`/repositories/${ref.id}`, { method: "GET" }, METADATA))).json,
      );
    },

    async createRepository(input: GitCreateRepositoryInput) {
      const name = assertRepositoryName(input.name);
      const visibility = input.visibility as string;
      if (visibility !== "private" && visibility !== "internal") {
        throw new GitHostError("invalid_request", "Kobe creates private repositories only.");
      }
      const k = await kind();
      // Exactly the connected owner (review M3): the org endpoint for an organization; a user's
      // own namespace only with that user's token (an App cannot create in a user account).
      if (k === "user") {
        if (credential.kind !== "access_token") {
          throw new GitHostError("forbidden", "A GitHub App cannot create repositories there.", {
            reason: "user_namespace",
          });
        }
        await assertOwnNamespace();
      }
      const path = k === "organization" ? `/orgs/${org}/repos` : "/user/repos";
      const body = {
        name,
        private: true,
        ...(k === "organization" ? { visibility } : {}),
        ...(input.description === undefined ? {} : { description: input.description }),
      };
      const scope: InstallationScope = {
        permissions: { administration: "write", metadata: "read" },
      };
      const res = await ok(call(path, { method: "POST", body }, scope), [201]);
      return confined(res.json);
    },

    async repositoryCredential(repository: string, access: GitAccess) {
      const name = assertRepositoryName(repository);
      if (access !== "read" && access !== "write") {
        throw new GitHostError("invalid_request", "Access must be read or write.");
      }
      preflight();
      if (credential.kind === "access_token") {
        // As for Gitea (review L1): the repository is in the organization and the token's account
        // may read or write it, before the token is handed out (`narrowed: false`, G11).
        await assertOwnNamespace();
        const res = await ok(call(repoPath(name), { method: "GET" }, METADATA));
        confined(res.json);
        const perms = (res.json as { permissions?: { pull?: unknown; push?: unknown } })
          .permissions;
        if ((access === "write" ? perms?.push : perms?.pull) !== true) {
          throw new GitHostError("forbidden", `The credential may not ${access} that repository.`);
        }
        return {
          username: GIT_USERNAME,
          password: credential.token,
          expiresAt: null,
          access,
          narrowed: false,
        };
      }
      const ctx = app as AppAuthContext;
      await verifyAppAccount(ctx);
      const t = await installationToken(ctx, {
        repositories: [name],
        permissions: { contents: access, metadata: "read" },
      });
      return {
        username: GIT_USERNAME,
        password: t.token,
        expiresAt: t.expiresAt,
        access,
        narrowed: true,
      } satisfies GitRepositoryCredential;
    },

    async openPullRequest(input: GitOpenPullRequestInput) {
      const name = assertRepositoryName(input.repository);
      const body = {
        title: input.title,
        body: input.body,
        head: assertBranch(input.head),
        base: assertBranch(input.base),
        ...(input.draft === undefined ? {} : { draft: input.draft }),
      };
      const scope: InstallationScope = {
        repositories: [name],
        permissions: { pull_requests: "write", contents: "read", metadata: "read" },
      };
      const res = await ok(call(`${repoPath(name)}/pulls`, { method: "POST", body }, scope), [201]);
      return created(res.json, true, web());
    },

    async comment(input: GitCommentInput) {
      const name = assertRepositoryName(input.repository);
      const n = assertNumber(input.number);
      const permission = input.on === "pull_request" ? "pull_requests" : "issues";
      const scope: InstallationScope = {
        repositories: [name],
        permissions: { [permission]: "write", metadata: "read" },
      };
      const res = await ok(
        call(
          `${repoPath(name)}/issues/${n}/comments`,
          { method: "POST", body: { body: input.body } },
          scope,
        ),
        [201],
      );
      return created(res.json, false, web());
    },

    async createIssue(input: GitCreateIssueInput) {
      const name = assertRepositoryName(input.repository);
      const scope: InstallationScope = {
        repositories: [name],
        permissions: { issues: "write", metadata: "read" },
      };
      const res = await ok(
        call(
          `${repoPath(name)}/issues`,
          { method: "POST", body: { title: input.title, body: input.body } },
          scope,
        ),
        [201],
      );
      return created(res.json, true, web());
    },
  };
}
