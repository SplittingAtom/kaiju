import { GitHostError, type GitHostErrorCode } from "../provider-errors.js";
import {
  GitSecret,
  type GitAccess,
  type GitComment,
  type GitCommentInput,
  type GitConnectionTest,
  type GitCreateRepository,
  type GitHostAdapter,
  type GitHostProbe,
  type GitIssue,
  type GitIssueInput,
  type GitOrganization,
  type GitPage,
  type GitPageRequest,
  type GitPullRequest,
  type GitPullRequestInput,
  type GitRepository,
  type GitTransportCredential,
} from "../provider.js";
import {
  gitHostRequest,
  hasNextLink,
  headerOf,
  retryAfterSeconds,
  type GitHostNet,
  type GitHttpInit,
  type GitHttpResponse,
} from "../net.js";
import { judgeVersion } from "./version.js";
import {
  asComment,
  asIssue,
  asOrganization,
  asPermissions,
  asPullRequest,
  asRepository,
  asUser,
  asVersion,
} from "./wire.js";

/**
 * One adapter for Gitea and Forgejo (spec workspace-git G7, KOBE-759): Forgejo is a fork of Gitea
 * and serves the same `/api/v1`. The credential is a bot account's access token (G6), sent as
 * `Authorization: token …`. The host's version is read once per adapter and anything older than
 * the supported minimum is refused before any other call.
 */
export interface GiteaAdapterConfig {
  /** What the admin chose; the detected product is reported and a mismatch is noted. */
  readonly provider: "gitea" | "forgejo";
  /** e.g. `https://git.example.com` or `https://example.com/gitea` (a sub-path install). */
  readonly baseUrl: string;
  readonly organization: string;
  readonly token: GitSecret;
  readonly net: GitHostNet;
}

/** Gitea's own page cap (`[api] MAX_RESPONSE_ITEMS`, default 50). */
export const GITEA_MAX_PAGE_SIZE = 50;
const MAX_PAGE = 10_000;

/** Gitea's repository and owner name rule (alphanumerics, `-`, `_`, `.`; not `.` or `..`). */
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

function checkName(name: string): string {
  if (!NAME.test(name) || name === "." || name === "..") {
    throw new GitHostError("invalid_request");
  }
  return name;
}

