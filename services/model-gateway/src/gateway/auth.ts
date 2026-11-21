import type { IncomingMessage } from "node:http";
import {
  serverCallBoundToRun,
  serverCallNamesPass,
  serverCallRunOptional,
  type ServerCallClaims,
  type SessionTokenClaims,
} from "@kobe/protocol";
import { SessionTokenError } from "@kobe/session-token";
import { extractCredential } from "../credentials.js";
import type { Route } from "../routes.js";
import { authenticateServerCall, isServerCall } from "../server-call.js";
import type { GatewayOptions } from "./options.js";

export interface CallerIdentity {
  readonly teamId: string;
  readonly userId: string;
  readonly sandboxId: string | undefined;
}

export type Caller =
  | {
      readonly ok: true;
      readonly identity: CallerIdentity;
      readonly serverCall: ServerCallClaims | undefined;
      /** A skill eval's own sandbox (its token names an `eval_thread`, KOBE-327). */
      readonly evalSandbox?: boolean;
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string;
      readonly message: string;
    };

export const NO_SESSION = {
  ok: false,
  status: 401,
  code: "invalid_session_token",
  message: "A valid sandbox session token is required.",
} as const;

/** Who calls: a server call (its header decides, KOBE-234) or a sandbox (its session token). */
export function authenticate(
  options: Pick<GatewayOptions, "serverCalls" | "verify">,
  req: IncomingMessage,
  url: URL,
  route: Route | undefined,
): Caller {
  if (isServerCall(req.headers)) {
    const auth = authenticateServerCall(
      options.serverCalls,
      req.headers,
      url.searchParams,
      route,
      req.method,
    );
    if (!auth.ok) return auth;
    const { team_id: teamId, user_id: userId } = auth.claims;
    return {
      ok: true,
      identity: { teamId, userId, sandboxId: undefined },
      serverCall: auth.claims,
    };
  }
  const credential = extractCredential(req.headers, url.searchParams);
  if (!credential.ok) return NO_SESSION;
  let claims: SessionTokenClaims;
  try {
    claims = options.verify(credential.token);
  } catch (err) {
    if (!(err instanceof SessionTokenError)) throw err;
    return NO_SESSION;
  }
  return {
    ok: true,
    identity: { teamId: claims.team_id, userId: claims.user_id, sandboxId: claims.sub },
    serverCall: undefined,
    ...(claims.eval_thread === undefined ? {} : { evalSandbox: true }),
  };
}

/**
 * A server call's run attribution (KOBE-234 review L1): the token's run must be a completed run of
 * its thread leased to its member, else 403. A run-less purpose ({@link serverCallBoundToRun}
 * false, KOBE-564) carries no run or thread by contract, so there is nothing to check: the call is
 * the member's own, under their budget lines, and its usage row names no run.
 */
export async function serverCallAttribution(
  options: Pick<GatewayOptions, "serverCalls">,
  claims: ServerCallClaims,
): Promise<
  | { readonly ok: true; readonly runId: string | undefined }
  | { readonly ok: false; readonly status: 403; readonly code: string; readonly message: string }
> {
  // KOBE-409: an optional-run purpose may name no run; one that names a run must name a live run
  // (still starting, running or completed, never a terminal failure) of that thread and member.
  const optional = serverCallRunOptional(claims.purpose);
  if (optional && claims.run_id === undefined) return { ok: true, runId: undefined };
  if (!optional && !serverCallBoundToRun(claims.purpose)) return { ok: true, runId: undefined };
  const matches =
    claims.run_id !== undefined &&
    claims.thread_id !== undefined &&
    (await options.serverCalls?.runMatches({
      teamId: claims.team_id,
      runId: claims.run_id,
      threadId: claims.thread_id,
      userId: claims.user_id,
      // A learning pass is the thread author's own (KOBE-391): its lease check admits only them.
      ...(serverCallNamesPass(claims.purpose) ? { authorOnly: true } : {}),
      ...(optional ? { live: true as const } : {}),
    }));
  if (!matches) {
    return {
      ok: false,
      status: 403,
      code: "server_call_run_mismatch",
      message: optional
        ? "That run is not a live run of this thread and member."
        : serverCallNamesPass(claims.purpose)
          ? "That run is not a completed run of this thread by its author."
          : "That run is not a completed run of this thread and member.",
    };
  }
  // A learning pass's token names its pass (KOBE-391): running now, this thread's, this member's.
  if (serverCallNamesPass(claims.purpose)) {
    const running =
      claims.pass_id !== undefined &&
      claims.thread_id !== undefined &&
      (await options.serverCalls?.passRunning({
        teamId: claims.team_id,
        passId: claims.pass_id,
        threadId: claims.thread_id,
        userId: claims.user_id,
      }));
    if (!running) {
      return {
        ok: false,
        status: 403,
        code: "server_call_pass_mismatch",
        message: "That learning pass is not running on this thread for this member.",
      };
    }
  }
  return { ok: true, runId: claims.run_id };
}
