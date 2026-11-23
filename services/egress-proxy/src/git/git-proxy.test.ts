import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { connect } from "node:net";
import { gzipSync } from "node:zlib";
import { BandwidthLimiter } from "../limits.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  CREDENTIAL,
  GIT_HOST,
  allowFor,
  defaultDecider,
  listenTls,
  proxyAuthorization,
  rawExchange,
  startGitProxy,
  type GitProxyHarness,
  type GitProxyOptions,
} from "../testing/git-harness.js";
import { selfSignedCert } from "../testing/tls-cert.js";

/**
 * KOBE-763: git smart-HTTP through the egress proxy against a fake git host. Security properties
 * under test: the sandbox never sees the credential, only canonical git paths of the connected
 * organization get it, read/write is the server's decision, no smuggling or redirect carries it.
 */
interface Seen {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly bodyBytes: number;
}

const cert = selfSignedCert(GIT_HOST);
const BASIC = `Basic ${Buffer.from(`${CREDENTIAL.username}:${CREDENTIAL.password}`).toString("base64")}`;
let upstream: HttpsServer;
let upstreamPort = 0;
let seen: Seen[] = [];
let streamed = 0;
let h: GitProxyHarness | undefined;

beforeAll(async () => {
  upstream = createHttpsServer({ ...cert }, (req, res) => {
    let bodyBytes = 0;
    req.on("data", (c: Buffer) => (bodyBytes += c.length));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", path: req.url ?? "", headers: req.headers, bodyBytes });
      const repo = (req.url ?? "").split("/")[2] ?? "";
      if (repo === "redirect.git") {
        res.writeHead(301, { location: `https://${GIT_HOST}/acme/renamed.git/info/refs` });
        res.end();
      } else if (repo === "unauth.git") {
        res.writeHead(401, { "www-authenticate": 'Basic realm="host"' });
        res.end("Bad credentials");
      } else if (repo === "reflect.git") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("0008NAK\n".repeat(50));
        res.end(`debug: ${req.headers.authorization ?? ""}`);
      } else if (repo === "gzip.git") {
        // A host that echoes the header and compresses when asked (review M1).
        const echoed = `you sent: ${req.headers.authorization ?? ""}`;
        if (/gzip/.test(String(req.headers["accept-encoding"] ?? ""))) {
          res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
          res.end(gzipSync(echoed));
        } else {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("plain answer");
        }
      } else if (repo === "forcegzip.git") {
        res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
        res.end(gzipSync(`you sent: ${req.headers.authorization ?? ""}`));
      } else if (repo === "reflect64.git") {
        // The password inside a longer base64 blob, at an offset that changes its encoding.
        const blob = Buffer.concat([
          Buffer.from("x"),
          Buffer.from(CREDENTIAL.password),
          Buffer.from("yz"),
        ]);
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(`data=${blob.toString("base64")}`);
      } else if (repo === "reflectpct.git") {
        const pair = `${CREDENTIAL.username}:${CREDENTIAL.password}`;
        const pct = [...Buffer.from(pair)]
          .map((b) => `%${b.toString(16).padStart(2, "0")}`)
          .join("");
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(`next=${pct}`);
      } else if (repo === "stream.git") {
        res.writeHead(200, { "content-type": "application/x-git-upload-pack-result" });
        const chunk = Buffer.alloc(64 * 1024, 0x61);
        const pump = () => {
          while (streamed < 400 * 1024 * 1024 && !res.destroyed) {
            streamed += chunk.length;
            if (!res.write(chunk)) {
              res.once("drain", pump);
              return;
            }
          }
          res.end();
        };
        pump();
      } else if (repo === "big.git") {
        res.writeHead(200, { "content-type": "application/x-git-upload-pack-result" });
        res.end(Buffer.alloc(2_000_000, 0x61));
      } else {
        res.writeHead(200, {
          "content-type": "application/x-git-upload-pack-advertisement",
          "set-cookie": "session=abc",
          "x-github-request-id": "1",
        });
        res.end(`ok ${req.method} ${req.url}`);
      }
    });
  });
  upstreamPort = await listenTls(upstream);
});
afterAll(() => {
  upstream.closeAllConnections();
  upstream.close();
});
afterEach(() => {
  h?.close();
  h = undefined;
  seen = [];
});

async function start(options: Partial<GitProxyOptions> = {}): Promise<GitProxyHarness> {
  h = await startGitProxy({ upstreamPort, upstreamCa: cert.cert, ...options });
  return h;
}

