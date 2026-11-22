import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { GitHostFake, GitHostFailure } from "./git-provider-contract.js";

/**
 * A fake Gitea / Forgejo `/api/v1` (tests only, KOBE-759): one organization, a bot account, an
 * access token with Gitea's scope names, in-memory repositories, pull requests, issues and
 * comments. Scope refusals use Gitea's message formats (the older `…scope(s): [x]` for Gitea, the
 * newer `…scope(s), required=[x], token scope=…` for Forgejo) so both parsers are exercised.
 * Nothing here is a real host, account or token.
 */

export type FakeProduct = "gitea" | "forgejo";

interface Repo {
  id: number;
  name: string;
  private: boolean;
  empty: boolean;
  defaultBranch: string;
  owner: string;
  issues: number;
}

const ALL_SCOPES = [
  "read:user",
  "read:organization",
  "write:organization",
  "read:repository",
  "write:repository",
  "read:issue",
  "write:issue",
];

export const FAKE_VERSIONS: Record<FakeProduct, { current: string; tooOld: string }> = {
  gitea: { current: "1.27.2", tooOld: "1.25.4" },
  forgejo: { current: "17.0.1+gitea-1.22.0", tooOld: "15.0.3+gitea-1.22.0" },
};

export class FakeGitea implements GitHostFake {
  private server!: Server;
  port = 0;
  readonly organization = "acme";
  readonly login = "kobe-bot";
  /** A made-up token; never a real credential. */
  readonly secret = "fake-gitea-token-0123456789abcdef";
  version: string;
  scopes = new Set(ALL_SCOPES);
  tokenValid = true;
  canWrite = true;
  isOrgOwner = false;
  siteAdmin = false;
  /** Leave the `Link` header out of list answers (X-Total-Count only). */
  omitLink = false;
  /** Answer the organization's repository list with a repository of another owner. */
  foreignRepo = false;
  delayMs = 0;
  private repos = new Map<string, Repo>();
  private nextId = 100;
  private failures: GitHostFailure[] = [];
  private log: { method: string; path: string; authorization: string | undefined }[] = [];

