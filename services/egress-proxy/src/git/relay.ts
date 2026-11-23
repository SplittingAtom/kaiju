import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { ConnectionReason } from "../connection-audit.js";
import {
  MAX_BUFFERED_BYTES,
  holdUntilReady,
  overBuffered,
  type FlowDestination,
  type FlowSource,
} from "../flow.js";
import { connectVerified } from "../upgrade-exchange.js";
import { reply } from "../upgrade-reply.js";
import type { UpgradeAttempt, UpgradeContext } from "../upgrade-types.js";
import type { GitAllow } from "./decisions.js";
import { upstreamPath, type GitRequest } from "./grammar.js";
import type { GitTransportDeps } from "./types.js";
import {
  ReceivePackCommands,
  SecretScanner,
  credentialPlain,
  credentialSecrets,
  gitDownstreamHeaders,
  gitUpstreamHeaders,
  responseEncodingRefused,
} from "./wire.js";

/**
 * One git smart-HTTP exchange (KOBE-763): a fresh verified TLS connection to the checked address
 * per request (so the credential can never ride a reused connection into another request), the
 * proxy's own framing and Authorization upstream, allow-listed headers both ways, packs streamed
 * with back-pressure under size, time and bandwidth limits, and the response scanned for the
 * credential (cut if it appears). Redirects and 401/407 are never relayed.
 */
export interface GitRelayResult {
  readonly outcome: "allowed" | "failed";
  readonly reason: ConnectionReason | undefined;
  readonly bytesUp: number;
  readonly bytesDown: number;
  readonly status: number | undefined;
  readonly commands: ReceivePackCommands | undefined;
  /** The host refused the credential: the caller drops the cached decision. */
  readonly credentialRefused: boolean;
  /** The connection failed before the exchange and was already answered and audited. */
  readonly audited: boolean;
}

export interface GitRelayInput {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly ctx: UpgradeContext;
  readonly git: GitTransportDeps;
  readonly attempt: UpgradeAttempt;
  readonly host: string;
  readonly addresses: readonly string[];
  readonly request: GitRequest;
  readonly allow: GitAllow;
  readonly length: number | undefined;
  readonly requestLimit: number;
}

const FAILURE_STATUS: Partial<Record<ConnectionReason, number>> = {
  upstream_timeout: 504,
  request_too_large: 413,
};

