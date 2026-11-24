import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RunGitContext, RunGitRepo } from "@kobe/protocol/sandbox-wire";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { egressEnv, EgressTokenFile, type EgressWiring } from "../egress/egress-wiring.js";
import { TIMEOUT_BIN, toolCommandRunner } from "../threads/tool-command.js";
import { GIT_CONFIG_FILE_NAME, GitConfigFile, gitConfigText, gitEnv } from "./git-config.js";
import { workingCopyStatus } from "./working-copy.js";

/**
 * KOBE-767 ac-3 with the real `git`: the agent's working-copy script, run as the tools run (the
 * egress BASH_ENV script, the thread's git config), makes `/workspace/.kobe/repos/<slug>` a git working
 * copy of the Repo through a fake egress proxy serving `git http-backend`, and reports branch,
 * ahead/behind and changes.
 */
const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../images/sandbox/egress-env.sh",
);
const THREAD = "9a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln-_";
const PROXY_AUTH = `Basic ${Buffer.from(`${THREAD}:${TOKEN}`).toString("base64")}`;
const ID = "11111111-1111-4111-8111-111111111111";

const context: RunGitContext = {
  author: { name: "Ada Lovelace", email: "ada@acme.test" },
  committer: { name: "Ada Lovelace via Kaiju", email: "ada@acme.test" },
  remotes: [{ base_url: "https://github.com", organization: "acme" }],
};

function httpBackend(): string | undefined {
  try {
    const exec = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
    const backend = path.join(exec, "git-http-backend");
    return existsSync(backend) ? backend : undefined;
  } catch {
    return undefined;
  }
}
const backend = httpBackend();

function serveGit(repos: string, req: IncomingMessage, res: ServerResponse, url: URL): void {
  const cgi = spawn(backend as string, [], {
    env: {
      GIT_PROJECT_ROOT: repos,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: req.method ?? "GET",
      CONTENT_TYPE: req.headers["content-type"] ?? "",
      REMOTE_USER: "workspace-bot",
      REMOTE_ADDR: "127.0.0.1",
      ...(req.headers["git-protocol"] ? { GIT_PROTOCOL: String(req.headers["git-protocol"]) } : {}),
      PATH: process.env.PATH ?? "",
    },
  });
  req.pipe(cgi.stdin);
  let head = Buffer.alloc(0);
  let headerDone = false;
  cgi.stdout.on("data", (chunk: Buffer) => {
    if (headerDone) {
      res.write(chunk);
      return;
    }
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf("\r\n\r\n");
    if (end < 0) return;
    headerDone = true;
    let status = 200;
    const headers: Record<string, string> = {};
    for (const line of head.subarray(0, end).toString("latin1").split("\r\n")) {
      const colon = line.indexOf(":");
      const name = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      if (name.toLowerCase() === "status") status = Number(value.split(" ")[0]);
      else headers[name] = value;
    }
    res.writeHead(status, headers);
    res.write(head.subarray(end + 4));
  });
  cgi.stdout.on("end", () => res.end());
}

