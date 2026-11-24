import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { normalizeHost, type InjectedHeader } from "@kaiju/db";
import type { EgressDecision } from "./allowlist.js";
import { authenticate, presentedToken } from "./auth.js";
import { handleGit } from "./git/handle.js";
import { matchGitRequest } from "./git/grammar.js";
import { exchange, type PlainTarget } from "./upgrade-exchange.js";
import { reply } from "./upgrade-reply.js";
import type { UpgradeAttempt, UpgradeContext } from "./upgrade-types.js";

export type { HeaderOpener, UpgradeSettings } from "./proxy-deps.js";
export type { UpgradeAttempt, UpgradeContext } from "./upgrade-types.js";
export {
  downstreamHeaders,
  rewriteLocation,
  secretParts,
  upstreamHeaders,
} from "./upgrade-headers.js";

/**
 * Header injection by upgrade (spec D28, KOBE-39; user decision 2026-10-03). For a domain whose team
 * configured injected headers (e.g. a private package index's token), the sandbox sends a plain
 * HTTP proxy request (`GET http://pkgs.example.com/simple/ HTTP/1.1` with its egress token in
 * `Proxy-Authorization`). The proxy
 *
 * 1. authenticates the token and checks active membership and the allowlist, exactly as for
 *    CONNECT (a refusal is the same `egress.blocked` with request access);
 * 2. requires header rules for the matched pattern (plain HTTP to anything else stays refused);
 * 3. resolves the host once, refuses internal addresses (rebinding gains nothing), connects to the
 *    checked address on 443 and does TLS **itself**, with SNI = the host and the certificate
 *    verified against it (system CAs): there is no TLS interception and no Kaiju CA;
 * 4. strips hop-by-hop headers, `Proxy-*` and any client header named like an injected one, sets
 *    `Host`, adds the team's headers (opened here, never sent to the sandbox), and relays the
 *    response with size, time and bandwidth limits;
 * 5. rewrites a redirect to the same host's `https://` URL into `http://` (so the next request
 *    comes back here and is re-checked and re-injected); a redirect to another host is passed on
 *    untouched: the client's next request goes through the proxy again and is checked for that
 *    host like any other (the injected headers are never sent anywhere but their own host).
 *
 * Responses never carry the injected values back in headers: a response header containing one is
 * dropped. A response body is the upstream's own (see docs/install.md for that trust boundary).
 * Header filtering: upgrade-headers.ts; the TLS connection and relay: upgrade-exchange.ts.
 */

/** Methods relayed; TRACE (reflects the injected headers), CONNECT and the rest are refused. */
export const UPGRADE_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);
const REALM = 'Basic realm="kobe-egress"';

type TargetResult =
  | { readonly ok: true; readonly target: PlainTarget }
  | { readonly ok: false; readonly host: string | undefined; readonly why: string };

/** `http://host[:80]/path?query` (absolute-form), host a name: anything else is refused. */
export function parsePlainTarget(raw: string | undefined): TargetResult {
  if (!raw || raw.length > 8192 || !/^http:\/\//i.test(raw)) {
    return { ok: false, host: undefined, why: "only http:// absolute URLs" };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, host: undefined, why: "not a URL" };
  }
  const literal = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  const host = isIP(literal) === 0 ? normalizeHost(url.hostname) : null;
  if (url.username !== "" || url.password !== "") {
    return { ok: false, host: host ?? undefined, why: "credentials in the URL" };
  }
  if (host === null) return { ok: false, host: undefined, why: "a host name is required" };
  if (url.port !== "" && url.port !== "80") {
    return { ok: false, host, why: "plain HTTP uses the default port" };
  }
  return { ok: true, target: { host, path: `${url.pathname}${url.search}` } };
}