  constructor(readonly product: FakeProduct) {
    this.version = FAKE_VERSIONS[product].current;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    return new Promise((resolve) => {
      this.server.listen(0, "127.0.0.1", () => {
        this.port = (this.server.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  close(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  reset(): void {
    this.version = FAKE_VERSIONS[this.product].current;
    this.scopes = new Set(ALL_SCOPES);
    this.tokenValid = true;
    this.canWrite = true;
    this.isOrgOwner = false;
    this.siteAdmin = false;
    this.omitLink = false;
    this.foreignRepo = false;
    this.delayMs = 0;
    this.repos.clear();
    this.failures = [];
    this.log = [];
    this.addRepo("docs", false);
  }

  seedRepositories(count: number): void {
    for (let i = 1; i <= count; i++) this.addRepo(`repo-${String(i).padStart(3, "0")}`, false);
  }

  repositoryNames(): string[] {
    return [...this.repos.keys()].sort();
  }

  revokeCredential(): void {
    this.tokenValid = false;
  }

  makeVersionTooOld(): void {
    this.version = FAKE_VERSIONS[this.product].tooOld;
  }

  removeScopeFor(op: "createIssue" | "createRepository"): string | null {
    const scope = op === "createIssue" ? "write:issue" : "write:organization";
    this.scopes.delete(scope);
    return scope;
  }

  denyWrite(): void {
    this.canWrite = false;
  }

  failNext(kind: GitHostFailure): void {
    this.failures.push(kind);
  }

  requests(): readonly { method: string; path: string; authorization: string | undefined }[] {
    return this.log;
  }

  private addRepo(name: string, empty: boolean): Repo {
    const repo: Repo = {
      id: this.nextId++,
      name,
      private: true,
      empty,
      defaultBranch: "main",
      owner: this.organization,
      issues: 0,
    };
    this.repos.set(name, repo);
    return repo;
  }

  private repoJson(r: Repo) {
    const full = `${r.owner}/${r.name}`;
    return {
      id: r.id,
      name: r.name,
      full_name: full,
      owner: { id: 7, login: r.owner },
      default_branch: r.defaultBranch,
      private: r.private,
      empty: r.empty,
      archived: false,
      html_url: `${this.baseUrl}/${full}`,
      clone_url: `${this.baseUrl}/${full}.git`,
      permissions: { admin: this.isOrgOwner, push: this.canWrite, pull: true },
    };
  }

  private send(res: ServerResponse, status: number, body: unknown, headers = {}): void {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  }

  private scopeRefusal(res: ServerResponse, scope: string): void {
    const have = [...this.scopes].join(",");
    const message =
      this.product === "gitea"
        ? `token does not have at least one of required scope(s): [${scope}]`
        : `token does not have at least one of required scope(s), required=[${scope}], token scope=${have}`;
    this.send(res, 403, { message, url: `${this.baseUrl}/api/swagger` });
  }

  private async body(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    return raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>);
  }

  private failure(res: ServerResponse, kind: GitHostFailure): void {
    switch (kind) {
      case "rate_limited":
        this.send(res, 429, { message: "rate limited" }, { "retry-after": "30" });
        return;
      case "unavailable":
        this.send(res, 503, { message: "maintenance" });
        return;
      case "redirect_elsewhere":
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
        res.end();
        return;
      case "oversized":
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ padding: "x".repeat(3 * 1024 * 1024) }));
        return;
      case "garbage":
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html>not an API</html>");
        return;
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.baseUrl);
    const authorization = req.headers.authorization;
    this.log.push({ method: req.method ?? "GET", path: url.pathname, authorization });
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    const prefix = "/api/v1";
    if (!url.pathname.startsWith(prefix)) return this.send(res, 404, { message: "not found" });
    const path = url.pathname.slice(prefix.length);
    if (path === "/version") return this.send(res, 200, { version: this.version });
    const failure = this.failures.shift();
    if (failure) return this.failure(res, failure);
    if (!this.tokenValid || authorization !== `token ${this.secret}`) {
      return this.send(res, 401, { message: "token is required" });
    }
    try {
      await this.route(req.method ?? "GET", path, url, req, res);
    } catch {
      this.send(res, 500, { message: "fake failed" });
    }
  }

  private need(res: ServerResponse, ...scopes: string[]): boolean {
    const missing = scopes.find((s) => !this.scopes.has(s));
    if (missing) this.scopeRefusal(res, missing);
    return missing === undefined;
  }

  private async route(
    method: string,
    path: string,
    url: URL,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const org = this.organization;
    if (method === "GET" && path === "/user") {
      if (!this.need(res, "read:user")) return;
      return this.send(res, 200, { id: 3, login: this.login, is_admin: this.siteAdmin });
    }
    if (method === "GET" && path === `/orgs/${org}`) {
      if (!this.need(res, "read:organization")) return;
      return this.send(res, 200, { id: 7, name: org, username: org, full_name: "Acme Corp" });
    }
    if (method === "GET" && path === `/users/${this.login}/orgs/${org}/permissions`) {
      if (!this.need(res, "read:organization")) return;
      return this.send(res, 200, {
        is_owner: this.isOrgOwner,
        is_admin: this.isOrgOwner,
        can_write: this.canWrite,
        can_read: true,
        can_create_repository: this.canWrite,
      });
    }
    if (path === `/orgs/${org}/repos`) {
      if (method === "GET") return this.listRepos(url, res);
      if (method === "POST") {
        if (!this.need(res, "write:organization", "write:repository")) return;
        const b = await this.body(req);
        const name = String(b.name ?? "");
        if (!/^[A-Za-z0-9_.-]+$/.test(name)) return this.send(res, 422, { message: "bad name" });
        if (this.repos.has(name)) return this.send(res, 409, { message: "repository exists" });
        if (b.private !== true) return this.send(res, 422, { message: "fake wants private" });
        const repo = this.addRepo(name, b.auto_init !== true);
        if (typeof b.default_branch === "string") repo.defaultBranch = b.default_branch;
        return this.send(res, 201, this.repoJson(repo));
      }
    }
    const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
    if (m) return this.repoRoute(method, decodeURIComponent(m[1] ?? ""), m, req, res);
    this.send(res, 404, { message: "not found" });
  }

  private listRepos(url: URL, res: ServerResponse): void {
    if (!this.need(res, "read:organization")) return;
    const page = Number(url.searchParams.get("page") ?? "1");
    const limit = Math.min(Number(url.searchParams.get("limit") ?? "30"), 50);
    const all = [...this.repos.values()].sort((a, b) => a.name.localeCompare(b.name));
    const slice = all.slice((page - 1) * limit, page * limit).map((r) => this.repoJson(r));
    const first = all[0];
    if (this.foreignRepo && first) slice.push(this.repoJson({ ...first, owner: "someone-else" }));
    const headers: Record<string, string> = { "x-total-count": String(all.length) };
    if (!this.omitLink && page * limit < all.length) {
      headers.link = `<${this.baseUrl}${url.pathname}?page=${page + 1}&limit=${limit}>; rel="next"`;
    }
    this.send(res, 200, slice, headers);
  }

  private async repoRoute(
    method: string,
    owner: string,
    m: RegExpExecArray,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const repo =
      owner === this.organization ? this.repos.get(decodeURIComponent(m[2] ?? "")) : undefined;
    const rest = m[3] ?? "";
    if (!repo) return this.send(res, 404, { message: "repository does not exist" });
    const full = `${repo.owner}/${repo.name}`;
    if (method === "GET" && rest === "") {
      if (!this.need(res, "read:repository")) return;
      return this.send(res, 200, this.repoJson(repo));
    }
    if (method === "POST" && rest === "/pulls") {
      if (!this.need(res, "write:repository")) return;
      const b = await this.body(req);
      if (b.head === b.base) return this.send(res, 422, { message: "same branch" });
      const number = ++repo.issues;
      return this.send(res, 201, {
        number,
        title: b.title,
        html_url: `${this.baseUrl}/${full}/pulls/${number}`,
        state: "open",
        merged: false,
      });
    }
    if (method === "POST" && rest === "/issues") {
      if (!this.need(res, "write:issue")) return;
      const b = await this.body(req);
      const number = ++repo.issues;
      return this.send(res, 201, {
        number,
        title: b.title,
        html_url: `${this.baseUrl}/${full}/issues/${number}`,
      });
    }
    const c = /^\/issues\/(\d+)\/comments$/.exec(rest);
    if (method === "POST" && c) {
      if (!this.need(res, "write:issue")) return;
      if (Number(c[1]) > repo.issues) return this.send(res, 404, { message: "no such issue" });
      return this.send(res, 201, {
        id: 9000 + Number(c[1]),
        html_url: `${this.baseUrl}/${full}/issues/${c[1]}#issuecomment-${9000 + Number(c[1])}`,
        body: "",
      });
    }
    this.send(res, 404, { message: "not found" });
  }
}