describe.skipIf(backend === undefined || !existsSync(TIMEOUT_BIN))(
  "the Repo working copy with real git through a fake egress proxy (KOBE-767)",
  { timeout: 60_000 },
  () => {
    let root = "";
    let workspace = "";
    let seed = "";
    let proxy: Server;
    let env: Record<string, string> = {};
    let fail = false;
    const ident = ["-c", "user.name=Seed", "-c", "user.email=seed@example.test"];
    const repo = (slug: string, name = slug): RunGitRepo => ({
      project_id: ID,
      slug,
      clone_url: `https://github.com/acme/${name}.git`,
      default_branch: "main",
      access: "write",
    });
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        env: { ...process.env, ...env },
      }).trim();

    beforeAll(async () => {
      root = mkdtempSync(path.join(tmpdir(), "kobe-working-copy-"));
      workspace = path.join(root, "workspace");
      mkdirSync(workspace);
      const repos = path.join(root, "host");
      mkdirSync(path.join(repos, "acme"), { recursive: true });
      for (const name of ["app", "empty"]) {
        const bare = path.join(repos, "acme", `${name}.git`);
        execFileSync("git", ["init", "--bare", "-q", "-b", "main", bare]);
        execFileSync("git", ["-C", bare, "config", "http.receivepack", "true"]);
      }
      seed = path.join(root, "seed");
      execFileSync("git", ["init", "-q", "-b", "main", seed]);
      writeFileSync(path.join(seed, "README.md"), "hello\n");
      execFileSync("git", ["-C", seed, "add", "."]);
      execFileSync("git", ["-C", seed, ...ident, "commit", "-q", "-m", "init"]);
      execFileSync("git", ["-C", seed, "push", "-q", path.join(repos, "acme", "app.git"), "main"]);

      proxy = createServer((req, res) => {
        if (fail || req.headers["proxy-authorization"] !== PROXY_AUTH) {
          res.writeHead(fail ? 502 : 407).end();
          return;
        }
        const url = new URL(req.url ?? "");
        if (url.host === "github.com" && url.pathname.startsWith("/acme/")) {
          serveGit(repos, req, res, url);
          return;
        }
        res.writeHead(404).end();
      });
      await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
      const port = (proxy.address() as AddressInfo).port;
      const runtime = path.join(root, "runtime");
      mkdirSync(runtime, { mode: 0o700 });
      const tokenFile = new EgressTokenFile(path.join(runtime, "egress-token"));
      await tokenFile.write(TOKEN);
      const configFile = new GitConfigFile(path.join(runtime, GIT_CONFIG_FILE_NAME));
      await configFile.write(gitConfigText(context));
      const wiring: EgressWiring = {
        proxyUrl: `http://127.0.0.1:${port}`,
        noProxy: "localhost",
        envScript: SCRIPT,
        tokens: { current: async () => TOKEN, onChange: () => () => undefined },
      };
      const home = path.join(root, "home");
      mkdirSync(home);
      env = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        LANG: "C",
        GIT_CONFIG_NOSYSTEM: "1",
        ...egressEnv(wiring, tokenFile.path, THREAD),
        ...gitEnv(configFile.path),
      };
    });

    afterAll(() => {
      proxy?.closeAllConnections();
      proxy?.close();
      if (root) rmSync(root, { recursive: true, force: true });
    });

    const status = (r: RunGitRepo, timeoutMs = 30_000) =>
      workingCopyStatus(toolCommandRunner({ env, cwd: workspace, sameUid: true }), workspace, r, {
        fetch: true,
        timeoutMs,
      });

    it("clones a fresh working copy and reports it level with the host", async () => {
      const s = await status(repo("app"));
      expect(s.problem).toBeNull();
      expect(s).toMatchObject({ branch: "main", upstream: "origin/main", ahead: 0, behind: 0 });
      expect(s).toMatchObject({ dirty: false, fetched: true });
      expect(s.head_sha).toBe(git(seed, "rev-parse", "HEAD"));
      expect(readFileSync(path.join(workspace, ".kobe", "repos", "app", "README.md"), "utf8")).toBe(
        "hello\n",
      );
      // The clone names the plain https URL; no token in its config.
      const config = readFileSync(
        path.join(workspace, ".kobe", "repos", "app", ".git", "config"),
        "utf8",
      );
      expect(config).toContain("https://github.com/acme/app.git");
      expect(config).not.toContain(TOKEN);
    });

    it("counts a local commit ahead and a host commit behind", async () => {
      const dir = path.join(workspace, ".kobe", "repos", "app");
      writeFileSync(path.join(dir, "local.txt"), "mine\n");
      git(dir, "add", ".");
      git(dir, "commit", "-q", "-m", "local");
      writeFileSync(path.join(seed, "host.txt"), "theirs\n");
      execFileSync("git", ["-C", seed, "add", "."]);
      execFileSync("git", ["-C", seed, ...ident, "commit", "-q", "-m", "host"]);
      execFileSync("git", [
        "-C",
        seed,
        "push",
        "-q",
        path.join(root, "host", "acme", "app.git"),
        "main",
      ]);
      writeFileSync(path.join(dir, "draft.txt"), "uncommitted\n");
      const s = await status(repo("app"));
      expect(s).toMatchObject({ branch: "main", ahead: 1, behind: 1, dirty: true, fetched: true });
    });

    it("turns a folder of files without .git into a working copy, keeping them as changes", async () => {
      const dir = path.join(workspace, ".kobe", "repos", "restored");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "README.md"), "hello, edited\n");
      const s = await status(repo("restored", "app"));
      expect(s.problem).toBeNull();
      expect(s).toMatchObject({ branch: "main", upstream: "origin/main", ahead: 0, dirty: true });
      expect(readFileSync(path.join(dir, "README.md"), "utf8")).toBe("hello, edited\n");
      expect(git(dir, "status", "--porcelain")).toContain("README.md");
    });

    it("points a working copy whose origin is not the Repo back at it (review L4)", async () => {
      const dir = path.join(workspace, ".kobe", "repos", "app");
      git(dir, "remote", "set-url", "origin", "https://github.com/acme/other.git");
      const s = await status(repo("app"));
      expect(s.fetched).toBe(true);
      expect(git(dir, "config", "--get", "remote.origin.url")).toBe(
        "https://github.com/acme/app.git",
      );
    });

    it("tolerates an empty repository on the host", async () => {
      const s = await status(repo("empty"));
      expect(s).toMatchObject({ branch: "main", head_sha: null, ahead: 0, behind: 0 });
      expect(existsSync(path.join(workspace, ".kobe", "repos", "empty", ".git"))).toBe(true);
    });

    it("reports a failed fetch without failing", async () => {
      fail = true;
      try {
        const s = await status(repo("app"));
        expect(s).toMatchObject({ branch: "main", fetched: false, problem: "fetch failed" });
      } finally {
        fail = false;
      }
    });
  },
);