/** Gitea's 403 for a token scope: `… required scope(s)[:] [write:issue] …` (1.19 and later). */
const SCOPE_IN_MESSAGE = /required scope\(s\)[^[]*\[([a-z]+:[a-z_]+)/i;

function missingScopeOf(json: unknown): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const message = (json as { message?: unknown }).message;
  if (typeof message !== "string") return undefined;
  return SCOPE_IN_MESSAGE.exec(message.slice(0, 1000))?.[1]?.toLowerCase();
}

/** A non-2xx answer as a typed error; the host's message is never copied in. */
export function errorFor(res: GitHttpResponse): GitHostError {
  const status = res.status;
  const code: GitHostErrorCode =
    status === 401
      ? "auth_failed"
      : status === 403
        ? "forbidden"
        : status === 404
          ? "not_found"
          : status === 409
            ? "conflict"
            : status === 400 || status === 422
              ? "invalid_request"
              : status === 429
                ? "rate_limited"
                : status === 502 || status === 503 || status === 504
                  ? "host_unreachable"
                  : "unexpected";
  const missingScope = code === "forbidden" ? missingScopeOf(res.json) : undefined;
  const retry = code === "rate_limited" ? retryAfterSeconds(res) : undefined;
  return new GitHostError(code, {
    status,
    ...(missingScope ? { missingScope } : {}),
    ...(retry === undefined ? {} : { retryAfterSeconds: retry }),
  });
}

export class GiteaAdapter implements GitHostAdapter {
  readonly provider: "gitea" | "forgejo";
  readonly #config: GiteaAdapterConfig;
  readonly #apiRoot: string;
  readonly #webRoot: string;
  #probe: Promise<GitHostProbe> | undefined;
  #login: Promise<string> | undefined;

  constructor(config: GiteaAdapterConfig) {
    let base: URL;
    try {
      base = new URL(config.baseUrl);
    } catch {
      throw new GitHostError("invalid_request");
    }
    if (base.search !== "" || base.hash !== "" || base.username !== "" || base.password !== "") {
      throw new GitHostError("invalid_request");
    }
    checkName(config.organization);
    this.provider = config.provider;
    this.#config = config;
    this.#webRoot = `${base.origin}${base.pathname.replace(/\/+$/, "")}`;
    this.#apiRoot = `${this.#webRoot}/api/v1`;
  }

  get #org(): string {
    return this.#config.organization;
  }

  async #call(path: string, init: GitHttpInit, query?: URLSearchParams): Promise<GitHttpResponse> {
    const url = new URL(`${this.#apiRoot}${path}`);
    if (query) url.search = query.toString();
    const res = await gitHostRequest(this.#config.net, url, {
      ...init,
      headers: { authorization: `token ${this.#config.token.reveal()}`, ...init.headers },
    });
    if (res.status < 200 || res.status >= 300) throw errorFor(res);
    return res;
  }

  /** A call after the version check. */
  async #api(path: string, init: GitHttpInit, query?: URLSearchParams): Promise<GitHttpResponse> {
    await this.#ensureSupported();
    return this.#call(path, init, query);
  }

  probe(): Promise<GitHostProbe> {
    this.#probe ??= this.#readVersion().catch((error: unknown) => {
      this.#probe = undefined;
      throw error;
    });
    return this.#probe;
  }

  async #readVersion(): Promise<GitHostProbe> {
    const res = await this.#call("/version", { method: "GET" });
    const judged = judgeVersion(asVersion(res.json));
    if (!judged) throw new GitHostError("unexpected", { status: res.status });
    return judged;
  }

  async #ensureSupported(): Promise<GitHostProbe> {
    const probe = await this.probe();
    if (!probe.supported) {
      throw new GitHostError("version_unsupported", {
        version: probe.version,
        minimumVersion: probe.minimumVersion,
      });
    }
    return probe;
  }

  #actorLogin(): Promise<string> {
    this.#login ??= this.#api("/user", { method: "GET" })
      .then((res) => asUser(res.json).login)
      .catch((error: unknown) => {
        this.#login = undefined;
        throw error;
      });
    return this.#login;
  }

  async testConnection(): Promise<GitConnectionTest> {
    const host = await this.#ensureSupported();
    const user = asUser((await this.#call("/user", { method: "GET" })).json);
    const organization = await this.getOrganization();
    const perms = asPermissions(
      (
        await this.#call(
          `/users/${encodeURIComponent(user.login)}/orgs/${encodeURIComponent(this.#org)}/permissions`,
          { method: "GET" },
        )
      ).json,
    );
    const extraPermissions = [
      ...(perms.isOwner ? ["organization owner (can delete repositories)"] : []),
      ...(perms.isAdmin || perms.isOwner ? ["organization administration"] : []),
      ...(user.isAdmin ? ["site administration"] : []),
    ];
    const notes =
      host.product === this.provider
        ? []
        : [`The host identifies as ${host.product}, not ${this.provider}.`];
    return {
      host,
      organization,
      actor: { login: user.login, siteAdministrator: user.isAdmin },
      abilities: {
        read: perms.canRead,
        write: perms.canWrite,
        createRepositories: perms.canCreateRepository,
        administer: perms.isOwner || perms.isAdmin,
      },
      extraPermissions,
      // Gitea and Forgejo access tokens carry no expiry the API reports.
      credentialExpiresAt: null,
      notes: host.newerThanTested
        ? [...notes, `Version ${host.version} is newer than the versions Kobe was tested with.`]
        : notes,
    };
  }

  async getOrganization(): Promise<GitOrganization> {
    const res = await this.#api(`/orgs/${encodeURIComponent(this.#org)}`, { method: "GET" });
    return asOrganization(res.json, this.#webRoot);
  }

  async listRepositories(page: GitPageRequest = {}): Promise<GitPage<GitRepository>> {
    const number = page.cursor === undefined ? 1 : Number(page.cursor);
    if (!Number.isInteger(number) || number < 1 || number > MAX_PAGE) {
      throw new GitHostError("invalid_request");
    }
    const wanted = Math.trunc(page.pageSize ?? GITEA_MAX_PAGE_SIZE);
    const limit = Math.min(Math.max(Number.isFinite(wanted) ? wanted : 1, 1), GITEA_MAX_PAGE_SIZE);
    const res = await this.#api(
      `/orgs/${encodeURIComponent(this.#org)}/repos`,
      { method: "GET" },
      new URLSearchParams({ page: String(number), limit: String(limit) }),
    );
    if (!Array.isArray(res.json)) throw new GitHostError("unexpected", { status: res.status });
    const items = res.json.map((r) => this.#repository(r));
    // Gitea sends both a `Link` header and `X-Total-Count`; either says whether more follow.
    const totalHeader = headerOf(res, "x-total-count");
    const total = totalHeader === undefined ? Number.NaN : Number(totalHeader);
    const more =
      hasNextLink(res) ||
      (Number.isFinite(total) ? number * limit < total : items.length === limit);
    return { items, nextCursor: more && items.length > 0 ? String(number + 1) : null };
  }

  #repository(json: unknown): GitRepository {
    const repo = asRepository(json);
    // Never report a repository of another owner (a transfer, a misbehaving host).
    if (repo.owner.toLowerCase() !== this.#org.toLowerCase()) throw new GitHostError("not_found");
    return repo.value;
  }

  #repoPath(name: string): string {
    return `/repos/${encodeURIComponent(this.#org)}/${encodeURIComponent(checkName(name))}`;
  }

  async getRepository(name: string): Promise<GitRepository> {
    const res = await this.#api(this.#repoPath(name), { method: "GET" });
    return this.#repository(res.json);
  }

  async createRepository(input: GitCreateRepository): Promise<GitRepository> {
    checkName(input.name);
    const res = await this.#api(`/orgs/${encodeURIComponent(this.#org)}/repos`, {
      method: "POST",
      body: {
        name: input.name,
        description: input.description ?? "",
        // Gitea and Forgejo have no internal visibility: always private (G10).
        private: true,
        auto_init: input.initialize === true,
        ...(input.initialize === true ? { readme: "Default" } : {}),
        ...(input.defaultBranch ? { default_branch: input.defaultBranch } : {}),
      },
    });
    return this.#repository(res.json);
  }

  async openPullRequest(input: GitPullRequestInput): Promise<GitPullRequest> {
    const res = await this.#api(`${this.#repoPath(input.repository)}/pulls`, {
      method: "POST",
      body: { title: input.title, body: input.body, head: input.head, base: input.base },
    });
    return asPullRequest(res.json);
  }

  async createIssue(input: GitIssueInput): Promise<GitIssue> {
    const res = await this.#api(`${this.#repoPath(input.repository)}/issues`, {
      method: "POST",
      body: { title: input.title, body: input.body },
    });
    return asIssue(res.json);
  }

  async comment(input: GitCommentInput): Promise<GitComment> {
    if (!Number.isInteger(input.number) || input.number < 1) {
      throw new GitHostError("invalid_request");
    }
    const res = await this.#api(
      `${this.#repoPath(input.repository)}/issues/${input.number}/comments`,
      { method: "POST", body: { body: input.body } },
    );
    return asComment(res.json);
  }

  /**
   * Gitea and Forgejo tokens cannot be narrowed to one repository or to read only, so this
   * returns the connection's token itself (`narrowed: false`): the egress proxy enforces the
   * organization path and read or write per service (G11, §9). Before returning it, the host
   * confirms the repository is in the organization and the token's account has that access.
   */
  async transportCredential(
    repository: string,
    access: GitAccess,
  ): Promise<GitTransportCredential> {
    const repo = await this.getRepository(repository);
    const allowed = access === "write" ? repo.permissions.write : repo.permissions.read;
    if (!allowed) throw new GitHostError("forbidden");
    const login = await this.#actorLogin();
    const basic = Buffer.from(`${login}:${this.#config.token.reveal()}`).toString("base64");
    return {
      repository: repo.fullName,
      access,
      authorization: new GitSecret(`Basic ${basic}`),
      narrowed: false,
      expiresAt: null,
    };
  }
}
