import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RunGitContext } from "@kobe/protocol/sandbox-wire";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { egressEnv, EgressTokenFile, type EgressWiring } from "../egress/egress-wiring.js";
import { GIT_CONFIG_FILE_NAME, GitConfigFile, gitConfigText, gitEnv } from "./git-config.js";

/**
 * KOBE-764 ac-1/ac-2 with the real `git` binary: a tool's `bash -c` (BASH_ENV egress script, the
 * rotating egress token, the agent's git config) clones a connected organization's repository
 * with a plain `git clone https://github.com/acme/app.git`, commits as the member and pushes. The
 * fake egress proxy serves `git http-backend` for the connected organization (as KOBE-763's proxy
 * forwards it with the Workspace credential) and answers 401 for anything else, where git must
 * fail without prompting and without asking any credential helper.
 */
const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../images/sandbox/egress-env.sh",
);
const THREAD = "9a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln-_";
const PROXY_AUTH = `Basic ${Buffer.from(`${THREAD}:${TOKEN}`).toString("base64")}`;

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

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly proxyAuth: string | undefined;
  readonly auth: string | undefined;
}

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
      ...(req.headers["content-encoding"]
        ? { HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"]) }
        : {}),
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

describe.skipIf(backend === undefined)(
  "real git with the agent's config through a fake egress proxy (KOBE-764)",
  { timeout: 60_000 },
  () => {
    let root = "";
    let proxy: Server;
    const seen: Seen[] = [];
    let env: Record<string, string> = {};

    beforeAll(async () => {
      root = mkdtempSync(path.join(tmpdir(), "kobe-git-config-"));
      const repos = path.join(root, "repos");
      mkdirSync(path.join(repos, "acme"), { recursive: true });
      const bare = path.join(repos, "acme", "app.git");
      execFileSync("git", ["init", "--bare", "-q", "-b", "main", bare]);
      execFileSync("git", ["-C", bare, "config", "http.receivepack", "true"]);
      const seed = path.join(root, "seed");
      execFileSync("git", ["init", "-q", "-b", "main", seed]);
      writeFileSync(path.join(seed, "README.md"), "hello from the host\n");
      const ident = ["-c", "user.name=Seed", "-c", "user.email=seed@example.test"];
      execFileSync("git", ["-C", seed, "add", "."]);
      execFileSync("git", ["-C", seed, ...ident, "commit", "-q", "-m", "init"]);
      execFileSync("git", ["-C", seed, "push", "-q", bare, "main"]);
      // A repository whose submodule is another repository of the same organization (https URL).
      const libBare = path.join(repos, "acme", "lib.git");
      execFileSync("git", ["init", "--bare", "-q", "-b", "main", libBare]);
      const libSeed = path.join(root, "lib-seed");
      execFileSync("git", ["init", "-q", "-b", "main", libSeed]);
      writeFileSync(path.join(libSeed, "lib.txt"), "library\n");
      execFileSync("git", ["-C", libSeed, "add", "."]);
      execFileSync("git", ["-C", libSeed, ...ident, "commit", "-q", "-m", "lib"]);
      execFileSync("git", ["-C", libSeed, "push", "-q", libBare, "main"]);
      const libHead = execFileSync("git", ["-C", libSeed, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      const withSub = path.join(root, "withsub-seed");
      execFileSync("git", ["init", "-q", "-b", "main", withSub]);
      writeFileSync(
        path.join(withSub, ".gitmodules"),
        '[submodule "lib"]\n\tpath = lib\n\turl = https://github.com/acme/lib.git\n',
      );
      execFileSync("git", ["-C", withSub, "add", ".gitmodules"]);
      execFileSync("git", [
        "-C",
        withSub,
        "update-index",
        "--add",
        "--cacheinfo",
        `160000,${libHead},lib`,
      ]);
      execFileSync("git", ["-C", withSub, ...ident, "commit", "-q", "-m", "with submodule"]);
      const withSubBare = path.join(repos, "acme", "withsub.git");
      execFileSync("git", ["init", "--bare", "-q", "-b", "main", withSubBare]);
      execFileSync("git", ["-C", withSub, "push", "-q", withSubBare, "main"]);

      proxy = createServer((req, res) => {
        const target = req.url ?? "";
        seen.push({
          method: req.method ?? "",
          url: target,
          proxyAuth: req.headers["proxy-authorization"],
          auth: req.headers.authorization,
        });
        if (req.headers["proxy-authorization"] !== PROXY_AUTH) {
          res.writeHead(407, { "proxy-authenticate": 'Basic realm="kobe"' }).end();
          return;
        }
        const url = new URL(target);
        if (url.host === "github.com" && url.pathname.startsWith("/acme/")) {
          serveGit(repos, req, res, url);
          return;
        }
        // A host asking for credentials: git must neither prompt nor ask a helper.
        res.writeHead(401, { "www-authenticate": 'Basic realm="host"' }).end();
      });
      // A tunnel (CONNECT) is what git uses for an https URL it did not rewrite: the real proxy
      // then gives no credential; here it is refused outright, and recorded.
      proxy.on("connect", (req: IncomingMessage, socket: Duplex) => {
        seen.push({
          method: "CONNECT",
          url: req.url ?? "",
          proxyAuth: req.headers["proxy-authorization"],
          auth: req.headers.authorization,
        });
        socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n");
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
        noProxy: "server.kobe.internal,localhost",
        envScript: SCRIPT,
        tokens: { current: async () => TOKEN, onChange: () => () => undefined },
      };

      // A planted helper in the system config and in ~/.gitconfig: neither may ever run.
      const home = path.join(root, "home");
      mkdirSync(home);
      const helperLog = path.join(root, "helper.log");
      const helper = path.join(root, "helper.sh");
      writeFileSync(
        helper,
        `#!/bin/sh\necho called >> ${helperLog}\necho username=x\necho password=stolen\n`,
        { mode: 0o755 },
      );
      writeFileSync(path.join(root, "system-gitconfig"), `[credential]\n\thelper = ${helper}\n`);
      writeFileSync(path.join(home, ".gitconfig"), `[credential]\n\thelper = store\n`);
      env = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        LANG: "C",
        GIT_CONFIG_SYSTEM: path.join(root, "system-gitconfig"),
        ...egressEnv(wiring, tokenFile.path, THREAD),
        ...gitEnv(configFile.path),
      };
    });

    afterAll(() => {
      proxy?.closeAllConnections();
      proxy?.close();
      if (root) rmSync(root, { recursive: true, force: true });
    });

    /** A tool's bash call, as Pi runs it: `bash -c`, stdin closed (async: the proxy is in-process). */
    const tool = (command: string, cwd = root) =>
      new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
        const child = spawn("/bin/bash", ["-c", command], {
          cwd,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 30_000,
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
        child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
        child.on("close", (status) => resolve({ status, stdout, stderr }));
      });

    it("clones with a plain https URL: plain HTTP to the proxy, egress token, no credential", async () => {
      const out = await tool("git clone -q https://github.com/acme/app.git app");
      expect(out.status, out.stderr).toBe(0);
      expect(readFileSync(path.join(root, "app", "README.md"), "utf8")).toBe(
        "hello from the host\n",
      );
      const discovery = seen.find((s) => s.url.includes("/info/refs"));
      expect(discovery?.url).toBe(
        "http://github.com/acme/app.git/info/refs?service=git-upload-pack",
      );
      expect(seen.filter((s) => s.auth !== undefined || s.proxyAuth !== PROXY_AUTH)).toEqual([]);
      // The clone's own config names the https URL the agent typed; nothing secret in it.
      const cloned = readFileSync(path.join(root, "app", ".git", "config"), "utf8");
      expect(cloned).toContain("url = https://github.com/acme/app.git");
      expect(cloned).not.toContain(TOKEN);
    });

    it("commits as the member with 'via Kaiju' in the committer and pushes a branch", async () => {
      const app = path.join(root, "app");
      const out = await tool(
        "git switch -q -c agent/change && echo more >> README.md && git commit -qam 'more' && " +
          "git push -q origin agent/change",
        app,
      );
      expect(out.status, out.stderr).toBe(0);
      const bare = path.join(root, "repos", "acme", "app.git");
      const log = execFileSync(
        "git",
        ["-C", bare, "log", "-1", "--format=%an <%ae>|%cn <%ce>", "agent/change"],
        {
          encoding: "utf8",
        },
      ).trim();
      expect(log).toBe("Ada Lovelace <ada@acme.test>|Ada Lovelace via Kaiju <ada@acme.test>");
      expect(seen.some((s) => s.url.endsWith("/git-receive-pack"))).toBe(true);
    });

    it("fails at once on a host that asks for a credential: no prompt, no helper, nothing stored", async () => {
      const out = await tool("git clone -q http://github.com/other/x.git x");
      expect(out.status).not.toBe(0);
      expect(out.stderr).toMatch(/terminal prompts disabled|could not read Username/);
      expect(existsSync(path.join(root, "helper.log"))).toBe(false);
      expect(existsSync(path.join(root, "home", ".git-credentials"))).toBe(false);
      const fill = await tool(
        "printf 'protocol=http\\nhost=github.com\\n\\n' | git credential fill",
      );
      expect(fill.status).not.toBe(0);
      expect(fill.stdout).not.toContain("stolen");
      expect(existsSync(path.join(root, "helper.log"))).toBe(false);
    });

    it("rewrites the connected organization's ssh spelling, and fails closed on any other ssh remote", async () => {
      const ok = await tool("git clone -q git@github.com:acme/app.git app-ssh");
      expect(ok.status, ok.stderr).toBe(0);
      for (const url of [
        "git@github.com:other/x.git",
        "ssh://git@gitlab.example.test/acme/x.git",
      ]) {
        const before = seen.length;
        const out = await tool(`git clone -q ${url} ssh-out`);
        expect(out.status, url).not.toBe(0);
        expect(out.stderr).toContain("kobe: SSH is not available in the sandbox");
        expect(seen.length).toBe(before);
      }
    });

    it("does not rewrite another organization or another letter case: a tunnel without credential", async () => {
      for (const url of ["https://github.com/other/app.git", "https://github.com/ACME/app.git"]) {
        const before = seen.length;
        const out = await tool(`git clone -q ${url} not-rewritten`);
        expect(out.status, url).not.toBe(0);
        const asked = seen.slice(before);
        expect(asked.map((s) => s.method)).toEqual(["CONNECT"]);
        expect(asked[0]?.url).toBe("github.com:443");
        expect(asked[0]?.auth).toBeUndefined();
      }
      expect(existsSync(path.join(root, "helper.log"))).toBe(false);
    });

    it("clones a submodule in the same organization through the proxy too", async () => {
      const before = seen.length;
      const out = await tool(
        "git clone -q --recurse-submodules https://github.com/acme/withsub.git withsub",
      );
      expect(out.status, out.stderr).toBe(0);
      expect(readFileSync(path.join(root, "withsub", "lib", "lib.txt"), "utf8")).toBe("library\n");
      const urls = seen.slice(before).map((s) => s.url);
      expect(urls).toContain("http://github.com/acme/lib.git/info/refs?service=git-upload-pack");
      expect(seen.slice(before).every((s) => s.method !== "CONNECT")).toBe(true);
    });

    it("keeps ~/.gitconfig out of it: global config is the agent's file", async () => {
      const out = await tool("git config --global --list --show-origin");
      expect(out.status, out.stderr).toBe(0);
      expect(out.stdout).toContain(GIT_CONFIG_FILE_NAME);
      expect(out.stdout).not.toContain(".gitconfig");
      expect(out.stdout).toContain("credential.helper=");
    });
  },
);