/** Handles one absolute-form (plain HTTP) proxy request. */
export async function handlePlainHttp(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: UpgradeContext,
): Promise<void> {
  const { deps } = ctx;
  const started = Date.now();
  const auth = authenticate(req.headers["proxy-authorization"], deps.verify);
  if (!auth.ok) {
    ctx.authRefused(req.socket.remoteAddress ?? "unknown", auth.reason);
    reply(
      res,
      407,
      "Proxy Authentication Required",
      "Kaiju egress proxy: send the sandbox's egress session token.",
      { "proxy-authenticate": REALM },
    );
    return;
  }
  const identity = auth.identity;
  deps.preauth?.authenticated(req.socket);
  const parsed = parsePlainTarget(req.url);
  const attempt: UpgradeAttempt = {
    identity,
    host: parsed.ok ? parsed.target.host : parsed.host,
    port: 80,
    started,
  };
  const release = deps.connections.tryAcquire(identity.sandboxId);
  if (!release) {
    ctx.finish(attempt, "blocked", "connection_limit");
    reply(
      res,
      429,
      "Kaiju egress: too many connections",
      "Kaiju egress: this sandbox has too many open connections; close some and retry.",
    );
    return;
  }
  try {
    if (!parsed.ok) {
      ctx.finish(attempt, "blocked", "invalid_target");
      reply(
        res,
        403,
        "Kaiju egress blocked: invalid target",
        `Kaiju egress: plain HTTP needs an http://<host name>/ URL (${parsed.why}).`,
      );
      return;
    }
    if (!UPGRADE_METHODS.has(req.method ?? "")) {
      ctx.finish(attempt, "blocked", "invalid_target");
      reply(
        res,
        405,
        "Kaiju egress: method not allowed",
        "Kaiju egress: only GET, HEAD, POST, PUT, PATCH, DELETE and OPTIONS are relayed.",
      );
      return;
    }
    // KOBE-763: git smart-HTTP to a connected organization gets the Workspace's credential;
    // anything else (including a host with no connection) continues as ordinary egress.
    if (deps.git) {
      const git = matchGitRequest(req.method ?? "", req.url ?? "");
      if (git.kind === "invalid") {
        ctx.finish(attempt, "blocked", "invalid_target");
        reply(
          res,
          400,
          "Kaiju egress blocked: not a git smart-HTTP request",
          `Kaiju egress: this looks like a git request but is not one Kaiju relays (${git.why}).`,
        );
        return;
      }
      const token = presentedToken(req.headers["proxy-authorization"]);
      if (git.kind === "git" && token !== undefined) {
        const handled = await handleGit({
          req,
          res,
          ctx,
          git: deps.git,
          attempt,
          host: parsed.target.host,
          request: git.request,
          token,
        });
        if (handled === "handled") return;
      }
    }
    await upgrade(req, res, ctx, attempt, parsed.target);
  } finally {
    release();
  }
}

async function decideFor(
  ctx: UpgradeContext,
  res: ServerResponse,
  attempt: UpgradeAttempt,
  host: string,
): Promise<{ pattern: string; internal: boolean; sealed: string | undefined } | undefined> {
  const { deps } = ctx;
  const { identity } = attempt;
  let decision: EgressDecision;
  let sealed: string | undefined;
  try {
    if (!(await deps.policy.isActiveMember(identity.teamId, identity.userId))) {
      ctx.finish(attempt, "blocked", "inactive_member");
      reply(
        res,
        403,
        "Kaiju egress blocked: not an active team member",
        "Kaiju egress: this sandbox's user is not an active member of its team.",
      );
      return undefined;
    }
    decision = await deps.policy.decide(identity.teamId, host);
    sealed =
      decision.allowed && deps.policy.sealedHeaders
        ? await deps.policy.sealedHeaders(identity.teamId, decision.pattern)
        : undefined;
  } catch (err) {
    deps.logger.error({ err, team: identity.teamId }, "egress allowlist unavailable");
    ctx.finish(attempt, "failed", "policy_unavailable");
    reply(
      res,
      503,
      "Kaiju egress: allowlist unavailable",
      "Kaiju egress: the allowlist could not be read; try again shortly.",
    );
    return undefined;
  }
  if (!decision.allowed) {
    const enabled = decision.reason === "not_enabled";
    ctx.finish(attempt, "blocked", decision.reason);
    // EA1: both reasons can be fixed by a request (team admins, or site admins off the ceiling).
    ctx.report(attempt, decision.reason, true);
    if (enabled) {
      reply(
        res,
        403,
        `Kaiju egress blocked: ${host} is not enabled for this team`,
        `Kaiju egress: ${host} is not enabled for this team. A team admin can enable it (Request access).`,
      );
    } else {
      reply(
        res,
        403,
        `Kaiju egress blocked: ${host} is not allowed on this site`,
        `Kaiju egress: ${host} is not in this site's egress ceiling; a site admin must add it first (Request access).`,
      );
    }
    return undefined;
  }
  return { pattern: decision.pattern, internal: decision.internal === true, sealed };
}