interface Answer {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

function viaProxy(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: Buffer | string } = {},
): Promise<Answer> {
  const harness = h as GitProxyHarness;
  return new Promise((resolve) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port: harness.port,
      method: options.method ?? "GET",
      path: url,
      headers: { "proxy-authorization": proxyAuthorization(), ...options.headers },
      agent: false,
    });
    req.on("response", (res) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c.toString("latin1")));
      const done = () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
      res.on("end", done);
      res.on("aborted", done);
      res.on("error", done);
    });
    // A cut connection (secret reflected, limit hit after the head) reads as status 0.
    req.on("error", () => resolve({ status: 0, headers: {}, body: "" }));
    req.end(options.body);
  });
}

const refs = (owner: string, repo: string, service = "git-upload-pack") =>
  `http://${GIT_HOST}/${owner}/${repo}.git/info/refs?service=${service}`;
const rpc = (owner: string, repo: string, service = "git-receive-pack") =>
  `http://${GIT_HOST}/${owner}/${repo}.git/${service}`;
const pkt = (s: string) => `${(s.length + 4).toString(16).padStart(4, "0")}${s}`;
const pushBody = (ref: string) =>
  `${pkt(`${"0".repeat(40)} ${"a".repeat(40)} ${ref}\0 report-status\n`)}0000PACK-bytes`;

/** No answer, header or audit row ever carries the credential. */
function expectNoCredential(...texts: string[]): void {
  for (const t of texts) {
    expect(t).not.toContain(CREDENTIAL.password);
    expect(t).not.toContain(BASIC.slice(6));
  }
}

