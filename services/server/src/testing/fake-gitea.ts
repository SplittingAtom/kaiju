import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  FAKE_GIT_HOST,
  type ContractFailure,
  type GitHostContractFake,
} from "./git-host-contract.js";

/**
 * A fake Gitea / Forgejo `/api/v1` (tests only, KOBE-759): one organization, a bot account, an
 * access token with Gitea's scope names, in-memory repositories, pull requests, issues and
 * comments. Scope refusals use both of Gitea's message formats (the older `…scope(s): [x]` for
 * Gitea, the newer `…scope(s), required=[x], token scope=…` for Forgejo). Nothing here is a real
 * host, account or token.
 */

export type FakeProduct = "gitea" | "forgejo";

/** One-off answers for the adapter's own tests (beyond the shared contract's failures). */
export type FakeGiteaAnswer = "oversized" | "garbage";

interface Repo {
  id: number;
  name: string;
  owner: string;
  empty: boolean;
  defaultBranch: string;
  issues: number;
  description: string;
  private: boolean;
  archived?: boolean;
  /** Branch → commit SHA. */
  branches: Map<string, string>;
  /** Path → text. */
  files: Map<string, string>;
  /** Pull requests and issues share one number sequence, as on Gitea. */
  items: {
    number: number;
    pull: boolean;
    title: string;
    body: string;
    head?: string;
    base?: string;
  }[];
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
  forgejo: { current: "15.0.3+gitea-1.22.0", tooOld: "14.0.2+gitea-1.22.0" },
};

/** A made-up token; never a real credential. */
export const FAKE_GITEA_TOKEN = "fake-gitea-token-0123456789abcdef";

export class FakeGitea implements GitHostContractFake {
  private server!: Server;
  port = 0;
  readonly organization = "acme";
  readonly login = "kobe-bot";
  readonly token = FAKE_GITEA_TOKEN;
  version: string;
  scopes = new Set(ALL_SCOPES);
  canWrite = true;
  isOrgOwner = false;
  siteAdmin = false;
  /** Leave the `Link` header out of list answers (X-Total-Count only). */
  omitLink = false;
  delayMs = 0;
  private repos = new Map<string, Repo>();
  private nextId = 100;
  private failure: ContractFailure | null = null;
  private answers: FakeGiteaAnswer[] = [];
  private hits: { method: string; path: string; authorization: string | undefined }[] = [];

  constructor(readonly product: FakeProduct) {
    this.version = FAKE_VERSIONS[product].current;
  }

  get baseUrl(): string {
    return `http://${FAKE_GIT_HOST}:${this.port}`;
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
    this.canWrite = true;
    this.isOrgOwner = false;
    this.siteAdmin = false;
    this.omitLink = false;
    this.delayMs = 0;
    this.repos.clear();
    this.failure = null;
    this.answers = [];
    this.hits = [];
  }

  fail(failure: ContractFailure | null): void {
    this.failure = failure;
  }

  makeTooOld(): void {
    this.version = FAKE_VERSIONS[this.product].tooOld;
  }

  answerNext(answer: FakeGiteaAnswer): void {
    this.answers.push(answer);
  }

  seedRepositories(names: readonly string[]): void {
    for (const name of names) this.addRepo(this.organization, name, false);
  }

  /** Adds a file to a repository of the organization (tests). */
  seedFile(name: string, path: string, text: string): void {
    this.repos.get(`${this.organization}/${name}`)?.files.set(path, text);
  }

  seedForeignRepository(owner: string, name: string): string {
    return String(this.addRepo(owner, name, false).id);
  }

  /** Changes a repository of the organization as a host admin would (Convert to repo tests). */
  editRepository(
    name: string,
    change: {
      private?: boolean;
      description?: string;
      defaultBranch?: string;
      archived?: boolean;
      /** Renames it (the id stays, as on the host); KOBE-766 mirror tests. */
      name?: string;
    },
  ): void {
    const repo = this.repos.get(`${this.organization}/${name}`);
    if (!repo) throw new Error(`fake gitea: no repository ${name}`);
    if (change.name !== undefined) {
      this.repos.delete(`${this.organization}/${name}`);
      repo.name = change.name;
      this.repos.set(`${this.organization}/${change.name}`, repo);
    }
    if (change.archived !== undefined) repo.archived = change.archived;
    if (change.private !== undefined) repo.private = change.private;
    if (change.description !== undefined) repo.description = change.description;
    if (change.defaultBranch !== undefined) repo.defaultBranch = change.defaultBranch;
  }

  /** Deletes a repository of the organization as a host admin would (KOBE-766 mirror tests). */
  deleteRepository(name: string): void {
    this.repos.delete(`${this.organization}/${name}`);
  }

  apiHits(): readonly { method: string; path: string; authorization: string | undefined }[] {
    return this.hits;
  }

