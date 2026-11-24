import type { ServerResponse } from "node:http";
import type { Resolution } from "../principals.js";
import type { RouteKind } from "../routes.js";

const GEMINI_STATUS: Readonly<Record<number, string>> = {
  400: "INVALID_ARGUMENT",
  401: "UNAUTHENTICATED",
  403: "PERMISSION_DENIED",
  404: "NOT_FOUND",
  413: "INVALID_ARGUMENT",
  429: "RESOURCE_EXHAUSTED",
  503: "UNAVAILABLE",
};

/** An error in the shape the route's SDK parses (so Pi shows the message). */
export function sendError(
  res: ServerResponse,
  kind: RouteKind,
  status: number,
  code: string,
  message: string,
  retryAfterSeconds?: number,
): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body =
    kind === "anthropic"
      ? { type: "error", error: { type: code, message } }
      : kind === "gemini"
        ? {
            error: {
              code: status,
              message,
              status: GEMINI_STATUS[status] ?? "UNKNOWN",
              // Gemini carries no string code: Kaiju's goes in an ErrorInfo detail.
              details: [
                {
                  "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                  reason: code,
                  domain: "kaiju",
                },
              ],
            },
          }
        : { error: { message, type: code, code } };
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    ...(retryAfterSeconds !== undefined ? { "retry-after": String(retryAfterSeconds) } : {}),
  });
  res.end(payload);
}

export const REASONS: Readonly<
  Record<Exclude<Resolution, { ok: true }>["reason"], [number, string, string]>
> = {
  not_member: [401, "session_revoked", "This sandbox's user is no longer a member of the team."],
  sandbox_revoked: [401, "session_revoked", "This sandbox's session has been revoked."],
  no_key: [503, "model_access_pending", "Model access for this user is being set up; retry."],
  key_unreadable: [503, "model_access_unavailable", "Model access is unavailable; retry later."],
};