export async function relayGit(input: GitRelayInput): Promise<GitRelayResult> {
  const { req, res, ctx, git, attempt, host, request, allow } = input;
  const { deps } = ctx;
  const { identity } = attempt;
  const tls = await connectVerified(ctx, res, attempt, host, input.addresses);
  if (!tls) {
    // connectVerified answered and audited; report the outcome without a second audit row.
    return {
      outcome: "failed",
      reason: undefined,
      bytesUp: 0,
      bytesDown: 0,
      status: undefined,
      commands: undefined,
      credentialRefused: false,
      audited: true,
    };
  }
  const secrets = credentialSecrets(allow.username, allow.password);
  const authorization = `Basic ${Buffer.from(`${allow.username}:${allow.password}`).toString("base64")}`;
  const headers: [string, string][] = [
    ["Host", host],
    ...gitUpstreamHeaders(req.rawHeaders),
    // Review M1: plain responses only, so the credential scan sees every byte.
    ["Accept-Encoding", "identity"],
    ...(input.length === undefined
      ? []
      : [["Content-Length", String(input.length)] satisfies [string, string]]),
    ["Authorization", authorization],
  ];
  const outgoing = httpRequest({
    createConnection: () => tls,
    method: request.endpoint === "refs" ? "GET" : "POST",
    path: upstreamPath(allow.base_path, allow.organization, allow.repository, request),
    headers: headers.flat() as unknown as Record<string, string>,
    setHost: false,
    // createConnection and no agent: this connection serves exactly this one request.
  });
  const commands =
    request.service === "git-receive-pack" && request.endpoint === "rpc"
      ? new ReceivePackCommands()
      : undefined;
  const scanner = new SecretScanner(secrets, credentialPlain(allow.username, allow.password));
  const timers = new Set<NodeJS.Timeout>();
  const state = {
    bytesUp: 0,
    bytesDown: 0,
    status: undefined as number | undefined,
    failure: undefined as ConnectionReason | undefined,
    credentialRefused: false,
  };
  const fail = (reason: ConnectionReason, message?: string) => {
    if (state.failure !== undefined) return;
    state.failure = reason;
    outgoing.destroy();
    tls.destroy();
    if (res.headersSent) {
      res.destroy();
      return;
    }
    reply(
      res,
      FAILURE_STATUS[reason] ?? 502,
      `Kobe egress: git request to ${host} failed`,
      message ?? `Kobe egress: the git request to ${host} failed (${reason}).`,
    );
  };
  // Review M2: the source resumes only when the destination drained AND the throttle allows;
  // a destination holding more than the backstop unsent is cut.
  const forwarded = (
    src: FlowSource,
    dst: FlowDestination,
    flushed: boolean,
    n: number,
    held = 0,
  ) => {
    // The scanner's held tail counts toward the backstop too.
    if (overBuffered(dst, MAX_BUFFERED_BYTES - held)) {
      fail("buffer_limit");
      return;
    }
    holdUntilReady(src, dst, flushed, deps.bandwidth.take(identity.sandboxId, n), timers);
  };
  const deadline = attempt.started + git.settings.timeoutMs;
  const overall = setTimeout(() => fail("upstream_timeout"), Math.max(0, deadline - Date.now()));
  const unregister = deps.tunnels?.register(
    {
      teamId: identity.teamId,
      userId: identity.userId,
      host,
      git: true,
      close: () => {
        fail("not_in_ceiling");
        res.destroy();
      },
    },
    deadline,
  );
  tls.setTimeout(deps.settings.idleTimeoutMs, () => fail("upstream_timeout"));

  const done = new Promise<void>((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      resolve();
    };
    res.once("close", finish);
    outgoing.once("error", () => {
      fail("upstream_unreachable");
      finish();
    });
    outgoing.once("response", (up: IncomingMessage) => {
      state.status = up.statusCode;
      const status = up.statusCode ?? 502;
      if (status === 401 || status === 407) {
        state.credentialRefused = true;
        up.destroy();
        fail(
          "upstream_auth",
          `Kobe egress: ${host} refused the Workspace's git credential; a Workspace admin should check the connection.`,
        );
        return;
      }
      if (status >= 300 && status < 400) {
        up.destroy();
        fail(
          "redirect_refused",
          `Kobe egress: ${host} answered with a redirect, which Kobe does not follow for git; check the repository's current name.`,
        );
        return;
      }
      if (responseEncodingRefused(up.headers) !== undefined) {
        up.destroy();
        fail(
          "encoded_response",
          `Kobe egress: ${host} answered with an encoded body, which Kobe does not relay for git.`,
        );
        return;
      }
      const declared = Number(up.headers["content-length"] ?? "0");
      if (Number.isFinite(declared) && declared > git.settings.maxResponseBytes) {
        up.destroy();
        fail("response_too_large");
        return;
      }
      const down = gitDownstreamHeaders(up.rawHeaders, secrets);
      if (up.headers["content-length"] !== undefined) {
        down.push(["Content-Length", String(declared)]);
      }
      down.push(["Connection", "close"]);
      res.writeHead(status, down.flat());
      up.on("data", (chunk: Buffer) => {
        state.bytesDown += chunk.length;
        if (state.bytesDown > git.settings.maxResponseBytes) {
          up.destroy();
          fail("response_too_large");
          return;
        }
        // Review R2-M1: forward only what the scan cleared; the tail waits for more bytes.
        const step = scanner.push(chunk);
        if (step.found) {
          up.destroy();
          fail("secret_reflected");
          return;
        }
        const flushed = step.forward.length === 0 ? true : res.write(step.forward);
        forwarded(up, res, flushed, chunk.length, scanner.held);
      });
      up.once("end", () => {
        const step = scanner.end();
        if (step.found) {
          fail("secret_reflected");
          return;
        }
        res.end(step.forward);
      });
      up.once("error", () => fail("upstream_unreachable"));
    });
  });

  req.on("data", (chunk: Buffer) => {
    state.bytesUp += chunk.length;
    if (state.bytesUp > input.requestLimit) {
      fail(
        "request_too_large",
        `Kobe egress: git requests to this connection are limited to ${input.requestLimit} bytes.`,
      );
      return;
    }
    commands?.push(chunk);
    forwarded(req, outgoing, outgoing.write(chunk), chunk.length);
  });
  req.once("end", () => outgoing.end());
  req.once("error", () => fail("upstream_unreachable"));

  try {
    await done;
  } finally {
    clearTimeout(overall);
    for (const t of timers) clearTimeout(t);
    unregister?.();
    tls.destroy();
  }
  return {
    outcome: state.failure === undefined ? "allowed" : "failed",
    reason: state.failure,
    bytesUp: state.bytesUp,
    bytesDown: state.bytesDown,
    status: state.status,
    commands,
    credentialRefused: state.credentialRefused,
    audited: false,
  };
}
