import { z } from "zod";
import type { GitRequest } from "./grammar.js";

/**
 * The server's decision for one git request (KOBE-763, spec G11/G12): the egress proxy asks, the
 * server decides (connection, Site, access level, the member's role, the Repo's project role) and
 * mints the per-repository credential with the provider adapter. The proxy holds the credential
 * in memory only, for at most {@link ALLOW_TTL_MS} (less when it expires sooner), and never logs
 * it. It never reads the sealed credential or the sealing key.
 *
 * POST <server internal>/internal/v1/git/transport
 *   Authorization: Bearer <egress proxy internal key>
 *   Kobe-Sandbox-Token: <the sandbox's own kobe.egress-proxy token>
 *   {host, prefix, owner, repository, service}
 */

const BASE_PATH = /^(\/[A-Za-z0-9._-]{1,100}){0,8}$/;

const allowSchema = z.strictObject({
  decision: z.literal("allow"),
  connection_id: z.uuid(),
  base_path: z
    .string()
    .max(1024)
    .regex(BASE_PATH)
    .refine((p) => !/(^|\/)\.\.?(\/|$)/.test(p)),
  organization: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/),
  repository: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,100}$/)
    .refine((r) => r !== "." && r !== ".." && !/\.git$/i.test(r)),
  access: z.enum(["read", "write"]),
  username: z.string().min(1).max(256),
  password: z.string().min(1).max(4096),
  expires_at: z.iso.datetime().nullable(),
  narrowed: z.boolean(),
  push_limit_bytes: z.number().int().positive(),
});

export const GIT_DENY_CODES = [
  "no_connection",
  "outside_organization",
  "connection_off",
  "read_only",
  "role_reader",
  "project_reader",
  "agents_restricted",
  "eval_sandbox",
  "site_refused",
  "repository_unavailable",
  "credential_forbidden",
  "credential_rejected",
  "credential_unavailable",
  "host_unavailable",
  "host_rate_limited",
] as const;
export type GitDenyCode = (typeof GIT_DENY_CODES)[number];

const denySchema = z.strictObject({
  decision: z.literal("deny"),
  code: z.enum(GIT_DENY_CODES),
  message: z.string().max(300),
});

const answerSchema = z.discriminatedUnion("decision", [allowSchema, denySchema]);

export type GitAllow = z.infer<typeof allowSchema>;
export type GitDeny = z.infer<typeof denySchema>;
export type GitDecision =
  | GitAllow
  | GitDeny
  /** The server could not be asked or refused the caller (auth, rate): no credential. */
  | { readonly decision: "error"; readonly status: 401 | 429 | 503 };

export interface GitDecisionQuery {
  readonly teamId: string;
  readonly userId: string;
  readonly sandboxId: string;
  /** The sandbox's own egress token: the server verifies it itself. Never logged. */
  readonly token: string;
  readonly host: string;
  readonly request: GitRequest;
}

export type GitDecider = (query: GitDecisionQuery) => Promise<GitDecision>;

export interface ServerDeciderOptions {
  /** The server's internal listener, e.g. `http://kobe-server:8082`. */
  readonly serverUrl: string;
  readonly internalKey: string;
  readonly timeoutMs: number;
  readonly fetch?: typeof fetch;
}

/** Asks the server's internal listener. Any failure is an `error` (fail closed). */
export function serverDecider(options: ServerDeciderOptions): GitDecider {
  const doFetch = options.fetch ?? fetch;
  const url = `${options.serverUrl.replace(/\/+$/, "")}/internal/v1/git/transport`;
  return async (query) => {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.internalKey}`,
          "kobe-sandbox-token": query.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          host: query.host,
          prefix: query.request.prefix,
          owner: query.request.owner,
          repository: query.request.repository,
          service: query.request.service,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch {
      return { decision: "error", status: 503 };
    }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel();
      return { decision: "error", status: 401 };
    }
    if (res.status === 429) {
      await res.body?.cancel();
      return { decision: "error", status: 429 };
    }
    if (res.status !== 200) {
      await res.body?.cancel();
      return { decision: "error", status: 503 };
    }
    try {
      const parsed = answerSchema.safeParse(await res.json());
      return parsed.success ? parsed.data : { decision: "error", status: 503 };
    } catch {
      return { decision: "error", status: 503 };
    }
  };
}

/** An allow is reused for at most this long (and never within a minute of expiry). */
export const ALLOW_TTL_MS = 30_000;
/** A deny is remembered this long (so a looping client does not hammer the server). */
export const DENY_TTL_MS = 5_000;
const EXPIRY_MARGIN_MS = 60_000;

interface Cached {
  readonly value: GitAllow | GitDeny;
  readonly until: number;
}

export interface DecisionCacheOptions {
  readonly maxEntries: number;
  readonly now?: () => number;
}

/**
 * Decisions (and the credential they carry) cached briefly per (team, user, sandbox, host, base
 * path, organization, repository, service): a clone or push makes two requests in a row. Bounded
 * (least recently used first out). A connection removed or its credential replaced is seen within
 * {@link ALLOW_TTL_MS}; a credential the host refuses is dropped at once ({@link forget}).
 */
export class GitDecisionCache {
  private readonly entries = new Map<string, Cached>();
  private readonly now: () => number;

  constructor(
    private readonly decide: GitDecider,
    private readonly options: DecisionCacheOptions,
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  static keyOf(q: Omit<GitDecisionQuery, "token">): string {
    const r = q.request;
    return [
      q.teamId,
      q.userId,
      q.sandboxId,
      q.host,
      r.prefix,
      r.owner.toLowerCase(),
      r.repository.toLowerCase(),
      r.service,
    ].join("|");
  }

  get size(): number {
    return this.entries.size;
  }

  /** Whether a live decision is cached for the query (no server call, no host API call). */
  has(query: Omit<GitDecisionQuery, "token">): boolean {
    const hit = this.entries.get(GitDecisionCache.keyOf(query));
    return hit !== undefined && hit.until > this.now();
  }

  async get(query: GitDecisionQuery): Promise<GitDecision> {
    const key = GitDecisionCache.keyOf(query);
    const now = this.now();
    const hit = this.entries.get(key);
    if (hit && hit.until > now) {
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit.value;
    }
    if (hit) this.entries.delete(key);
    const value = await this.decide(query);
    if (value.decision === "error") return value;
    const until =
      value.decision === "allow"
        ? Math.min(
            now + ALLOW_TTL_MS,
            value.expires_at === null
              ? Number.POSITIVE_INFINITY
              : Date.parse(value.expires_at) - EXPIRY_MARGIN_MS,
          )
        : now + DENY_TTL_MS;
    if (until > now) {
      this.entries.set(key, { value, until });
      while (this.entries.size > this.options.maxEntries) {
        const oldest = this.entries.keys().next().value;
        if (oldest === undefined) break;
        this.entries.delete(oldest);
      }
    }
    return value;
  }

  /** Drops a decision (the host refused its credential). */
  forget(query: Omit<GitDecisionQuery, "token">): void {
    this.entries.delete(GitDecisionCache.keyOf(query));
  }

  /** Drops everything (a change hint for the team, or shutdown). */
  clear(): void {
    this.entries.clear();
  }
}
