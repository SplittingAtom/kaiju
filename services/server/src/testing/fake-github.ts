import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  FAKE_GIT_HOST,
  type ContractFailure,
  type FakeTreeEntry,
  type GitHostContractFake,
} from "./git-host-contract.js";

/**
 * A fake GitHub REST API (tests only, KOBE-758), served as an Enterprise Server under `/api/v3`.
 * It checks App JWTs (RS256 against the App's public key), issues installation tokens that carry
 * their repositories and permissions and enforces both, and records what it was sent. No real
 * token, key or host name appears here.
 */

export const FAKE_APP_ID = "1001";
export const FAKE_INST_ID = "2002";
export const FAKE_PAT = "test-pat-not-a-real-token";

interface Repo {
  id: number;
  name: string;
  owner: string;
  visibility: "private" | "internal" | "public";
  default_branch: string;
  size: number;
  description: string | null;
}

interface IssuedToken {
  token: string;
  repositories: string[] | null;
  permissions: Record<string, string>;
  expiresAt: number;
  revoked: boolean;
}

export interface FakeGithubOptions {
  installationPermissions?: Record<string, string>;
  installationAccount?: string;
  installationRemoved?: boolean;
  installationSuspended?: boolean;
  /** Seconds an installation token lives (default 3600). */
  tokenLifetimeS?: number;
  /** `github-authentication-token-expiration` on PAT answers. */
  patExpiration?: string;
  /** `x-oauth-scopes` on PAT answers (a classic token). */
  classicScopes?: string;
  enterpriseVersion?: string;
  /** The PAT is answered with 401 (expired or revoked). */
  patRejected?: boolean;
  /** Old name → current repository name: GET on the old name answers 301 to /repositories/:id. */
  renamed?: Record<string, string>;
  /** The organization is a user account (`/orgs/:o` 404, `/users/:o` 200; `/user/repos`). */
  userNamespace?: boolean;
  /** The PAT's own login (`/user`); default `kobe-bot-test`. */
  patLogin?: string;
  /** The token account's `permissions` on repositories (default pull and push). */
  repoPermissions?: { pull: boolean; push: boolean };
  /** Hostile answers: `html_url` / `clone_url` set to these instead of the fake's own URLs. */
  hostileHtmlUrl?: string;
  /** A created repository is answered with this owner (an odd answer after a 201; KOBE-762). */
  createdOwner?: string;
  hostileCloneUrl?: string;
}

export class FakeGithub implements GitHostContractFake {
  private server!: Server;
  base = "";
  readonly organization = "acme-test";
  readonly hits: { method: string; path: string; authorization: string | undefined }[] = [];
  readonly mintRequests: { repositories?: string[]; permissions: Record<string, string> }[] = [];
  readonly createdRepositories: { name: string; private: unknown; visibility: unknown }[] = [];
  readonly pullRequests: {
    repository: string;
    title: string;
    head: string;
    base: string;
    body: string;
    number: number;
  }[] = [];
  readonly issues: { repository: string; title: string; body: string; number: number }[] = [];
  /** Branches per repository id (name → commit SHA); `main` exists from the start. */
  readonly branches = new Map<number, Map<string, string>>();
  /** Files per repository id (path → text). */
  readonly files = new Map<number, Map<string, string>>();
  readonly comments: { repository: string; number: number; body: string }[] = [];
  readonly tokens: IssuedToken[] = [];
  options: FakeGithubOptions = {};
  private failure: ContractFailure | null = null;
  /** Apply `fail()` to POST requests only (a write fails, its reads before it pass; KOBE-762). */
  failPostsOnly = false;
  private repos = new Map<number, Repo>();
  private nextId = 5000;
  private publicKey: KeyObject | null = null;
  private serial = 0;

  constructor(publicKeyPem?: string) {
    if (publicKeyPem) this.publicKey = createPublicKey(publicKeyPem);
  }

