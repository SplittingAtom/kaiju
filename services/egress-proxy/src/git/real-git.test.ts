import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CREDENTIAL,
  GIT_HOST,
  listenTls,
  sandboxToken,
  startGitProxy,
  type GitProxyHarness,
} from "../testing/git-harness.js";
import { selfSignedCert } from "../testing/tls-cert.js";

/**
 * KOBE-763: the real `git` client (clone, fetch, push) through the egress proxy to a real git
 * smart-HTTP server (`git http-backend` behind TLS) that accepts only the Workspace's credential.
 * The sandbox side has no credential: its remote URL and config carry none, and it never sees one.
 */
const run = promisify(execFile);

function gitAvailable(): string | undefined {
  try {
    const exec = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
    const backend = path.join(exec, "git-http-backend");
    return existsSync(backend) ? backend : undefined;
  } catch {
    return undefined;
  }
}

const backend = gitAvailable();
const BASIC = `Basic ${Buffer.from(`${CREDENTIAL.username}:${CREDENTIAL.password}`).toString("base64")}`;

describe.skipIf(backend === undefined)(
  "real git through the egress proxy (KOBE-763)",
  { timeout: 60_000 },
  () => {
    const cert = selfSignedCert(GIT_HOST);
    let root = "";
    let upstream: HttpsServer;
    let h: GitProxyHarness;
    const seenAuth: string[] = [];
    let env: NodeJS.ProcessEnv = {};

    beforeAll(async () => {
      root = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "kaiju-git-e2e-"));
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

      upstream = createHttpsServer({ ...cert }, (req, res) => {
        const auth = req.headers.authorization ?? "";
        seenAuth.push(auth);
        if (auth !== BASIC) {
          res.writeHead(401, { "www-authenticate": 'Basic realm="fake"' });
          res.end();
          return;
        }
        const url = new URL(req.url ?? "/", `https://${GIT_HOST}`);
        const cgi = spawn(backend as string, [], {
          env: {
            GIT_PROJECT_ROOT: repos,
            GIT_HTTP_EXPORT_ALL: "1",
            PATH_INFO: decodeURIComponent(url.pathname),
            QUERY_STRING: url.search.slice(1),
            REQUEST_METHOD: req.method ?? "GET",
            CONTENT_TYPE: req.headers["content-type"] ?? "",
            REMOTE_USER: CREDENTIAL.username,
            REMOTE_ADDR: "127.0.0.1",
            ...(req.headers["content-encoding"]
              ? { HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"]) }
              : {}),
            ...(req.headers["git-protocol"]
              ? { GIT_PROTOCOL: String(req.headers["git-protocol"]) }
              : {}),
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
      });
      const upstreamPort = await listenTls(upstream);
      h = await startGitProxy({ upstreamPort, upstreamCa: cert.cert });
      const home = path.join(root, "home");
      mkdirSync(home);
      env = {
        PATH: process.env.PATH,
        HOME: home,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "/bin/false",
        LANG: "C",
      };
    });

    afterAll(() => {
      h?.close();
      upstream?.closeAllConnections();
      upstream?.close();
      if (root) rmSync(root, { recursive: true, force: true });
    });

    /** What the sandbox runs: plain http:// remote, the egress token in the proxy URL, no helper. */
    const git = (args: string[], cwd = root) =>
      run(
        "git",
        [
          "-c",
          `http.proxy=http://kobe:${sandboxToken()}@127.0.0.1:${h.port}`,
          "-c",
          "credential.helper=",
          "-c",
          "user.name=Member",
          "-c",
          "user.email=member@example.test",
          ...args,
        ],
        { cwd, env, timeout: 30_000 },
      );

    it("clones, pushes a branch and fetches through the proxy with no credential in the sandbox", async () => {
      const work = path.join(root, "work");
      await git(["clone", "-q", `http://${GIT_HOST}/acme/app.git`, work]);
      expect(readFileSync(path.join(work, "README.md"), "utf8")).toBe("hello from the host\n");

      writeFileSync(path.join(work, "change.txt"), "from the sandbox\n");
      await git(["add", "."], work);
      await git(["commit", "-q", "-m", "sandbox change"], work);
      await git(["push", "-q", "origin", "HEAD:refs/heads/feature"], work);
      const bareRefs = execFileSync(
        "git",
        ["-C", path.join(root, "repos", "acme", "app.git"), "branch", "--list"],
        { encoding: "utf8" },
      );
      expect(bareRefs).toContain("feature");
      await git(["fetch", "-q", "origin"], work);

      // Every upstream request carried the Workspace's credential (added by the proxy).
      expect(seenAuth.length).toBeGreaterThan(0);
      expect(seenAuth.every((a) => a === BASIC)).toBe(true);
      // The sandbox's repository and config know no credential.
      const config = readFileSync(path.join(work, ".git", "config"), "utf8");
      expect(config).not.toContain(CREDENTIAL.password);
      expect(config).toContain(`url = http://${GIT_HOST}/acme/app.git`);
      // The push is audited with its ref; nothing audited carries the credential.
      expect(h.events).toMatchObject([
        {
          action: "egress.git_push",
          target: {
            repository: "acme/app",
            outcome: "allowed",
            refs: [{ ref: "refs/heads/feature", change: "create" }],
          },
        },
      ]);
      expect(JSON.stringify([h.events, h.audit])).not.toContain(CREDENTIAL.password);
    });

    it("refuses a push outside the organization with the server's message", async () => {
      const work = path.join(root, "work");
      await git(["remote", "add", "outside", `http://${GIT_HOST}/other/app.git`], work);
      const failed = await git(["push", "outside", "HEAD:refs/heads/x"], work).then(
        () => undefined,
        (err: { stderr?: string }) => err.stderr ?? "",
      );
      expect(failed).toBeDefined();
      expect(failed).toContain("outside the organization");
      expect(failed).not.toContain(CREDENTIAL.password);
    });

    it("clones and fetches a larger repository without HTTP compression (review M1)", async () => {
      // ~16 MiB of text in 64 files on the host: the pack is zlib-compressed by git itself, so
      // refusing Content-Encoding costs only the (small) ref advertisement and negotiation.
      const bare = path.join(root, "repos", "acme", "big.git");
      execFileSync("git", ["init", "--bare", "-q", "-b", "main", bare]);
      const seed = path.join(root, "big-seed");
      execFileSync("git", ["init", "-q", "-b", "main", seed]);
      let raw = 0;
      for (let i = 0; i < 64; i += 1) {
        const text = Array.from(
          { length: 4096 },
          (_, n) => `line ${n} of file ${i}: ${"lorem ipsum ".repeat(5)}\n`,
        ).join("");
        raw += Buffer.byteLength(text);
        writeFileSync(path.join(seed, `f${i}.txt`), text);
      }
      const ident = ["-c", "user.name=Seed", "-c", "user.email=seed@example.test"];
      execFileSync("git", ["-C", seed, "add", "."]);
      execFileSync("git", ["-C", seed, ...ident, "commit", "-q", "-m", "big"]);
      execFileSync("git", ["-C", seed, "push", "-q", bare, "main"]);
      const before = h.audit.length;
      const work = path.join(root, "big-work");
      await git(["clone", "-q", `http://${GIT_HOST}/acme/big.git`, work]);
      await git(["fetch", "-q", "origin"], work);
      expect(readFileSync(path.join(work, "f63.txt"), "utf8").length).toBeGreaterThan(100_000);
      const down = h.audit.slice(before).reduce((n, r) => n + r.bytesDown, 0);
      // Every exchange was plain (no Content-Encoding reached git), and the pack stayed small.
      expect(h.audit.slice(before).every((r) => r.outcome === "allowed")).toBe(true);
      expect(down).toBeLessThan(raw / 4);
      process.stdout.write(`[KOBE-763] big clone: raw ${raw} B, relayed ${down} B\n`);
    });

    it("gives a credential helper in the sandbox nothing", () => {
      const filled = spawnSync("git", ["credential", "fill"], {
        cwd: root,
        env,
        input: `protocol=http\nhost=${GIT_HOST}\npath=acme/app.git\n\n`,
        encoding: "utf8",
        timeout: 10_000,
      });
      // No helper and no prompt: git cannot fill a password, and none appears anywhere.
      expect(filled.status).not.toBe(0);
      expect(`${filled.stdout}${filled.stderr}`).not.toContain(CREDENTIAL.password);
    });
  },
);