describe("git smart-HTTP through the egress proxy (KOBE-763)", () => {
  it("adds the credential upstream only, on the canonical path, over verified TLS", async () => {
    const harness = await start();
    const res = await viaProxy(refs("ACME", "app"), {
      headers: { "user-agent": "git/2.47.3", "git-protocol": "version=2" },
    });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    const got = seen[0] as Seen;
    // The organization is the connection's own spelling, rebuilt by the proxy.
    expect(got.path).toBe("/acme/app.git/info/refs?service=git-upload-pack");
    expect(got.headers.authorization).toBe(BASIC);
    expect(got.headers.host).toBe(GIT_HOST);
    expect(got.headers["proxy-authorization"]).toBeUndefined();
    expect(got.headers["git-protocol"]).toBe("version=2");
    // Response: allow-listed headers only, no cookie, never the credential.
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(res.headers["x-github-request-id"]).toBeUndefined();
    expect(res.headers.connection).toBe("close");
    expectNoCredential(res.body, JSON.stringify(res.headers), JSON.stringify(harness.audit));
    expect(harness.audit).toMatchObject([
      {
        outcome: "allowed",
        domain: GIT_HOST,
        git: { repository: "acme/app", service: "upload-pack" },
      },
    ]);
    expect(harness.events).toEqual([]);
  });

  it("refuses a request that brings its own credential (sandbox Authorization or Cookie)", async () => {
    const harness = await start();
    for (const headers of [{ authorization: "Basic dXNlcjpwYXNz" }, { cookie: "s=1" }]) {
      const res = await viaProxy(refs("acme", "app"), { headers });
      expect(res.status).toBe(403);
      expect(res.body).toContain("do not send credentials");
    }
    expect(seen).toEqual([]);
    expect(harness.queries).toEqual([]);
  });

  it("refuses URL userinfo before anything else", async () => {
    await start();
    const res = await viaProxy(
      `http://user:pass@${GIT_HOST}/acme/app.git/info/refs?service=git-upload-pack`,
    );
    expect(res.status).toBe(403);
    expect(seen).toEqual([]);
  });

  it("refuses another organization on the connected host, with the server's message", async () => {
    const harness = await start();
    const res = await viaProxy(refs("other", "app", "git-receive-pack"));
    expect(res.status).toBe(403);
    expect(res.body).toContain("outside the organization");
    expect(seen).toEqual([]);
    expect(harness.events).toMatchObject([
      {
        action: "egress.git_push",
        target: { repository: "other/app", outcome: "blocked", reason: "outside_organization" },
      },
    ]);
  });

  it("enforces read vs write as the server decides (push to a read-only connection)", async () => {
    const harness = await start();
    expect((await viaProxy(refs("acme", "readonly"))).status).toBe(200);
    const push = await viaProxy(refs("acme", "readonly", "git-receive-pack"));
    expect(push.status).toBe(403);
    expect(push.body).toContain("read-only");
    expect(harness.queries.map((q) => q.request.service)).toEqual([
      "git-upload-pack",
      "git-receive-pack",
    ]);
  });

  it("gives a host without a connection, and API paths on a connected host, no credential", async () => {
    const harness = await start();
    const other = await viaProxy(
      `http://other.example.test/acme/app.git/info/refs?service=git-upload-pack`,
    );
    expect(other.status).toBe(403);
    expect(other.body).toContain("not enabled for this team");
    const api = await viaProxy(`http://${GIT_HOST}/api/v3/repos/acme/app`);
    expect(api.status).toBe(403);
    expect(seen).toEqual([]);
    // Only the git-shaped request reached the server; the API path never did.
    expect(harness.queries).toHaveLength(1);
  });

  it("refuses non-canonical git paths outright", async () => {
    await start();
    for (const url of [
      `http://${GIT_HOST}/acme/%2e%2e/other/app.git/git-receive-pack`,
      `http://${GIT_HOST}/acme//app.git/info/refs?service=git-upload-pack`,
      `http://${GIT_HOST}/acme/app.git/info/refs`,
    ]) {
      const res = await viaProxy(url, { method: url.includes("receive") ? "POST" : "GET" });
      expect(res.status, url).toBe(400);
    }
    expect(seen).toEqual([]);
  });

  it("never follows or relays a redirect, and maps a refused credential to a clear error", async () => {
    const harness = await start();
    const redirect = await viaProxy(refs("acme", "redirect"));
    expect(redirect.status).toBe(502);
    expect(redirect.headers.location).toBeUndefined();
    expect(redirect.body).toContain("redirect");
    const unauth = await viaProxy(refs("acme", "unauth"));
    expect(unauth.status).toBe(502);
    expect(unauth.headers["www-authenticate"]).toBeUndefined();
    expect(unauth.body).toContain("refused the Workspace's git credential");
    // The refused credential is forgotten: the next request asks the server again.
    await viaProxy(refs("acme", "unauth"));
    expect(harness.queries.filter((q) => q.request.repository === "unauth")).toHaveLength(2);
    expect(seen.filter((s) => s.path.includes("redirect"))).toHaveLength(1);
  });

  it("cuts a response that reflects the credential", async () => {
    const harness = await start();
    const res = await viaProxy(rpc("acme", "reflect", "git-upload-pack"), {
      method: "POST",
      headers: { "content-type": "application/x-git-upload-pack-request" },
      body: "0000",
    });
    expectNoCredential(res.body);
    expect(harness.audit.at(-1)).toMatchObject({ outcome: "failed", reason: "secret_reflected" });
  });

  it("relays a push, names its refs in the audit, and reuses the decision briefly", async () => {
    const harness = await start();
    expect((await viaProxy(refs("acme", "app", "git-receive-pack"))).status).toBe(200);
    const body = pushBody("refs/heads/feature");
    const res = await viaProxy(rpc("acme", "app"), {
      method: "POST",
      headers: {
        "content-type": "application/x-git-receive-pack-request",
        expect: "100-continue",
      },
      body,
    });
    expect(res.status).toBe(200);
    const post = seen.at(-1) as Seen;
    expect(post.bodyBytes).toBe(Buffer.byteLength(body));
    expect(post.headers.expect).toBeUndefined();
    expect(harness.queries).toHaveLength(1);
    expect(harness.events).toMatchObject([
      {
        action: "egress.git_push",
        teamId: expect.any(String),
        target: {
          connectionId: expect.any(String),
          repository: "acme/app",
          outcome: "allowed",
          refs: [{ ref: "refs/heads/feature", change: "create" }],
          status: 200,
        },
      },
    ]);
    expectNoCredential(JSON.stringify(harness.events));
  });

  it("enforces the push limit, declared or streamed", async () => {
    await start({ decide: (q) => ({ ...allowFor(q), push_limit_bytes: 100 }) });
    const declared = await viaProxy(rpc("acme", "app"), {
      method: "POST",
      headers: { "content-type": "application/x-git-receive-pack-request" },
      body: "x".repeat(500),
    });
    expect(declared.status).toBe(413);
    expect(seen).toEqual([]);
    const streamed = await rawExchange(
      h?.port ?? 0,
      [
        `POST ${rpc("acme", "app")} HTTP/1.1`,
        `Host: ${GIT_HOST}`,
        `Proxy-Authorization: ${proxyAuthorization()}`,
        "Content-Type: application/x-git-receive-pack-request",
        "Transfer-Encoding: chunked",
        "",
        `${(400).toString(16)}\r\n${"y".repeat(400)}\r\n0\r\n\r\n`,
      ].join("\r\n"),
    );
    expect(streamed).toMatch(/^HTTP\/1\.1 413/);
  });

  it("caps clone responses", async () => {
    const harness = await start({ settings: { maxResponseBytes: 100_000 } });
    await viaProxy(rpc("acme", "big", "git-upload-pack"), {
      method: "POST",
      headers: { "content-type": "application/x-git-upload-pack-request" },
      body: "0000",
    });
    expect(harness.audit.at(-1)).toMatchObject({ outcome: "failed", reason: "response_too_large" });
  });

  it("does not carry the credential into a pipelined second request", async () => {
    await start();
    const head = (path: string) =>
      [
        `GET ${path} HTTP/1.1`,
        `Host: ${GIT_HOST}`,
        `Proxy-Authorization: ${proxyAuthorization()}`,
        "",
        "",
      ].join("\r\n");
    const answer = await rawExchange(
      h?.port ?? 0,
      head(refs("acme", "app")) + head(`http://${GIT_HOST}/api/v3/user`),
    );
    // One upstream request (the git one, on its own connection); the second never got a credential.
    expect(seen.map((s) => s.path)).toEqual(["/acme/app.git/info/refs?service=git-upload-pack"]);
    expect(answer).toMatch(/^HTTP\/1\.1 200/);
    expectNoCredential(answer);
  });

  it("rejects ambiguous framing (Content-Length with Transfer-Encoding, two lengths)", async () => {
    await start();
    for (const framing of [
      "Content-Length: 4\r\nTransfer-Encoding: chunked",
      "Content-Length: 4\r\nContent-Length: 40",
    ]) {
      const answer = await rawExchange(
        h?.port ?? 0,
        [
          `POST ${rpc("acme", "app")} HTTP/1.1`,
          `Host: ${GIT_HOST}`,
          `Proxy-Authorization: ${proxyAuthorization()}`,
          framing,
          "",
          `0\r\n\r\nPOST ${rpc("other", "app")} HTTP/1.1\r\nHost: x\r\n\r\n`,
        ].join("\r\n"),
      );
      expect(answer).toMatch(/^HTTP\/1\.1 400/);
    }
    expect(seen).toEqual([]);
  });

  it("drops h2c upgrade attempts and hop-by-hop headers upstream", async () => {
    await start();
    const res = await viaProxy(refs("acme", "app"), {
      headers: {
        upgrade: "h2c",
        "http2-settings": "AAMAAABkAAQCAAAAAAIAAAAA",
        connection: "Upgrade, HTTP2-Settings",
      },
    });
    expect(res.status).toBe(200);
    expect(seen[0]?.headers.upgrade).toBeUndefined();
    expect(seen[0]?.headers["http2-settings"]).toBeUndefined();
  });

  it("applies the per-sandbox git rate limit", async () => {
    const harness = await start({ rate: { burst: 2, perSecond: 0.001 } });
    expect((await viaProxy(refs("acme", "app"))).status).toBe(200);
    expect((await viaProxy(refs("acme", "app"))).status).toBe(200);
    const third = await viaProxy(refs("acme", "app"));
    expect(third.status).toBe(429);
    expect(harness.audit.at(-1)).toMatchObject({ outcome: "blocked", reason: "rate_limited" });
  });

  it("refuses an internal address unless the ceiling pattern is internal", async () => {
    await start({
      dns: { [GIT_HOST]: ["10.43.0.10"] },
    });
    const res = await viaProxy(refs("acme", "app"));
    expect(res.status).toBe(403);
    expect(res.body).toContain("internal");
    expect(seen).toEqual([]);
  });

  it("fails closed when the server cannot be asked", async () => {
    await start({ decide: () => ({ decision: "error", status: 503 }) });
    const res = await viaProxy(refs("acme", "app"));
    expect(res.status).toBe(503);
    expect(seen).toEqual([]);
  });

  it("serves a sub-path install (Gitea/Forgejo, Enterprise) under the connection's base path", async () => {
    await start({
      decide: (q) => (q.request.prefix === "/forgejo" ? allowFor(q) : defaultDecider(q)),
    });
    const res = await viaProxy(
      `http://${GIT_HOST}/forgejo/acme/app.git/info/refs?service=git-upload-pack`,
    );
    expect(res.status).toBe(200);
    expect(seen[0]?.path).toBe("/forgejo/acme/app.git/info/refs?service=git-upload-pack");
  });

  describe("security review fixes", () => {
    it("M1: asks for identity, never relays an encoded body, so a gzip echo cannot leak", async () => {
      const harness = await start();
      const asked = await viaProxy(rpc("acme", "gzip", "git-upload-pack"), {
        method: "POST",
        headers: {
          "content-type": "application/x-git-upload-pack-request",
          "accept-encoding": "gzip, deflate, br, zstd",
        },
        body: "0000",
      });
      expect(seen.at(-1)?.headers["accept-encoding"]).toBe("identity");
      expect(asked.status).toBe(200);
      expect(asked.body).toBe("plain answer");
      const forced = await viaProxy(rpc("acme", "forcegzip", "git-upload-pack"), {
        method: "POST",
        headers: { "content-type": "application/x-git-upload-pack-request" },
        body: "0000",
      });
      expect(forced.status).toBe(502);
      expect(forced.headers["content-encoding"]).toBeUndefined();
      expect(forced.body).toContain("encoded body");
      expect(harness.audit.at(-1)).toMatchObject({ outcome: "failed", reason: "encoded_response" });
    });

    it("M1: cuts base64 (any alignment) and percent-encoded echoes of the credential", async () => {
      const harness = await start();
      for (const repo of ["reflect64", "reflectpct"]) {
        const res = await viaProxy(rpc("acme", repo, "git-upload-pack"), {
          method: "POST",
          headers: { "content-type": "application/x-git-upload-pack-request" },
          body: "0000",
        });
        expect(res.body, repo).not.toContain("data=");
        expect(res.body, repo).not.toContain("next=");
        expect(harness.audit.at(-1), repo).toMatchObject({ reason: "secret_reflected" });
      }
    });

    it("M2: a sandbox that stops reading stops the upstream, even while throttled", async () => {
      // A limiter that always asks for a pause (what happens after the burst is spent).
      const throttled = new (class extends BandwidthLimiter {
        override take(): number {
          return 2;
        }
      })(1);
      const harness = await start({
        bandwidth: throttled,
        settings: { maxResponseBytes: 1_000_000_000, timeoutMs: 60_000 },
      });
      streamed = 0;
      const socket = connect({ host: "127.0.0.1", port: harness.port }, () => {
        socket.write(
          `POST ${rpc("acme", "stream", "git-upload-pack")} HTTP/1.1\r\nHost: ${GIT_HOST}\r\n` +
            `Proxy-Authorization: ${proxyAuthorization()}\r\nContent-Length: 4\r\n\r\n0000`,
        );
        socket.pause();
      });
      await new Promise((r) => setTimeout(r, 2_500));
      const first = streamed;
      await new Promise((r) => setTimeout(r, 2_000));
      const second = streamed;
      // Held by back-pressure, not cut by the backstop (the exchange is still open, unaudited).
      expect(harness.audit).toEqual([]);
      socket.destroy();
      // Bounded by socket buffers and the relay backstop, not growing with time.
      expect(second).toBeLessThan(48 * 1024 * 1024);
      expect(second - first).toBeLessThan(4 * 1024 * 1024);
    }, 20_000);

    it("L1: refuses an answer whose access does not fit the service", async () => {
      await start({ decide: (q) => ({ ...allowFor(q), access: "read" }) });
      const res = await viaProxy(refs("acme", "app", "git-receive-pack"));
      expect(res.status).toBe(403);
      expect(seen).toEqual([]);
    });

    it("L2: refuses a compressed push body (its refs could not be audited)", async () => {
      const harness = await start();
      const res = await viaProxy(rpc("acme", "app"), {
        method: "POST",
        headers: {
          "content-type": "application/x-git-receive-pack-request",
          "content-encoding": "gzip",
        },
        body: gzipSync(pushBody("refs/heads/main")),
      });
      expect(res.status).toBe(400);
      expect(seen).toEqual([]);
      expect(harness.events).toMatchObject([
        { action: "egress.git_push", target: { outcome: "blocked", reason: "encoded_request" } },
      ]);
    });

    it("L3: budgets distinct repositories per sandbox; cached ones are free", async () => {
      const harness = await start({ lookups: { burst: 2, perSecond: 0.001 } });
      expect((await viaProxy(refs("acme", "one"))).status).toBe(200);
      expect((await viaProxy(refs("acme", "two"))).status).toBe(200);
      expect((await viaProxy(refs("acme", "one"))).status).toBe(200);
      const third = await viaProxy(refs("acme", "three"));
      expect(third.status).toBe(429);
      expect(harness.queries.map((q) => q.request.repository)).toEqual(["one", "two"]);
    });

    it("L6: audits the server's canonical spelling of the repository", async () => {
      const harness = await start();
      await viaProxy(refs("ACME", "app"));
      expect(harness.audit.at(-1)).toMatchObject({ git: { repository: "acme/app" } });
    });
  });
});