  get port(): number {
    return Number(new URL(this.base).port);
  }
  get baseUrl(): string {
    return this.base;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.base = `http://${FAKE_GIT_HOST}:${(this.server.address() as AddressInfo).port}`;
  }
  close(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((r) => this.server.close(() => r()));
  }

  reset(): void {
    this.hits.length = 0;
    this.mintRequests.length = 0;
    this.createdRepositories.length = 0;
    this.pullRequests.length = 0;
    this.issues.length = 0;
    this.comments.length = 0;
    this.tokens.length = 0;
    this.repos.clear();
    this.branches.clear();
    this.files.clear();
    this.trees.clear();
    this.truncatedTrees.clear();
    this.failure = null;
    this.failPostsOnly = false;
    this.options = {};
  }

  fail(failure: ContractFailure | null): void {
    this.failure = failure;
  }

  seedRepositories(names: readonly string[]): void {
    for (const name of names) this.addRepo(this.organization, name);
  }

  seedForeignRepository(owner: string, name: string): string {
    return String(this.addRepo(owner, name).id);
  }

  /** Repository id → tree SHA → one level of entries (KOBE-767 `readTree`). */
  readonly trees = new Map<number, Map<string, readonly FakeTreeEntry[]>>();
  /** Tree SHAs GitHub answers as `truncated` (too large to list). */
  readonly truncatedTrees = new Set<string>();

  seedTree(name: string, sha: string, entries: readonly FakeTreeEntry[]): void {
    const repo = this.findRepo(this.organization, name);
    if (!repo) return;
    const trees = this.trees.get(repo.id) ?? new Map<string, readonly FakeTreeEntry[]>();
    trees.set(sha, entries);
    this.trees.set(repo.id, trees);
  }

  apiHits(): readonly { method: string; path: string }[] {
    return this.hits.filter((h) => !h.path.includes("/app/installations/"));
  }

  /** Revokes every installation token issued so far (the host forgets them early). */
  revokeTokens(): void {
    for (const t of this.tokens) t.revoked = true;
  }

  private addRepo(owner: string, name: string): Repo {
    const repo: Repo = {
      id: this.nextId++,
      name,
      owner,
      visibility: "private",
      default_branch: "main",
      size: 10,
      description: null,
    };
    this.repos.set(repo.id, repo);
    this.branches.set(repo.id, new Map([["main", "a".repeat(40)]]));
    this.files.set(repo.id, new Map([["README.md", "# Hello\n"]]));
    return repo;
  }

  /** Adds a file to a repository of the organization (tests). */
  seedFile(name: string, path: string, text: string): void {
    const repo = this.findRepo(this.organization, name);
    if (repo) this.files.get(repo.id)?.set(path, text);
  }

  private prJson(owner: string, name: string, p: (typeof this.pullRequests)[number]) {
    return {
      id: 70000 + p.number,
      number: p.number,
      title: p.title,
      body: p.body,
      state: "open",
      draft: false,
      head: { ref: p.head, repo: { owner: { login: owner } } },
      base: { ref: p.base },
      user: { login: "kobe-bot-test" },
      html_url: `${this.base}/${owner}/${name}/pull/${p.number}`,
      created_at: "2026-11-01T00:00:00Z",
      updated_at: "2026-11-01T00:00:00Z",
      merged_at: null,
    };
  }

  private issueJson(owner: string, name: string, i: (typeof this.issues)[number]) {
    return {
      id: 80000 + i.number,
      number: i.number,
      title: i.title,
      body: i.body,
      state: "open",
      user: { login: "kobe-bot-test" },
      comments: this.comments.filter((c) => c.repository === name && c.number === i.number).length,
      html_url: `${this.base}/${owner}/${name}/issues/${i.number}`,
      created_at: "2026-11-01T00:00:00Z",
      updated_at: "2026-11-01T00:00:00Z",
    };
  }

