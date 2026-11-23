import { z } from "zod";
import { count, egressDomain, event, id, type AuditEventDef } from "./fragments.js";

/** `org/repo` as the egress proxy's git grammar accepts it (KOBE-763). */
const gitRepository = z
  .string()
  .max(201)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9._-]{1,100}$/);
const gitService = z.enum(["upload-pack", "receive-pack"]);
/** Reasons the egress proxy records for git requests (KOBE-763). */
const GIT_PROXY_REASONS = [
  "git_refused",
  "credentials_in_request",
  "rate_limited",
  "upstream_auth",
  "redirect_refused",
  "secret_reflected",
  // KOBE-763 review: compressed bodies are never relayed or forwarded for git; stalled receivers.
  "encoded_response",
  "encoded_request",
  "buffer_limit",
] as const;
/** Codes of the server's git transport decision (services/server/src/git/transport.ts). */
export const GIT_TRANSPORT_DENY_CODES = [
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

export const EGRESS_EVENTS = {
  // ── egress: ceiling (site), enablement (team), connections (team; KOBE-38, D28) ──
  "egress.ceiling.added": event("site", { domain: egressDomain }),
  /** A ceiling domain (preset or custom) was put into or taken out of the ceiling. */
  "egress.ceiling.changed": event("site", { domain: egressDomain, inCeiling: z.boolean() }),
  /** A custom domain was deleted; every team's enablement of it went with it. */
  "egress.ceiling.removed": event("site", { domain: egressDomain }),
  /** A ceiling pattern was marked internal (same cluster, EA4) or no longer (KOBE-602). */
  "egress.ceiling.internal_changed": event("site", {
    domain: egressDomain,
    internal: z.boolean(),
  }),
  "egress.domain.enabled": event("team", { domain: egressDomain }),
  /** `headersRemoved`: the domain's injected headers (KOBE-39) were deleted with it. */
  "egress.domain.disabled": event("team", {
    domain: egressDomain,
    headersRemoved: z.literal(true).optional(),
  }),
  /**
   * Request access (KOBE-39, D28): a member asked the team's admins to enable `pattern` after a
   * blocked request to `domain` (thread metadata only: the thread id; never a URL or prompt).
   * `scope` (KOBE-602, EA1): `team` (in the ceiling: team admins notified) or `site` (outside it,
   * or an internal address: site admins notified); `internal`: the block was an internal address.
   */
  "egress.request.created": event("team", {
    requestId: id,
    domain: egressDomain,
    pattern: egressDomain,
    threadId: id.optional(),
    notified: count,
    scope: z.enum(["team", "site"]).optional(),
    internal: z.literal(true).optional(),
  }),
  /**
   * A team or site admin approved (enabled the pattern) or denied it; `requests` pending ones
   * settled. KOBE-602: `by` says which role decided; a site admin's approval may name another
   * `pattern` than the request's (`requested`) and add it to the ceiling (the ceiling events go
   * with it); `internal` when it marked the pattern internal.
   */
  "egress.request.decided": event("team", {
    requestId: id,
    pattern: egressDomain,
    requested: egressDomain.optional(),
    decision: z.enum(["approved", "denied"]),
    requests: z.number().int().positive(),
    /** Approved and the pattern was not enabled yet (an `egress.domain.enabled` row goes with it). */
    enabled: z.boolean(),
    by: z.enum(["team_admin", "site_admin"]).optional(),
    internal: z.literal(true).optional(),
  }),
  /** Header injection (KOBE-39) set or replaced for an enabled domain: names only, never values. */
  "egress.header.set": event("team", {
    domain: egressDomain,
    headerNames: z
      .array(z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/))
      .min(1)
      .max(8),
  }),
  "egress.header.cleared": event("team", { domain: egressDomain }),
  /**
   * Sandbox connections through the egress proxy (actor: system), aggregated per (user, sandbox,
   * host, outcome, reason) over a short window: high volume, so one row per key and window, every
   * connection counted in exactly one row (D28 "every connection is logged"). `domain` is absent
   * when the target was not a host name (IP literal, junk).
   */
  /**
   * The server's own site-job connections through the egress proxy (KOBE-343: the catalog's git
   * mirror; actor: system), aggregated like `egress.connection`: the job, never a token.
   */
  "egress.site_connection": event("site", {
    job: z.enum(["skill-mirror", "skill-import"]),
    domain: egressDomain.optional(),
    port: z.number().int().min(1).max(65535).optional(),
    outcome: z.enum(["allowed", "blocked", "failed"]),
    reason: z
      .enum([
        "not_in_ceiling",
        "forbidden_address",
        "sni_mismatch",
        "invalid_target",
        "port_not_allowed",
        "connection_limit",
        "dns_failure",
        "upstream_unreachable",
        "policy_unavailable",
      ])
      .optional(),
    aggregated: z.literal(true).optional(),
    connections: z.number().int().positive(),
    bytesUp: count,
    bytesDown: count,
    from: z.iso.datetime(),
    to: z.iso.datetime(),
  }),
  /**
   * A push (git-receive-pack) through the egress proxy to a connected organization (KOBE-763, spec
   * G11; actor: system): one row per push, allowed or refused. `refs` are read from the push's
   * command list (never the pack); `connectionId` is set when the server matched a connection.
   * Never a credential, URL query or body.
   */
  "egress.git_push": event("team", {
    userId: id,
    sandboxId: id,
    connectionId: id.optional(),
    domain: egressDomain,
    repository: gitRepository,
    outcome: z.enum(["allowed", "blocked", "failed"]),
    reason: z
      .enum([
        ...GIT_TRANSPORT_DENY_CODES,
        ...GIT_PROXY_REASONS,
        "request_too_large",
        "forbidden_address",
        "not_in_ceiling",
        "inactive_member",
        "policy_unavailable",
        "connection_limit",
        "dns_failure",
        "upstream_unreachable",
        "upstream_tls",
        "upstream_timeout",
        "response_too_large",
      ])
      .optional(),
    refs: z
      .array(
        z.strictObject({
          ref: z.string().regex(/^refs\/[A-Za-z0-9._/@+-]{1,250}$/),
          change: z.enum(["create", "update", "delete"]),
        }),
      )
      .max(50)
      .optional(),
    refsTruncated: z.literal(true).optional(),
    /** The host's HTTP status when the push reached it. */
    status: z.number().int().min(100).max(599).optional(),
    bytesUp: count,
  }),
  "egress.connection": event("team", {
    userId: id,
    sandboxId: id,
    domain: egressDomain.optional(),
    port: z.number().int().min(1).max(65535).optional(),
    outcome: z.enum(["allowed", "blocked", "failed"]),
    reason: z
      .enum([
        "not_enabled",
        "not_in_ceiling",
        "forbidden_address",
        "sni_mismatch",
        "invalid_target",
        "port_not_allowed",
        "plain_http",
        "connection_limit",
        "dns_failure",
        "upstream_unreachable",
        "policy_unavailable",
        "inactive_member",
        // KOBE-39 header injection (plain HTTP upgraded to verified HTTPS by the proxy).
        "headers_required",
        "upstream_tls",
        "upstream_timeout",
        "request_too_large",
        "response_too_large",
        // KOBE-763 git smart-HTTP for connected organizations.
        ...GIT_PROXY_REASONS,
      ])
      .optional(),
    /** Plain HTTP the proxy upgraded to HTTPS with the team's injected headers (KOBE-39). */
    upgraded: z.literal(true).optional(),
    /** Git smart-HTTP to a connected organization (KOBE-763): the repository and service. */
    repository: gitRepository.optional(),
    gitService: gitService.optional(),
    /**
     * Set when the row collapses hosts beyond the sandbox's rate of distinct hosts (random-name
     * floods): `domain` is then absent and `connections` counts them all.
     */
    aggregated: z.literal(true).optional(),
    connections: z.number().int().positive(),
    bytesUp: count,
    bytesDown: count,
    from: z.iso.datetime(),
    to: z.iso.datetime(),
  }),
} as const satisfies Record<string, AuditEventDef>;
