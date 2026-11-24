import { createReadStream } from "node:fs";
import http from "node:http";
import { pipeline } from "node:stream/promises";
import https from "node:https";
import type { GitHttpRequest, GitHttpResponse, HttpClient } from "isomorphic-git";
import { pinnedLookup } from "../connectors/oauth/http.js";
import { checkConnectorUrl, type ConnectorUrlPolicy } from "../connectors/url-policy.js";
import { GitHostError } from "./adapter.js";
import type { GitHostNet } from "./http.js";
import { assertGitHostTarget, assertRequestHost, type GitHostTarget } from "./target.js";

/**
 * Git smart-HTTP from the server to one repository of a connected organization (KOBE-765, Convert
 * to repo; spec workspace-git G16, §9), as an isomorphic-git `HttpClient`. The same rules as the
 * adapters' API calls (`http.ts`), for the transport:
 *
 * - every request needs the Site's decision ({@link GitHostTarget}, G3) and re-checks its host
 *   against it, then the connectors' address policy (https; private addresses only where the Site
 *   lists them), and connects to the address that check approved (pinned lookup: no rebinding);
 * - only the repository's own three smart-HTTP endpoints (`info/refs?service=…`,
 *   `git-upload-pack`, `git-receive-pack`) under its clone URL are reachable, nothing else on the
 *   host;
 * - redirects are never followed (a 3xx is an error), so the credential never leaves for another
 *   address; the Basic credential is the one the adapter handed out for this repository
 *   (`repositoryCredential(repo, "write")`), and whatever isomorphic-git put in an
 *   `Authorization` header is dropped;
 * - time (idle and overall) and size (request and answer) are capped. A request body is sent
 *   from the chunks isomorphic-git built, without copying them into one buffer, or streamed from a
 *   file (`postFile`: a receive-pack request written to disk, so memory does not grow with it).
 *
 * Errors are a {@link GitHostError} with fixed text: never the credential, a URL query or a body.
 */
export interface GitWireExchange {
  readonly url: URL;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: readonly Uint8Array[];
  /** Instead of `body`: a request body streamed from this file (`size` bytes). */
  readonly file?: { readonly path: string; readonly size: number };
}

export interface GitWireResponse {
  readonly status: number;
  readonly statusMessage: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: AsyncIterableIterator<Uint8Array>;
}

export interface GitWireIo {
  readonly policy: ConnectorUrlPolicy;
  readonly timeoutMs: number;
  /** Milliseconds since the epoch past which the exchange is cut. */
  readonly deadlineAt: number;
  readonly maxResponseBytes: number;
}

/** Sends one checked exchange (tests may answer here instead of the network). */
export type GitWireSend = (exchange: GitWireExchange, io: GitWireIo) => Promise<GitWireResponse>;

export interface GitWireOptions {
  readonly net: GitHostNet;
  readonly target: GitHostTarget;
  /** The repository's clone URL (`cloneUrlFor`): `<base>/<org>/<name>.git`. */
  readonly repositoryUrl: string;
  readonly credential: { readonly username: string; readonly password: string };
  readonly maxRequestBytes: number;
  readonly maxResponseBytes?: number;
  readonly timeoutMs?: number;
  /** Overall deadline for every exchange through this client (ms since the epoch). */
  readonly deadlineAt?: number;
}

export const GIT_WIRE_TIMEOUT_MS = 120_000;
export const GIT_WIRE_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const SERVICES = new Set(["git-upload-pack", "git-receive-pack"]);
const USER_AGENT = "git/isomorphic-git kaiju-server";

function refused(reason: string, message: string): GitHostError {
  return new GitHostError("host_refused", message, { reason });
}

/** Only the repository's smart-HTTP endpoints, exactly. */
export function assertRepositoryEndpoint(repository: URL, url: URL): void {
  if (url.origin !== repository.origin || url.username !== "" || url.password !== "") {
    throw refused("other_host", "The request left the repository's git host.");
  }
  const root = repository.pathname.replace(/\/+$/, "");
  const rest = url.pathname.startsWith(`${root}/`) ? url.pathname.slice(root.length) : undefined;
  const query = url.search;
  const ok =
    (rest === "/info/refs" &&
      query.startsWith("?service=") &&
      SERVICES.has(query.slice("?service=".length))) ||
    ((rest === "/git-upload-pack" || rest === "/git-receive-pack") && query === "");
  if (!ok) throw refused("path", "Only the repository's git endpoints are reachable.");
}

function flat(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined) out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

async function* capped(
  res: http.IncomingMessage,
  max: number,
  done: () => void,
): AsyncIterableIterator<Uint8Array> {
  let size = 0;
  try {
    for await (const chunk of res) {
      const c = chunk as Buffer;
      size += c.length;
      if (size > max) {
        res.destroy();
        throw new GitHostError("unexpected", "The git host's answer is too large.");
      }
      yield new Uint8Array(c.buffer, c.byteOffset, c.length);
    }
  } finally {
    done();
  }
}