  private addRepo(owner: string, name: string, empty: boolean): Repo {
    const repo: Repo = {
      id: this.nextId++,
      name,
      owner,
      empty,
      defaultBranch: "main",
      issues: 0,
      description: "",
      private: true,
      branches: new Map(empty ? [] : [["main", "c".repeat(40)]]),
      files: new Map(empty ? [] : [["README.md", "# Hello\n"]]),
      items: [],
    };
    this.repos.set(`${owner}/${name}`, repo);
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
      archived: r.archived === true,
      description: r.description,
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

  private answerFailure(res: ServerResponse, kind: ContractFailure): void {
    switch (kind) {
      case "auth":
        return this.send(res, 401, { message: "token is required" });
      case "forbidden":
        return this.send(res, 403, { message: "user should be a collaborator" });
      case "rate_limited":
        return this.send(res, 429, { message: "rate limited" }, { "retry-after": "30" });
      case "secondary_rate_limited":
        return this.send(res, 429, { message: "slow down" }, { "retry-after": "5" });
      case "server_error":
        return this.send(res, 500, { message: "internal error" });
      case "redirect_foreign":
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
        res.end();
        return;
    }
  }

  private answer(res: ServerResponse, kind: FakeGiteaAnswer): void {
    if (kind === "oversized") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ padding: "x".repeat(5 * 1024 * 1024) }));
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html>not an API</html>");
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.baseUrl);
    const authorization = req.headers.authorization;
    this.hits.push({ method: req.method ?? "GET", path: url.pathname, authorization });
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    const prefix = "/api/v1";
    if (!url.pathname.startsWith(prefix)) return this.send(res, 404, { message: "not found" });
    const path = url.pathname.slice(prefix.length);
    if (path === "/version") return this.send(res, 200, { version: this.version });
    if (this.failure) return this.answerFailure(res, this.failure);
    const answer = this.answers.shift();
    if (answer) return this.answer(res, answer);
    if (authorization !== `token ${this.token}`) {
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
      if (method === "POST") return this.createRepo(req, res);
    }
    const byId = /^\/repositories\/(\d+)$/.exec(path);
    if (method === "GET" && byId) {
      if (!this.need(res, "read:repository")) return;
      const repo = [...this.repos.values()].find((r) => String(r.id) === byId[1]);
      if (!repo) return this.send(res, 404, { message: "not found" });
      return this.send(res, 200, this.repoJson(repo));
    }
    const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
    if (m) {
      const key = `${decodeURIComponent(m[1] ?? "")}/${decodeURIComponent(m[2] ?? "")}`;
      return this.repoRoute(method, this.repos.get(key), m[3] ?? "", req, res, url);
    }
    this.send(res, 404, { message: "not found" });
  }

  private listRepos(url: URL, res: ServerResponse): void {
    if (!this.need(res, "read:organization")) return;
    const page = Number(url.searchParams.get("page") ?? "1");
    // Like Gitea's default `MAX_RESPONSE_ITEMS`.
    const limit = Math.min(Number(url.searchParams.get("limit") ?? "30"), 50);
    const all = [...this.repos.values()]
      .filter((r) => r.owner === this.organization)
      .sort((a, b) => a.name.localeCompare(b.name));
    const slice = all.slice((page - 1) * limit, page * limit).map((r) => this.repoJson(r));
    const headers: Record<string, string> = { "x-total-count": String(all.length) };
    if (!this.omitLink && page * limit < all.length) {
      headers.link = `<${this.baseUrl}${url.pathname}?page=${page + 1}&limit=${limit}>; rel="next"`;
    }
    this.send(res, 200, slice, headers);
  }

  private async createRepo(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.need(res, "write:organization", "write:repository")) return;
    const b = await this.body(req);
    const name = String(b.name ?? "");
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) return this.send(res, 422, { message: "bad name" });
    if (this.repos.has(`${this.organization}/${name}`)) {
      return this.send(res, 409, { message: "The repository with the same name already exists." });
    }
    if (b.private !== true) return this.send(res, 422, { message: "fake wants private" });
    const repo = this.addRepo(this.organization, name, true);
    repo.description = typeof b.description === "string" ? b.description : "";
    return this.send(res, 201, this.repoJson(repo));
  }

  private async repoRoute(
    method: string,
    repo: Repo | undefined,
    rest: string,
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
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
      repo.items.push({
        number,
        pull: true,
        title: String(b.title),
        body: String(b.body ?? ""),
        head: String(b.head),
        base: String(b.base),
      });
      return this.send(res, 201, {
        id: 5000 + number,
        number,
        title: b.title,
        html_url: `${this.baseUrl}/${full}/pulls/${number}`,
        state: "open",
      });
    }
    if (method === "POST" && rest === "/issues") {
      if (!this.need(res, "write:issue")) return;
      const b = await this.body(req);
      const number = ++repo.issues;
      repo.items.push({ number, pull: false, title: String(b.title), body: String(b.body ?? "") });
      return this.send(res, 201, {
        id: 6000 + number,
        number,
        title: b.title,
        html_url: `${this.baseUrl}/${full}/issues/${number}`,
      });
    }
    const c = /^\/issues\/(\d+)\/comments$/.exec(rest);
    if (method === "POST" && c) {
      if (!this.need(res, "write:issue")) return;
      if (Number(c[1]) > repo.issues) return this.send(res, 404, { message: "no such issue" });
      const id = 9000 + Number(c[1]);
      return this.send(res, 201, {
        id,
        html_url: `${this.baseUrl}/${full}/issues/${c[1]}#issuecomment-${id}`,
      });
    }
    return this.readRoute(method, repo, rest, req, res, url);
  }

  private itemJson(repo: Repo, i: Repo["items"][number]) {
    const full = `${repo.owner}/${repo.name}`;
    return {
      id: (i.pull ? 5000 : 6000) + i.number,
      number: i.number,
      title: i.title,
      body: i.body,
      state: "open",
      user: { login: this.login },
      comments: 0,
      html_url: `${this.baseUrl}/${full}/${i.pull ? "pulls" : "issues"}/${i.number}`,
      created_at: "2026-11-01T00:00:00Z",
      updated_at: "2026-11-01T00:00:00Z",
      ...(i.pull
        ? {
            merged: false,
            draft: false,
            head: { ref: i.head, repo: { owner: { login: repo.owner } } },
            base: { ref: i.base },
            pull_request: { merged: false },
          }
        : { pull_request: null }),
    };
  }

  /** Branches, contents, pull requests and issues (KOBE-762 reads, create branch). */
  private async readRoute(
    method: string,
    repo: Repo,
    rest: string,
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    const page = Number(url.searchParams.get("page") ?? "1");
    const limit = Math.min(Number(url.searchParams.get("limit") ?? "30"), 50);
    const paged = (all: unknown[]) =>
      this.send(res, 200, all.slice((page - 1) * limit, page * limit), {
        "x-total-count": String(all.length),
      });
    if (rest === "/branches" && method === "GET") {
      if (!this.need(res, "read:repository")) return;
      return paged(
        [...repo.branches.entries()].map(([name, id]) => ({
          name,
          commit: { id },
          protected: false,
        })),
      );
    }
    if (rest === "/branches" && method === "POST") {
      if (!this.need(res, "write:repository")) return;
      const b = await this.body(req);
      const name = String(b.new_branch_name);
      if (repo.branches.has(name)) return this.send(res, 409, { message: "branch exists" });
      const from =
        typeof b.old_ref_name === "string"
          ? [...repo.branches.values()].find((v) => v === b.old_ref_name)
          : repo.branches.get(String(b.old_branch_name));
      if (from === undefined) return this.send(res, 404, { message: "no such ref" });
      repo.branches.set(name, from);
      return this.send(res, 201, { name, commit: { id: from }, protected: false });
    }
    const contents = /^\/contents(?:\/(.*))?$/.exec(rest);
    if (contents && method === "GET") {
      if (!this.need(res, "read:repository")) return;
      const path = decodeURIComponent(contents[1] ?? "");
      const text = repo.files.get(path);
      if (text !== undefined) {
        return this.send(res, 200, {
          type: "file",
          path,
          name: path.split("/").pop(),
          size: Buffer.byteLength(text),
          sha: "d".repeat(40),
          encoding: "base64",
          content: Buffer.from(text, "utf8").toString("base64"),
        });
      }
      const prefix = path === "" ? "" : `${path}/`;
      const under = [...repo.files.keys()].filter((f) => f.startsWith(prefix));
      if (under.length === 0) return this.send(res, 404, { message: "not found" });
      const names = [...new Set(under.map((f) => f.slice(prefix.length).split("/")[0] ?? ""))];
      return this.send(
        res,
        200,
        names.map((n) => ({
          name: n,
          path: `${prefix}${n}`,
          type: repo.files.has(`${prefix}${n}`) ? "file" : "dir",
          size: repo.files.get(`${prefix}${n}`)?.length ?? 0,
        })),
      );
    }
    if (rest === "/pulls" && method === "GET") {
      if (!this.need(res, "read:repository")) return;
      return paged(repo.items.filter((i) => i.pull).map((i) => this.itemJson(repo, i)));
    }
    const pr = /^\/pulls\/(\d+)$/.exec(rest);
    if (pr && method === "GET") {
      if (!this.need(res, "read:repository")) return;
      const i = repo.items.find((x) => x.pull && x.number === Number(pr[1]));
      return i
        ? this.send(res, 200, this.itemJson(repo, i))
        : this.send(res, 404, { message: "not found" });
    }
    if (rest === "/issues" && method === "GET") {
      if (!this.need(res, "read:issue")) return;
      const onlyIssues = url.searchParams.get("type") === "issues";
      return paged(
        repo.items.filter((i) => !onlyIssues || !i.pull).map((i) => this.itemJson(repo, i)),
      );
    }
    const issue = /^\/issues\/(\d+)$/.exec(rest);
    if (issue && method === "GET") {
      if (!this.need(res, "read:issue")) return;
      const i = repo.items.find((x) => x.number === Number(issue[1]));
      return i
        ? this.send(res, 200, this.itemJson(repo, i))
        : this.send(res, 404, { message: "not found" });
    }
    this.send(res, 404, { message: "not found" });
  }
}