  private repoJson(r: Repo) {
    const full = `${r.owner}/${r.name}`;
    return {
      id: r.id,
      name: r.name,
      full_name: full,
      owner: { login: r.owner },
      private: r.visibility !== "public",
      visibility: r.visibility,
      default_branch: r.default_branch,
      archived: false,
      size: r.size,
      description: r.description,
      html_url: this.options.hostileHtmlUrl ?? `${this.base}/${full}`,
      clone_url: this.options.hostileCloneUrl ?? `${this.base}/${full}.git`,
      permissions: {
        admin: false,
        pull: this.options.repoPermissions?.pull ?? true,
        push: this.options.repoPermissions?.push ?? true,
      },
    };
  }

  private send(
    res: ServerResponse,
    status: number,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    res.writeHead(status, {
      "content-type": "application/json",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "4999",
      "x-ratelimit-reset": "1900000000",
      ...(this.options.enterpriseVersion
        ? { "x-github-enterprise-version": this.options.enterpriseVersion }
        : {}),
      ...headers,
    });
    res.end(body === undefined ? "" : JSON.stringify(body));
  }

  private async body(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    return text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
  }

  private verifyJwt(auth: string | undefined): boolean {
    const jwt = auth?.replace(/^Bearer /, "") ?? "";
    const [h, p, s] = jwt.split(".");
    if (!h || !p || !s || !this.publicKey) return false;
    const header = JSON.parse(Buffer.from(h, "base64url").toString()) as { alg?: string };
    const payload = JSON.parse(Buffer.from(p, "base64url").toString()) as {
      iss?: string;
      iat?: number;
      exp?: number;
    };
    if (header.alg !== "RS256" || payload.iss !== FAKE_APP_ID) return false;
    if (!payload.iat || !payload.exp || payload.exp - payload.iat > 600) return false;
    return verify("sha256", Buffer.from(`${h}.${p}`), this.publicKey, Buffer.from(s, "base64url"));
  }

  /** The caller: the PAT, a live installation token, or null. */
  private caller(auth: string | undefined): "pat" | IssuedToken | null {
    const t = auth?.replace(/^Bearer /, "");
    if (t === FAKE_PAT) return this.options.patRejected ? null : "pat";
    const issued = this.tokens.find((x) => x.token === t);
    if (!issued || issued.revoked || issued.expiresAt <= Date.now()) return null;
    return issued;
  }

