import type { GitCapability, GitProvider } from "@kobe/db";
import {
  assertBranch,
  assertNumber,
  assertRepositoryName,
  cursorPage,
  GitHostError,
  type GitAccess,
  type GitCommentInput,
  type GitCreated,
  type GitCreateIssueInput,
  type GitCreateRepositoryInput,
  type GitHostAdapter,
  type GitHostProbe,
  type GitOpenPullRequestInput,
  type GitOrganization,
  type GitPage,
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
import { giteaError } from "./errors.js";
import { judgeVersion, type VersionVerdict } from "./version.js";
import {
  asCreated,
  asOrganization,
  asPermissions,
  asRepository,
  asUser,
  asVersion,
  type GiteaRepository,
} from "./wire.js";

/**
 * One adapter for Gitea and Forgejo (spec workspace-git G7; KOBE-759): Forgejo is a fork of Gitea
 * and serves the same `/api/v1`. The credential is a bot account's access token (G6), sent as
 * `Authorization: token …`. The host's version is read once per adapter and anything older than
 * the supported minimum is refused (`unsupported_host`) before any other call.
 */
export interface GiteaAdapterOptions {
  /** What the admin chose; `probe()` reports the product the host identifies as. */
  readonly provider: Exclude<GitProvider, "github">;
  /**
   * The Site's decision for the base URL (`gitHostTarget()`, G3), e.g. `https://git.example.com`
   * or `https://example.com/gitea` (a sub-path install). The adapter cannot be built without one.
   */
  readonly target: GitHostTarget;
  readonly organization: string;
  /** The access token, unsealed by the caller; never stored or logged. */
  readonly token: string;
  readonly net: GitHostNet;
  readonly now?: () => number;
}

/** Gitea's default page cap (`[api] MAX_RESPONSE_ITEMS`); the host may lower it. */
export const GITEA_MAX_PAGE_SIZE = 50;

const ORG_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const sameLogin = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function createGiteaAdapter(options: GiteaAdapterOptions): GitHostAdapter {
  return new GiteaAdapter(options);
}

class GiteaAdapter implements GitHostAdapter {
  readonly provider: Exclude<GitProvider, "github">;
  readonly #o: GiteaAdapterOptions;
  readonly #apiRoot: string;
  readonly #webRoot: string;
  readonly #org: string;
  #version: Promise<VersionVerdict> | undefined;
  #login: Promise<string> | undefined;

  constructor(options: GiteaAdapterOptions) {
    assertGitHostTarget(options.target);
    let base: URL;
    try {
      base = new URL(options.target.baseUrl);
    } catch {
      throw new GitHostError("invalid_request", "The git host URL is not valid.");
    }
    if (base.search !== "" || base.hash !== "" || base.username !== "" || base.password !== "") {
      throw new GitHostError("invalid_request", "The git host URL is not valid.");
    }
    if (!ORG_NAME.test(options.organization) || /^\.+$/.test(options.organization)) {
      throw new GitHostError("invalid_request", "That is not a valid organization name.");
    }
    this.provider = options.provider;
    this.#o = options;
    this.#org = encodeURIComponent(options.organization);
    this.#webRoot = `${base.origin}${base.pathname.replace(/\/+$/, "")}`;
    this.#apiRoot = `${this.#webRoot}/api/v1`;
  }

  #now(): number {
    return (this.#o.now ?? Date.now)();
  }

  /** One API call; a non-2xx answer becomes a {@link GitHostError}. */
  async #call(path: string, init: Omit<HostRequestInit, "headers">): Promise<HostResponse> {
    const res = await hostRequest(
      this.#o.net,
      this.#o.target,
      this.#apiRoot,
      `${this.#apiRoot}${path}`,
      {
        ...init,
        headers: { authorization: `token ${this.#o.token}` },
      },
    );
    if (res.status < 200 || res.status >= 300) throw giteaError(res, this.#now());
    return res;
  }

  /** A call after the version check. */
  async #api(path: string, init: Omit<HostRequestInit, "headers">): Promise<HostResponse> {
    await this.#supported();
    return this.#call(path, init);
  }

  #readVersion(): Promise<VersionVerdict> {
    this.#version ??= this.#call("/version", { method: "GET" })
      .then((res) => {
        const verdict = judgeVersion(asVersion(res.json));
        if (!verdict) {
          throw new GitHostError(
            "unsupported_host",
            "The git host reports no version Kobe can read.",
            {
              reason: "version_unreadable",
            },
          );
        }
        return verdict;
      })
      .catch((error: unknown) => {
        this.#version = undefined;
        throw error;
      });
    return this.#version;
  }

  async #supported(): Promise<VersionVerdict> {
    const v = await this.#readVersion();
    if (!v.supported) {
      const name = v.product === "forgejo" ? "Forgejo" : "Gitea";
      throw new GitHostError(
        "unsupported_host",
        `The git host runs ${name} ${v.version}; Kobe supports ${name} ${v.minimumVersion} and later.`,
        { reason: "version_too_old" },
      );
    }
    return v;
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

  async probe(): Promise<GitHostProbe> {
    const version = await this.#supported();
    const user = asUser((await this.#call("/user", { method: "GET" })).json);
    const organization = await this.describeOrganization();
    const perms = asPermissions(
      (
        await this.#call(`/users/${encodeURIComponent(user.login)}/orgs/${this.#org}/permissions`, {
          method: "GET",
        })
      ).json,
    );
    const yesNo = (b: boolean): GitCapability => (b ? "yes" : "no");
    return {
      // The product the host identifies as, so labels are right even if the admin picked the other.
      provider: version.product,
      organization,
      hostVersion: version.version,
      actor: { kind: "token", login: user.login },
      capabilities: {
        create: yesNo(perms.canCreateRepository),
        read: yesNo(perms.canRead),
        write: yesNo(perms.canWrite),
        admin: yesNo(perms.isOwner || perms.isAdmin),
      },
      excess: [
        ...(perms.isOwner ? ["organization owner (can delete repositories)"] : []),
        ...(perms.isOwner || perms.isAdmin ? ["organization administration"] : []),
        ...(user.isAdmin ? ["site administration"] : []),
      ],
      // Gitea and Forgejo report no expiry for access tokens, and no rate-limit headers.
      credentialExpiresAt: null,
      rateLimit: null,
    };
  }

  async describeOrganization(): Promise<GitOrganization> {
    const res = await this.#api(`/orgs/${this.#org}`, { method: "GET" });
    return asOrganization(res.json, this.#webRoot);
  }

  async listRepositories(
    opts: { readonly cursor?: string | null; readonly perPage?: number } = {},
  ): Promise<GitPage<GitRepository>> {
    const page = cursorPage(opts.cursor);
    const wanted = Math.floor(opts.perPage ?? GITEA_MAX_PAGE_SIZE);
    const limit = Math.min(Math.max(Number.isFinite(wanted) ? wanted : 1, 1), GITEA_MAX_PAGE_SIZE);
    const res = await this.#api(`/orgs/${this.#org}/repos?page=${page}&limit=${limit}`, {
      method: "GET",
    });
    if (!Array.isArray(res.json)) {
      throw new GitHostError("unexpected", "The git host returned no list.");
    }
    const items = (res.json as unknown[])
      .map((r) => asRepository(r, this.#webRoot, this.#o.organization))
      .filter((r) => sameLogin(r.owner, this.#o.organization))
      .map((r) => r.value);
    // Gitea sends a `Link` header and `X-Total-Count`; either says whether more follow.
    const link = header(res, "link");
    const totalHeader = header(res, "x-total-count");
    const total = totalHeader === undefined ? Number.NaN : Number(totalHeader);
    const more =
      (link !== undefined && /;\s*rel="?next"?/i.test(link)) ||
      (Number.isFinite(total) ? page * limit < total : items.length === limit);
    return { items, next: more && res.json.length > 0 ? String(page + 1) : null };
  }

  /** A repository answer confined to the organization: another owner's is "not found". */
  #confined(json: unknown): GiteaRepository {
    const repo = asRepository(json, this.#webRoot, this.#o.organization);
    if (!sameLogin(repo.owner, this.#o.organization)) {
      throw new GitHostError("not_found", "Not found in the connected organization.");
    }
    return repo;
  }

  #repoPath(name: string): string {
    return `/repos/${this.#org}/${encodeURIComponent(assertRepositoryName(name))}`;
  }

  async #repository(ref: GitRepositoryRef): Promise<GiteaRepository> {
    if ("name" in ref) {
      const path = this.#repoPath(ref.name);
      return this.#confined((await this.#api(path, { method: "GET" })).json);
    }
    if (!/^\d{1,20}$/.test(ref.id)) {
      throw new GitHostError("invalid_request", "That is not a valid repository id.");
    }
    return this.#confined((await this.#api(`/repositories/${ref.id}`, { method: "GET" })).json);
  }

  async getRepository(ref: GitRepositoryRef): Promise<GitRepository> {
    return (await this.#repository(ref)).value;
  }

  async createRepository(input: GitCreateRepositoryInput): Promise<GitRepository> {
    const name = assertRepositoryName(input.name);
    // Neither product has internal repositories; public is never created (G10).
    if ((input.visibility as string) !== "private") {
      throw new GitHostError("invalid_request", "This git host gets private repositories only.");
    }
    const res = await this.#api(`/orgs/${this.#org}/repos`, {
      method: "POST",
      body: {
        name,
        private: true,
        ...(input.description === undefined ? {} : { description: input.description }),
      },
    });
    return this.#confined(res.json).value;
  }

  /**
   * Gitea and Forgejo tokens cannot be narrowed to one repository or to read only, so this hands
   * out the connection's token itself (`narrowed: false`): the egress proxy enforces the
   * organization path and read or write per service (G11, §9). First the host confirms the
   * repository is in the organization and the token's account has that access there.
   */
  async repositoryCredential(
    repository: string,
    access: GitAccess,
  ): Promise<GitRepositoryCredential> {
    const name = assertRepositoryName(repository);
    if (access !== "read" && access !== "write") {
      throw new GitHostError("invalid_request", "Access must be read or write.");
    }
    const repo = await this.#repository({ name });
    if (!(access === "write" ? repo.canWrite : repo.canRead)) {
      throw new GitHostError("forbidden", `The credential may not ${access} that repository.`);
    }
    return {
      username: await this.#actorLogin(),
      password: this.#o.token,
      expiresAt: null,
      access,
      narrowed: false,
    };
  }

  async openPullRequest(input: GitOpenPullRequestInput): Promise<GitCreated> {
    const path = `${this.#repoPath(input.repository)}/pulls`;
    const body = {
      title: input.title,
      body: input.body,
      head: assertBranch(input.head),
      base: assertBranch(input.base),
    };
    // Gitea/Forgejo mark drafts by a `WIP:` title prefix rather than a field.
    const title = input.draft === true ? `WIP: ${input.title}` : input.title;
    const res = await this.#api(path, { method: "POST", body: { ...body, title } });
    return asCreated(res.json, true, this.#webRoot);
  }

  async comment(input: GitCommentInput): Promise<GitCreated> {
    // Pull requests are issues on Gitea/Forgejo: one comments endpoint for both.
    const path = `${this.#repoPath(input.repository)}/issues/${assertNumber(input.number)}/comments`;
    const res = await this.#api(path, { method: "POST", body: { body: input.body } });
    return asCreated(res.json, false, this.#webRoot);
  }

  async createIssue(input: GitCreateIssueInput): Promise<GitCreated> {
    const res = await this.#api(`${this.#repoPath(input.repository)}/issues`, {
      method: "POST",
      body: { title: input.title, body: input.body },
    });
    return asCreated(res.json, true, this.#webRoot);
  }
}
