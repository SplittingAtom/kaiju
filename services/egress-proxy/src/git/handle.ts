import type { IncomingMessage, ServerResponse } from "node:http";
import { SYSTEM_ACTOR, type AuditEvent } from "@kobe/db";
import type { ConnectionReason, GitTraffic } from "../connection-audit.js";
import { reply } from "../upgrade-reply.js";
import type { UpgradeAttempt, UpgradeContext } from "../upgrade-types.js";
import type { GitAllow, GitDecision, GitDecisionQuery } from "./decisions.js";
import { accessOf, type GitRequest } from "./grammar.js";
import { relayGit } from "./relay.js";
import type { GitTransportDeps } from "./types.js";
import { CREDENTIAL_HEADERS, type PushedRef } from "./wire.js";

/**
 * Git smart-HTTP for a Workspace's connected organizations (spec workspace-git G11/G12, §9;
 * KOBE-763). The sandbox's git sends plain-HTTP proxy requests (`http://<host>/<org>/<repo>.git/…`,
 * configured by the sandbox agent, GIT-8) with its egress token; for a request in the strict git
 * grammar (grammar.ts) the proxy
 *
 * 1. refuses a request carrying its own Authorization or Cookie (the sandbox has no credential and
 *    must not bring one), applies the per-sandbox git rate and concurrency limits;
 * 2. checks active membership and the site egress ceiling (the Site's egress rules, G3; the
 *    Workspace's connection stands in for the team's own enablement);
 * 3. asks the server, which decides (connection for this host, base path and organization, Site
 *    git settings, access level, the member's role, a Repo's project role) and mints the
 *    per-repository credential; `no_connection` means "not a connected organization's path" and
 *    the request continues as ordinary egress (no credential), any other refusal is answered here
 *    with the server's message;
 * 4. resolves the host itself, refuses internal addresses unless the ceiling pattern is internal,
 *    and relays over verified TLS to the checked address (relay.ts).
 *
 * Every git request is counted in the aggregated egress audit with its repository and service; a
 * push also writes one `egress.git_push` row (refs from its command list).
 */
export type GitHandled = "handled" | "not_connected";

interface GitCall {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly ctx: UpgradeContext;
  readonly git: GitTransportDeps;
  readonly attempt: UpgradeAttempt;
  readonly host: string;
  readonly request: GitRequest;
  readonly token: string;
}

const serviceOf = (request: GitRequest): GitTraffic["service"] =>
  request.service === "git-receive-pack" ? "receive-pack" : "upload-pack";

export async function handleGit(call: GitCall): Promise<GitHandled> {
  const { ctx, git, request } = call;
  const attempt: UpgradeAttempt = {
    ...call.attempt,
    git: {
      repository: `${request.owner}/${request.repository}`,
      service: serviceOf(request),
    },
  };
  const sandboxId = attempt.identity.sandboxId;
  const refuse = (
    reason: ConnectionReason,
    status: number,
    message: string,
    pushReason: string = reason,
  ) => {
    ctx.finish(attempt, "blocked", reason);
    recordPush(call, attempt, "blocked", pushReason);
    reply(call.res, status, `Kobe egress: git request refused`, message);
  };
  if (!git.rate.take(sandboxId)) {
    refuse(
      "rate_limited",
      429,
      "Kobe egress: too many git requests from this sandbox; retry shortly.",
    );
    return "handled";
  }
  if (CREDENTIAL_HEADERS.some((h) => call.req.headers[h] !== undefined)) {
    refuse(
      "credentials_in_request",
      403,
      "Kobe egress: do not send credentials with git requests; Kobe adds the Workspace's credential itself.",
    );
    return "handled";
  }
  // Review L2: git never compresses a push body; one that is compressed would hide its refs
  // from the push audit, so it is refused.
  const encoding = String(call.req.headers["content-encoding"] ?? "")
    .trim()
    .toLowerCase();
  if (request.service === "git-receive-pack" && encoding !== "" && encoding !== "identity") {
    refuse(
      "encoded_request",
      400,
      "Kobe egress: push bodies must not be compressed (git does not compress them).",
    );
    return "handled";
  }
  const release = git.concurrency.tryAcquire(sandboxId);
  if (!release) {
    refuse(
      "connection_limit",
      429,
      "Kobe egress: this sandbox has too many git requests running; wait for one to finish.",
    );
    return "handled";
  }
  try {
    return await decideAndRelay(call, attempt, refuse);
  } finally {
    release();
  }
}

