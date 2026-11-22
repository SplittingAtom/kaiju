import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ContractFailure, GitHostContractFake } from "./git-host-contract.js";

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
}

export class FakeGithub implements GitHostContractFake {
  private server!: Server;
  base = "";
  readonly organization = "acme-test";
  readonly hits: { method: string; path: string; authorization: string | undefined }[] = [];
  readonly mintRequests: { repositories?: string[]; permissions: Record<string, string> }[] = [];
  readonly createdRepositories: { name: string; private: unknown; visibility: unknown }[] = [];
  readonly pullRequests: { repository: string; title: string; head: string; base: string }[] = [];
  readonly issues: { repository: string; title: string }[] = [];
  readonly comments: { repository: string; number: number; body: string }[] = [];
  readonly tokens: IssuedToken[] = [];
  options: FakeGithubOptions = {};
  private failure: ContractFailure | null = null;
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
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
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
    this.failure = null;
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
    };
    this.repos.set(repo.id, repo);
    return repo;
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
      html_url: `${this.base}/${full}`,
      clone_url: `${this.base}/${full}.git`,
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

    if (this.failNow(res)) return;
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
      return reply(200, { login: "kobe-bot-test", id: 77 });
    }
    const orgM = /^\/(orgs|users)\/([^/]+)$/.exec(path);
    if (orgM && method === "GET") {
      if (orgM[2]?.toLowerCase() !== this.organization.toLowerCase())
        return reply(404, { message: "Not Found" });
      if (orgM[1] === "users") return reply(404, { message: "Not Found" });
      return reply(200, {
        id: 900,
        login: this.organization,
        name: "Acme Test",
        html_url: `${this.base}/${this.organization}`,
      });
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
      if (body.visibility === "internal") repo.visibility = "internal";
      return reply(201, this.repoJson(repo));
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
        this.pullRequests.push({
          repository: name,
          title: String(b.title),
          head: String(b.head),
          base: String(b.base),
        });
        const number = this.pullRequests.length;
        return reply(201, {
          id: 70000 + number,
          number,
          html_url: `${this.base}/${owner}/${name}/pull/${number}`,
        });
      }
      if (rest === "/issues" && method === "POST") {
        if (!this.needs(res, who, name, "issues", "write")) return;
        const b = await this.body(req);
        this.issues.push({ repository: name, title: String(b.title) });
        const number = 100 + this.issues.length;
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
    }
    return reply(404, { message: "Not Found" });
  }
}
