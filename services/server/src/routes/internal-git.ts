import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { logger } from "../logger.js";
import { decideGitTransport, type GitTransportDeps } from "../git/transport.js";
import { authenticateSandbox, type McpAuthDeps } from "../mcp/principal.js";
import { createRateLimiter, type RateLimiter } from "../sandbox/rate-limit.js";
import { invalidRequest, notFound, readJson } from "../http/request.js";

/**
 * The egress proxy's git decisions on the server's internal listener (KOBE-763, spec
 * workspace-git G11/G12). Only the egress proxy's pods reach the port (NetworkPolicy) and every
 * request carries the egress proxy's own internal key (a different key from the MCP proxy's, so
 * neither proxy can call the other's routes). The caller is the sandbox's own `kobe.egress-proxy`
 * session token (`Kaiju-Sandbox-Token`), verified here with liveness and membership: the proxy
 * cannot ask for a sandbox whose token it has not seen.
 *
 * POST /internal/v1/git/transport `{host, prefix, owner, repository, service}`
 *   → 200 `{decision: "allow", connection_id, base_path, organization, repository, access,
 *          username, password, expires_at, narrowed, push_limit_bytes}` (the credential: for the
 *          proxy's upstream request only; never logged, audited or returned anywhere else)
 *   | 200 `{decision: "deny", code, message}` (`no_connection`: not a connected organization's
 *          path, the proxy treats the request as ordinary egress)
 * 401 `unauthorized` (internal key) | `sandbox_unauthorized` (token, liveness, membership),
 * 400 `invalid_request`, 429 `rate_limited` (per sandbox, {@link GIT_DECIDE_RATE}).
 */
export const GIT_INTERNAL_BODY_LIMIT = 4 * 1024;
/** Decisions per sandbox per server replica: a backstop behind the proxy's own limit and cache. */
export const GIT_DECIDE_RATE = { capacity: 60, refillPerSecond: 5 } as const;

const FORWARDED_HEADERS = ["x-forwarded-for", "x-forwarded-host", "x-real-ip", "forwarded"];

const bodySchema = z.strictObject({
  host: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/),
  prefix: z
    .string()
    .max(1024)
    .regex(/^(\/[A-Za-z0-9._-]{1,100}){0,8}$/)
    .refine((p) => !/(^|\/)\.\.?(\/|$)/.test(p)),
  owner: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/),
  repository: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,100}$/)
    .refine((r) => r !== "." && r !== ".." && !/\.git$/i.test(r)),
  service: z.enum(["git-upload-pack", "git-receive-pack"]),
});

export interface InternalGitDeps {
  /** The egress proxy's internal key (chart-generated Secret), at least 32 characters. */
  readonly internalKey: string;
  /** Verifies `kobe.egress-proxy` tokens (audience `kobe.egress-proxy`, its keys). */
  readonly auth: McpAuthDeps;
  readonly transport: GitTransportDeps;
  readonly limiter?: RateLimiter;
}

const digest = (value: string) => createHash("sha256").update(value).digest();

export function createInternalGitRoutes(deps: InternalGitDeps): Hono {
  if (deps.internalKey.length < 32) {
    throw new Error("the egress proxy internal key must be at least 32 characters");
  }
  if (deps.auth.audience !== "kobe.egress-proxy") {
    throw new Error("git decisions verify kobe.egress-proxy tokens");
  }
  const keyDigest = digest(`Bearer ${deps.internalKey}`);
  const limiter = deps.limiter ?? createRateLimiter(GIT_DECIDE_RATE);
  const git = new Hono();
  git.use(async (c, next) => {
    if (FORWARDED_HEADERS.some((h) => c.req.header(h) !== undefined)) {
      return notFound(c, "not_found", "Not found.");
    }
    if (!timingSafeEqual(digest(c.req.header("authorization") ?? ""), keyDigest)) {
      return c.json({ code: "unauthorized", message: "Internal key required." }, 401);
    }
    c.header("Cache-Control", "no-store");
    await next();
  });
  git.use(
    bodyLimit({
      maxSize: GIT_INTERNAL_BODY_LIMIT,
      onError: (c) => c.json({ code: "invalid_request", message: "Body too large." }, 413),
    }),
  );

  git.post("/transport", async (c) => {
    const body = bodySchema.safeParse(await readJson(c, null));
    if (!body.success) return invalidRequest(c, "Invalid git request.");
    const auth = await authenticateSandbox(deps.auth, c.req.header("kobe-sandbox-token"));
    if (!auth.ok) {
      logger.info({ code: auth.code }, "git transport: sandbox token refused");
      return c.json({ code: "sandbox_unauthorized", message: auth.code }, 401);
    }
    const wait = limiter.take(auth.principal.sandboxId);
    if (wait > 0) {
      c.header("Retry-After", String(Math.ceil(wait / 1000)));
      return c.json({ code: "rate_limited", message: "Too many git requests." }, 429);
    }
    const answer = await decideGitTransport(deps.transport, auth.principal, body.data);
    // Metadata only: never the credential.
    logger.info(
      {
        team: auth.principal.teamId,
        sandbox: auth.principal.sandboxId,
        host: body.data.host,
        service: body.data.service,
        decision: answer.decision,
        ...(answer.decision === "deny" ? { code: answer.code } : {}),
      },
      "git transport decision",
    );
    return c.json(answer);
  });
  return git;
}