async function decideAndRelay(
  call: GitCall,
  attempt: UpgradeAttempt,
  refuse: (reason: ConnectionReason, status: number, message: string, pushReason?: string) => void,
): Promise<GitHandled> {
  const { ctx, git, host, request } = call;
  const { deps } = ctx;
  const { identity } = attempt;
  let decision: GitDecision;
  let internal: boolean;
  try {
    if (!(await deps.policy.isActiveMember(identity.teamId, identity.userId))) {
      refuse(
        "inactive_member",
        403,
        "Kobe egress: this sandbox's user is not an active member of its team.",
      );
      return "handled";
    }
    const site = await deps.policy.decideSite(host);
    if (!site.allowed) {
      ctx.report(attempt, "not_in_ceiling", true);
      refuse(
        "not_in_ceiling",
        403,
        `Kobe egress: ${host} is not in this site's egress ceiling; a site admin must add it first (Request access).`,
      );
      return "handled";
    }
    internal = site.internal === true;
    const query: GitDecisionQuery = {
      teamId: identity.teamId,
      userId: identity.userId,
      sandboxId: identity.sandboxId,
      token: call.token,
      host,
      request,
    };
    // Review L3: a decision the cache does not hold costs host API calls (token connections);
    // distinct repositories per sandbox are budgeted so a sandbox cannot spend the token's quota.
    if (!git.decisions.has(query) && !git.lookups.take(identity.sandboxId)) {
      refuse(
        "rate_limited",
        429,
        "Kobe egress: too many different repositories asked for from this sandbox; retry in a minute.",
      );
      return "handled";
    }
    decision = await git.decisions.get(query);
  } catch (err) {
    deps.logger.error({ err, team: identity.teamId }, "egress git policy unavailable");
    ctx.finish(attempt, "failed", "policy_unavailable");
    recordPush(call, attempt, "failed", "policy_unavailable");
    reply(
      call.res,
      503,
      "Kobe egress: unavailable",
      "Kobe egress: git access could not be checked; try again shortly.",
    );
    return "handled";
  }
  if (decision.decision === "error") {
    const status = decision.status === 429 ? 429 : decision.status === 401 ? 403 : 503;
    refuse(
      decision.status === 429 ? "rate_limited" : "policy_unavailable",
      status,
      decision.status === 401
        ? "Kobe egress: this sandbox may not use the Workspace's git connections."
        : "Kobe egress: git access could not be checked; try again shortly.",
    );
    return "handled";
  }
  if (decision.decision === "deny") {
    if (decision.code === "no_connection") return "not_connected";
    refuse("git_refused", 403, `Kobe egress: ${decision.message}`, decision.code);
    return "handled";
  }
  const allow = decision;
  // Review L1: the server's answer must be for this service (read for fetch, write for push).
  if (allow.access !== accessOf(request.service)) {
    refuse("git_refused", 403, "Kobe egress: git access could not be confirmed for this request.");
    return "handled";
  }
  const canonical: UpgradeAttempt = {
    ...attempt,
    git: {
      repository: `${allow.organization}/${allow.repository}`,
      service: serviceOf(request),
    },
  };
  return relayAllowed(call, canonical, allow, internal);
}