/** The network send: pinned to the checked address, no redirects, capped. */
export const sendGitWire: GitWireSend = (exchange, io) => {
  const { url } = exchange;
  const secure = url.protocol === "https:";
  if (!secure && !io.policy.allowHttp) {
    return Promise.reject(refused("scheme", "The git host must be reached over https."));
  }
  const transport = secure ? https : http;
  const length = exchange.file?.size ?? exchange.body.reduce((n, c) => n + c.length, 0);
  return new Promise((resolve, reject) => {
    const req = transport.request(url, {
      method: exchange.method,
      headers: {
        ...exchange.headers,
        ...(length > 0 || exchange.method === "POST" ? { "content-length": String(length) } : {}),
      },
      lookup: pinnedLookup(io.policy),
      timeout: io.timeoutMs,
      agent: false,
    });
    const left = io.deadlineAt - Date.now();
    const timer = setTimeout(
      () => req.destroy(new GitHostError("host_unreachable", "The git host took too long.")),
      Math.max(0, left),
    );
    timer.unref();
    const stop = () => clearTimeout(timer);
    req.once("timeout", () =>
      req.destroy(new GitHostError("host_unreachable", "The git host stopped answering.")),
    );
    req.once("error", (err) => {
      stop();
      reject(
        err instanceof GitHostError
          ? err
          : new GitHostError("host_unreachable", "The git host could not be reached."),
      );
    });
    req.once("response", (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        res.destroy();
        stop();
        reject(refused("redirect", "The git host answered with a redirect."));
        return;
      }
      resolve({
        status,
        statusMessage: res.statusMessage ?? "",
        headers: flat(res.headers),
        body: capped(res, io.maxResponseBytes, stop),
      });
    });
    void (async () => {
      if (exchange.file) {
        await pipeline(createReadStream(exchange.file.path), req);
        return;
      }
      for (const chunk of exchange.body) {
        if (!req.write(chunk)) await new Promise((r) => req.once("drain", r));
      }
      req.end();
    })().catch((err: unknown) => req.destroy(err as Error));
  });
};

async function chunksOf(
  body: GitHttpRequest["body"],
  max: number,
): Promise<{ chunks: Uint8Array[]; size: number }> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (!body) return { chunks, size };
  for await (const c of body as AsyncIterable<Uint8Array>) {
    size += c.length;
    if (size > max) {
      throw new GitHostError(
        "invalid_request",
        "The push is larger than this conversion may send.",
      );
    }
    chunks.push(c);
  }
  return { chunks, size };
}

/** A session for one repository: isomorphic-git's client, and a POST streamed from a file. */
export interface GitWireSession {
  readonly http: HttpClient;
  /** POSTs `size` bytes from `file` to one of the repository's endpoints; the answer read whole. */
  postFile(
    url: string,
    file: string,
    size: number,
    contentType: string,
  ): Promise<{ status: number; body: Buffer }>;
}

/** The client for one repository under the rules in the module header. */
export function gitWireClient(options: GitWireOptions): HttpClient {
  return gitWireSession(options).http;
}

/** {@link gitWireClient} plus {@link GitWireSession.postFile}, under the same rules. */
export function gitWireSession(options: GitWireOptions): GitWireSession {
  assertGitHostTarget(options.target);
  const repository = new URL(options.repositoryUrl);
  assertRequestHost(options.target, repository);
  const authorization = `Basic ${Buffer.from(
    `${options.credential.username}:${options.credential.password}`,
  ).toString("base64")}`;
  const timeoutMs = options.timeoutMs ?? GIT_WIRE_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? GIT_WIRE_MAX_RESPONSE_BYTES;
  const send = options.net.wire ?? sendGitWire;
  const io = (deadlineAt: number) => ({
    policy: options.net.policy,
    timeoutMs,
    deadlineAt,
    maxResponseBytes,
  });

  /** The checks every request passes before anything is sent; returns its deadline. */
  async function check(url: URL): Promise<number> {
    const deadlineAt = options.deadlineAt ?? Date.now() + timeoutMs;
    if (Date.now() >= deadlineAt) {
      throw new GitHostError("host_unreachable", "The git host took too long.");
    }
    assertRepositoryEndpoint(repository, url);
    assertRequestHost(options.target, url);
    const checked = await checkConnectorUrl(`${url.origin}${url.pathname}`, options.net.policy);
    if (!checked.ok) {
      if (checked.code === "host_unresolvable") {
        throw new GitHostError("host_unreachable", "The git host name does not resolve.");
      }
      throw refused(checked.code, "The git host address is not allowed on this site.");
    }
    return deadlineAt;
  }

  async function request(req: GitHttpRequest): Promise<GitHttpResponse> {
    const url = new URL(req.url);
    const deadlineAt = await check(url);
    const { chunks } = await chunksOf(req.body, options.maxRequestBytes);
    const headers: Record<string, string> = { "user-agent": USER_AGENT };
    for (const [k, v] of Object.entries(req.headers ?? {})) {
      const name = k.toLowerCase();
      if (name === "authorization" || name === "content-length" || name === "host") continue;
      headers[name] = v;
    }
    headers.authorization = authorization;
    const method = req.method ?? "GET";
    const res = await send({ url, method, headers, body: chunks }, io(deadlineAt));
    return {
      url: req.url,
      method,
      statusCode: res.status,
      statusMessage: res.statusMessage,
      headers: { ...res.headers },
      body: res.body,
    };
  }

  async function postFile(raw: string, file: string, size: number, contentType: string) {
    const url = new URL(raw);
    const deadlineAt = await check(url);
    if (size > options.maxRequestBytes) {
      throw new GitHostError(
        "invalid_request",
        "The push is larger than this conversion may send.",
      );
    }
    const headers = {
      "user-agent": USER_AGENT,
      "content-type": contentType,
      accept: contentType.replace("-request", "-result"),
      authorization,
    };
    const res = await send(
      { url, method: "POST", headers, body: [], file: { path: file, size } },
      io(deadlineAt),
    );
    const chunks: Buffer[] = [];
    for await (const c of res.body) chunks.push(Buffer.from(c));
    return { status: res.status, body: Buffer.concat(chunks) };
  }

  return { http: { request }, postFile };
}