async function upgrade(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: UpgradeContext,
  attempt: UpgradeAttempt,
  target: PlainTarget,
): Promise<void> {
  const { deps } = ctx;
  const { identity } = attempt;
  const { host } = target;
  const decided = await decideFor(ctx, res, attempt, host);
  if (!decided) return;
  // Headers are bound to exactly one host: a wildcard pattern would let the sandbox send them to
  // any subdomain it controls (the API refuses them too; this also disarms any older row).
  const exact = decided.pattern === host;
  if (decided.sealed === undefined || !exact || !deps.headers || !deps.upgrade) {
    // Plain HTTP exists only to carry a team's injected headers; everything else is HTTPS.
    ctx.finish(attempt, "blocked", "plain_http");
    reply(
      res,
      403,
      "Kaiju egress blocked: plain HTTP is not allowed",
      "Kaiju egress: only HTTPS (CONNECT) is allowed; use an https:// URL.",
    );
    return;
  }
  let injected: InjectedHeader[];
  try {
    injected = deps.headers.open(identity.teamId, decided.pattern, decided.sealed);
  } catch (err) {
    deps.logger.error(
      { err: (err as Error).message, team: identity.teamId, host },
      "egress injected headers do not open (wrong or rotated secret?)",
    );
    ctx.finish(attempt, "failed", "policy_unavailable");
    reply(
      res,
      503,
      "Kaiju egress: header injection unavailable",
      "Kaiju egress: the team's headers for this domain could not be read; ask a team admin to set them again.",
    );
    return;
  }
  const limits = deps.upgrade;
  const declared = req.headers["content-length"];
  const length = declared === undefined ? undefined : Number(declared);
  if (length !== undefined && (!Number.isSafeInteger(length) || length > limits.maxRequestBytes)) {
    ctx.finish(attempt, "blocked", "request_too_large");
    reply(
      res,
      413,
      "Kaiju egress: request too large",
      `Kaiju egress: request bodies are limited to ${limits.maxRequestBytes} bytes.`,
    );
    return;
  }

  const detach = deps.bandwidth.attach(identity.sandboxId);
  try {
    let addresses: string[];
    try {
      addresses = await deps.resolve(host);
    } catch {
      ctx.finish(attempt, "failed", "dns_failure");
      reply(
        res,
        502,
        `Kaiju egress: cannot resolve ${host}`,
        `Kaiju egress: ${host} does not resolve.`,
      );
      return;
    }
    // EA4: internal targets only for a host whose matching pattern is internal.
    if (deps.addresses.checkAll(addresses, { internal: decided.internal }) !== "allowed") {
      ctx.finish(attempt, "blocked", "forbidden_address");
      ctx.report(attempt, "forbidden_address", true);
      reply(
        res,
        403,
        `Kaiju egress blocked: ${host} resolves to an internal address`,
        `Kaiju egress: ${host} resolves to an internal or reserved address, which sandboxes may not reach unless a site admin marks it internal (Request access).`,
      );
      return;
    }
    await exchange(req, res, ctx, attempt, target, addresses, injected, length);
  } finally {
    detach();
  }
}