async function relayAllowed(
  call: GitCall,
  attempt: UpgradeAttempt,
  allow: GitAllow,
  internal: boolean,
): Promise<GitHandled> {
  const { ctx, git, host, request } = call;
  const { deps } = ctx;
  const { identity } = attempt;
  const refuse = (reason: ConnectionReason, status: number, message: string) => {
    ctx.finish(attempt, "blocked", reason);
    recordPush(call, attempt, "blocked", reason, allow.connection_id);
    reply(call.res, status, `Kobe egress: git request refused`, message);
  };
  const declared = call.req.headers["content-length"];
  const length = declared === undefined ? undefined : Number(declared);
  const requestLimit =
    request.service === "git-receive-pack"
      ? allow.push_limit_bytes
      : git.settings.maxFetchRequestBytes;
  if (length !== undefined && (!Number.isSafeInteger(length) || length > requestLimit)) {
    refuse(
      "request_too_large",
      413,
      `Kobe egress: git requests to this connection are limited to ${requestLimit} bytes.`,
    );
    return "handled";
  }
  const detach = deps.bandwidth.attach(identity.sandboxId);
  try {
    let addresses: string[];
    try {
      addresses = await deps.resolve(host);
    } catch {
      ctx.finish(attempt, "failed", "dns_failure");
      recordPush(call, attempt, "failed", "dns_failure", allow.connection_id);
      reply(
        call.res,
        502,
        `Kobe egress: cannot resolve ${host}`,
        `Kobe egress: ${host} does not resolve.`,
      );
      return "handled";
    }
    if (deps.addresses.checkAll(addresses, { internal }) !== "allowed") {
      ctx.report(attempt, "forbidden_address", true);
      refuse(
        "forbidden_address",
        403,
        `Kobe egress: ${host} resolves to an internal or reserved address, which sandboxes may not reach unless a site admin marks it internal (Request access).`,
      );
      return "handled";
    }
    const result = await relayGit({
      req: call.req,
      res: call.res,
      ctx,
      git,
      attempt,
      host,
      addresses,
      request,
      allow,
      length,
      requestLimit,
    });
    if (result.credentialRefused) {
      git.decisions.forget({
        teamId: identity.teamId,
        userId: identity.userId,
        sandboxId: identity.sandboxId,
        host,
        request,
      });
    }
    const bytes = { bytesUp: result.bytesUp, bytesDown: result.bytesDown };
    if (!result.audited) ctx.finish(attempt, result.outcome, result.reason, bytes, true);
    if (request.endpoint === "rpc") {
      recordPush(call, attempt, result.outcome, result.reason, allow.connection_id, {
        refs: result.commands?.refs ?? [],
        truncated: result.commands?.truncated === true,
        status: result.status,
        bytesUp: result.bytesUp,
      });
    }
    return "handled";
  } finally {
    detach();
  }
}

interface PushDetails {
  readonly refs: readonly PushedRef[];
  readonly truncated: boolean;
  readonly status: number | undefined;
  readonly bytesUp: number;
}

/** One `egress.git_push` row for a receive-pack request: refused ones and relayed pushes. */
function recordPush(
  call: GitCall,
  attempt: UpgradeAttempt,
  outcome: "allowed" | "blocked" | "failed",
  reason: string | undefined,
  connectionId?: string,
  details?: PushDetails,
): void {
  if (call.request.service !== "git-receive-pack") return;
  // Discovery (info/refs) that went through is not a push yet; its refusal is.
  if (call.request.endpoint === "refs" && outcome === "allowed") return;
  const { identity } = attempt;
  const event = {
    action: "egress.git_push",
    actor: SYSTEM_ACTOR,
    teamId: identity.teamId,
    target: {
      userId: identity.userId,
      sandboxId: identity.sandboxId,
      ...(connectionId === undefined ? {} : { connectionId }),
      domain: call.host,
      // The server's canonical spelling once it allowed the request (review L6).
      repository: attempt.git?.repository ?? `${call.request.owner}/${call.request.repository}`,
      outcome,
      ...(reason === undefined ? {} : { reason }),
      ...(details && details.refs.length > 0 ? { refs: details.refs.map((r) => ({ ...r })) } : {}),
      ...(details?.truncated ? { refsTruncated: true as const } : {}),
      ...(details?.status === undefined ? {} : { status: details.status }),
      bytesUp: details?.bytesUp ?? 0,
    },
  } as AuditEvent;
  call.git.recordEvent(event);
}