  private failNow(res: ServerResponse): boolean {
    switch (this.failure) {
      case null:
        return false;
      case "auth":
        this.send(res, 401, { message: "Bad credentials" });
        return true;
      case "forbidden":
        this.send(
          res,
          403,
          { message: "Resource not accessible by integration" },
          { "x-accepted-github-permissions": "contents=write" },
        );
        return true;
      case "rate_limited":
        this.send(
          res,
          403,
          { message: "API rate limit exceeded" },
          { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1900000123" },
        );
        return true;
      case "secondary_rate_limited":
        this.send(
          res,
          403,
          { message: "You have exceeded a secondary rate limit." },
          { "retry-after": "30" },
        );
        return true;
      case "server_error":
        this.send(res, 502, { message: "Server Error" });
        return true;
      case "redirect_foreign":
        this.send(res, 302, undefined, { location: "http://127.0.0.2:1/elsewhere" });
        return true;
    }
  }

  private needs(
    res: ServerResponse,
    who: "pat" | IssuedToken,
    repo: string | null,
    permission: string,
    level: "read" | "write",
  ): boolean {
    if (who === "pat") return true;
    if (repo !== null && who.repositories && !who.repositories.includes(repo)) {
      this.send(res, 404, { message: "Not Found" });
      return false;
    }
    const granted = who.permissions[permission];
    if (granted === "write" || (level === "read" && granted === "read")) return true;
    this.send(
      res,
      403,
      { message: "Resource not accessible by integration" },
      { "x-accepted-github-permissions": `${permission}=${level}` },
    );
    return false;
  }

  private findRepo(owner: string, name: string): Repo | undefined {
    return [...this.repos.values()].find(
      (r) => r.owner.toLowerCase() === owner.toLowerCase() && r.name === name,
    );
  }

  /** Branches, contents, pull requests and issues of one repository (KOBE-762 reads). */
  private async readRoute(
    res: ServerResponse,
    who: "pat" | IssuedToken,
    repo: Repo,
    owner: string,
    name: string,
    rest: string,
    method: string,
    url: URL,
    req: IncomingMessage,
    reply: (status: number, body?: unknown, extra?: Record<string, string>) => void,
  ): Promise<void> {
    const branches = this.branches.get(repo.id) ?? new Map<string, string>();
    const page = Number(url.searchParams.get("page") ?? "1");
    const perPage = Number(url.searchParams.get("per_page") ?? "30");
    const paged = <T>(all: T[], map: (t: T) => unknown) => {
      const more = page * perPage < all.length;
      const link = more
        ? {
            link: `<${this.base}/api/v3/repos/${owner}/${name}${rest}?per_page=${perPage}&page=${page + 1}>; rel="next"`,
          }
        : {};
      reply(200, all.slice((page - 1) * perPage, page * perPage).map(map), link);
    };
    if (rest === "/branches" && method === "GET") {
      if (!this.needs(res, who, name, "contents", "read")) return;
      return paged([...branches.entries()], ([b, sha]) => ({
        name: b,
        commit: { sha },
        protected: b === "main",
      }));
    }
    const tree = /^\/git\/trees\/([0-9a-f]{40,64})$/.exec(rest);
    if (tree && method === "GET") {
      if (!this.needs(res, who, name, "contents", "read")) return;
      const sha = tree[1] ?? "";
      const entries = this.trees.get(repo.id)?.get(sha);
      if (entries === undefined) return reply(404, { message: "Not Found" });
      return reply(200, {
        sha,
        url: "",
        tree: entries.map((e) => ({ ...e, url: "" })),
        truncated: this.truncatedTrees.has(sha),
      });
    }
    const ref = /^\/git\/ref\/heads\/(.+)$/.exec(rest);
    if (ref && method === "GET") {
      if (!this.needs(res, who, name, "contents", "read")) return;
      const sha = branches.get(decodeURIComponent(ref[1] ?? ""));
      if (sha === undefined) return reply(404, { message: "Not Found" });
      return reply(200, { ref: `refs/heads/${ref[1]}`, object: { sha, type: "commit" } });
    }
    if (rest === "/git/refs" && method === "POST") {
      if (!this.needs(res, who, name, "contents", "write")) return;
      const b = await this.body(req);
      const branch = String(b.ref).replace(/^refs\/heads\//, "");
      if (branches.has(branch)) return reply(422, { message: "Reference already exists" });
      if (![...branches.values()].includes(String(b.sha))) {
        return reply(422, { message: "Object does not exist" });
      }
      branches.set(branch, String(b.sha));
      return reply(201, { ref: b.ref, object: { sha: b.sha, type: "commit" } });
    }
    const contents = /^\/contents(?:\/(.*))?$/.exec(rest);
    if (contents && method === "GET") {
      if (!this.needs(res, who, name, "contents", "read")) return;
      const files = this.files.get(repo.id) ?? new Map<string, string>();
      const path = decodeURIComponent(contents[1] ?? "");
      const text = files.get(path);
      if (text !== undefined) {
        return reply(200, {
          type: "file",
          path,
          name: path.split("/").pop(),
          size: Buffer.byteLength(text),
          sha: "b".repeat(40),
          encoding: "base64",
          content: Buffer.from(text, "utf8").toString("base64"),
        });
      }
      const prefix = path === "" ? "" : `${path}/`;
      const under = [...files.keys()].filter((f) => f.startsWith(prefix));
      if (under.length === 0) return reply(404, { message: "Not Found" });
      const names = [...new Set(under.map((f) => f.slice(prefix.length).split("/")[0] ?? ""))];
      return reply(
        200,
        names.map((n) => ({
          name: n,
          path: `${prefix}${n}`,
          type: files.has(`${prefix}${n}`) ? "file" : "dir",
          size: files.get(`${prefix}${n}`)?.length ?? 0,
        })),
      );
    }
    if (rest === "/pulls" && method === "GET") {
      if (!this.needs(res, who, name, "pull_requests", "read")) return;
      return paged(
        this.pullRequests.filter((p) => p.repository === name),
        (p) => this.prJson(owner, name, p),
      );
    }
    const pr = /^\/pulls\/(\d+)$/.exec(rest);
    if (pr && method === "GET") {
      if (!this.needs(res, who, name, "pull_requests", "read")) return;
      const p = this.pullRequests.find((x) => x.repository === name && x.number === Number(pr[1]));
      return p ? reply(200, this.prJson(owner, name, p)) : reply(404, { message: "Not Found" });
    }
    if (rest === "/issues" && method === "GET") {
      if (!this.needs(res, who, name, "issues", "read")) return;
      // As GitHub: pull requests are listed among issues, marked with `pull_request`.
      const all = [
        ...this.issues
          .filter((i) => i.repository === name)
          .map((i) => this.issueJson(owner, name, i)),
        ...this.pullRequests
          .filter((p) => p.repository === name)
          .map((p) => ({ ...this.prJson(owner, name, p), pull_request: {} })),
      ];
      return paged(all, (x) => x);
    }
    const issue = /^\/issues\/(\d+)$/.exec(rest);
    if (issue && method === "GET") {
      if (!this.needs(res, who, name, "issues", "read")) return;
      const n = Number(issue[1]);
      const i = this.issues.find((x) => x.repository === name && x.number === n);
      if (i) return reply(200, this.issueJson(owner, name, i));
      const p = this.pullRequests.find((x) => x.repository === name && x.number === n);
      if (p) return reply(200, { ...this.prJson(owner, name, p), pull_request: {} });
      return reply(404, { message: "Not Found" });
    }
    return reply(404, { message: "Not Found" });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.base);
    const auth = req.headers.authorization;
    this.hits.push({ method: req.method ?? "", path: url.pathname, authorization: auth });
    if (!url.pathname.startsWith("/api/v3/")) return this.send(res, 404, { message: "Not Found" });
    const path = url.pathname.slice("/api/v3".length);
    const method = req.method ?? "GET";
    const o = this.options;

    const inst = /^\/app\/installations\/(\d+)(\/access_tokens)?$/.exec(path);
    if (inst) {
      if (!this.verifyJwt(auth))
        return this.send(res, 401, { message: "A JSON web token could not be decoded" });
      if (inst[1] !== FAKE_INST_ID || o.installationRemoved) {
        return this.send(res, 404, { message: "Not Found" });
      }
      if (o.installationSuspended && inst[2]) {
        return this.send(res, 403, { message: "This installation has been suspended" });
      }
      const permissions = o.installationPermissions ?? {
        metadata: "read",
        contents: "write",
        pull_requests: "write",
        issues: "write",
        administration: "write",
      };
      if (!inst[2] && method === "GET") {
        return this.send(res, 200, {
          id: Number(FAKE_INST_ID),
          app_slug: "kobe-test-app",
          account: { login: o.installationAccount ?? this.organization, type: "Organization" },
          permissions,
          suspended_at: o.installationSuspended ? "2026-01-01T00:00:00Z" : null,
        });
      }
      const body = (await this.body(req)) as {
        repositories?: string[];
        permissions: Record<string, string>;
      };
      this.mintRequests.push(body);
      for (const [k, v] of Object.entries(body.permissions ?? {})) {
        const g = permissions[k];
        if (!(g === "write" || (g === "read" && v === "read"))) {
          return this.send(res, 422, {
            message: "The permissions requested are not granted to this installation.",
          });
        }
      }
      for (const r of body.repositories ?? []) {
        if (!this.findRepo(this.organization, r)) {
          return this.send(res, 422, {
            message:
              "There is at least one repository that does not exist or is not accessible to the parent installation.",
          });
        }
      }
      const token: IssuedToken = {
        token: `test-installation-token-${++this.serial}`,
        repositories: body.repositories ?? null,
        permissions: body.permissions,
        expiresAt: Date.now() + (o.tokenLifetimeS ?? 3600) * 1000,
        revoked: false,
      };
      this.tokens.push(token);
      return this.send(res, 201, {
        token: token.token,
        expires_at: new Date(token.expiresAt).toISOString(),
      });
    }

    if ((!this.failPostsOnly || method === "POST") && this.failNow(res)) return;
    const who = this.caller(auth);
    if (who === null) return this.send(res, 401, { message: "Bad credentials" });
    const patHeaders: Record<string, string> =
      who === "pat"
        ? {
            ...(o.patExpiration
              ? { "github-authentication-token-expiration": o.patExpiration }
              : {}),
            ...(o.classicScopes !== undefined ? { "x-oauth-scopes": o.classicScopes } : {}),
          }
        : {};
    const reply = (status: number, body?: unknown, extra: Record<string, string> = {}) =>
      this.send(res, status, body, { ...patHeaders, ...extra });

    if (path === "/user" && method === "GET") {
      if (who !== "pat") return reply(403, { message: "Resource not accessible by integration" });
      return reply(200, { login: o.patLogin ?? "kobe-bot-test", id: 77 });
    }
    const orgM = /^\/(orgs|users)\/([^/]+)$/.exec(path);
    if (orgM && method === "GET") {
      if (orgM[2]?.toLowerCase() !== this.organization.toLowerCase())
        return reply(404, { message: "Not Found" });
      if ((orgM[1] === "users") !== (o.userNamespace === true))
        return reply(404, { message: "Not Found" });
      return reply(200, {
        id: 900,
        login: this.organization,
        name: "Acme Test",
        html_url: `${this.base}/${this.organization}`,
      });
    }
    // A user namespace: the PAT's own repositories (GitHub creates in the token owner's account).
    if (path === "/user/repos" && who === "pat") {
      const login = o.patLogin ?? "kobe-bot-test";
      if (method === "POST") {
        const body = await this.body(req);
        const name = String(body.name);
        this.createdRepositories.push({ name, private: body.private, visibility: body.visibility });
        const repo = this.addRepo(login, name);
        repo.size = 0;
        repo.description = typeof body.description === "string" ? body.description : null;
        return reply(201, this.repoJson(repo));
      }
      const mine = [...this.repos.values()].filter((r) => r.owner === login);
      return reply(
        200,
        mine.map((r) => this.repoJson(r)),
      );
    }
    const listOrg = /^\/orgs\/([^/]+)\/repos$/.exec(path);
    if ((listOrg && method === "GET") || path === "/installation/repositories") {
      if (
        who !== "pat" &&
        path !== "/installation/repositories" &&
        !this.needs(res, who, null, "metadata", "read")
      )
        return;
      const perPage = Number(url.searchParams.get("per_page") ?? "30");
      const page = Number(url.searchParams.get("page") ?? "1");
      const all = [...this.repos.values()].filter((r) => r.owner === this.organization);
      const slice = all.slice((page - 1) * perPage, page * perPage);
      const more = page * perPage < all.length;
      const link = more
        ? { link: `<${this.base}/api/v3${path}?per_page=${perPage}&page=${page + 1}>; rel="next"` }
        : {};
      const items = slice.map((r) => this.repoJson(r));
      return reply(
        200,
        path === "/installation/repositories"
          ? { total_count: all.length, repositories: items }
          : items,
        link,
      );
    }
    if (listOrg && method === "POST") {
      if (!this.needs(res, who, null, "administration", "write")) return;
      const body = await this.body(req);
      const name = String(body.name);
      if (this.findRepo(this.organization, name)) {
        return reply(422, {
          message: "Repository creation failed.",
          errors: [
            {
              resource: "Repository",
              code: "custom",
              field: "name",
              message: "name already exists on this account",
            },
          ],
        });
      }
      this.createdRepositories.push({ name, private: body.private, visibility: body.visibility });
      const repo = this.addRepo(this.organization, name);
      repo.size = 0;
      repo.description = typeof body.description === "string" ? body.description : null;
      if (body.visibility === "internal") repo.visibility = "internal";
      const json = this.repoJson(repo);
      return reply(201, o.createdOwner ? { ...json, owner: { login: o.createdOwner } } : json);
    }
    const byId = /^\/repositories\/(\d+)$/.exec(path);
    if (byId && method === "GET") {
      const repo = this.repos.get(Number(byId[1]));
      if (!repo) return reply(404, { message: "Not Found" });
      if (who !== "pat" && repo.owner !== this.organization)
        return reply(404, { message: "Not Found" });
      return reply(200, this.repoJson(repo));
    }
    const repoM = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
    if (repoM) {
      const [, owner = "", name = "", rest = ""] = repoM;
      const moved = o.renamed?.[name];
      if (moved && rest === "" && method === "GET") {
        const target = this.findRepo(owner, moved);
        if (target)
          return reply(
            301,
            { message: "Moved Permanently" },
            { location: `${this.base}/api/v3/repositories/${target.id}` },
          );
      }
      const repo = this.findRepo(owner, name);
      if (!repo) return reply(404, { message: "Not Found" });
      if (rest === "" && method === "GET") {
        if (!this.needs(res, who, name, "metadata", "read")) return;
        return reply(200, this.repoJson(repo));
      }
      if (rest === "/pulls" && method === "POST") {
        if (!this.needs(res, who, name, "pull_requests", "write")) return;
        const b = await this.body(req);
        if (this.pullRequests.some((p) => p.repository === name && p.head === b.head)) {
          return reply(422, {
            message: "Validation Failed",
            errors: [{ message: "A pull request already exists for acme-test:feature." }],
          });
        }
        const number = this.pullRequests.length + 1;
        this.pullRequests.push({
          repository: name,
          title: String(b.title),
          head: String(b.head),
          base: String(b.base),
          body: String(b.body ?? ""),
          number,
        });
        return reply(201, {
          id: 70000 + number,
          number,
          html_url: `${this.base}/${owner}/${name}/pull/${number}`,
        });
      }
      if (rest === "/issues" && method === "POST") {
        if (!this.needs(res, who, name, "issues", "write")) return;
        const b = await this.body(req);
        const number = 100 + this.issues.length + 1;
        this.issues.push({
          repository: name,
          title: String(b.title),
          body: String(b.body ?? ""),
          number,
        });
        return reply(201, {
          id: 80000 + number,
          number,
          html_url: `${this.base}/${owner}/${name}/issues/${number}`,
        });
      }
      const comment = /^\/issues\/(\d+)\/comments$/.exec(rest);
      if (comment && method === "POST") {
        const permission =
          who !== "pat" && who.permissions.pull_requests === "write" ? "pull_requests" : "issues";
        if (!this.needs(res, who, name, permission, "write")) return;
        const b = await this.body(req);
        this.comments.push({ repository: name, number: Number(comment[1]), body: String(b.body) });
        const id = 90000 + this.comments.length;
        return reply(201, {
          id,
          html_url: `${this.base}/${owner}/${name}/issues/${comment[1]}#issuecomment-${id}`,
        });
      }
      return this.readRoute(res, who, repo, owner, name, rest, method, url, req, reply);
    }
    return reply(404, { message: "Not Found" });
  }
}
