import type { IncomingMessage, ServerResponse } from "node:http";
import type { CallerIdentity } from "./auth.js";
import { sendError } from "./errors.js";
import type { GatewayOptions } from "./options.js";

/**
 * An Orbit eval Job's shared cases (KOBE-276 review S2): the case text stays in Postgres until
 * the Job asks for it with its eval token. The eval must be live for that member (the
 * principal), within the request rate, and the store answers only that member's running eval.
 */
export async function serveEvalCases(
  options: Pick<GatewayOptions, "evalCases" | "rate" | "principals" | "logger">,
  req: IncomingMessage,
  res: ServerResponse,
  identity: CallerIdentity,
): Promise<void> {
  const { logger } = options;
  const evalId = identity.sandboxId;
  if (!options.evalCases || req.method !== "GET" || evalId === undefined) {
    sendError(res, "openai", 404, "not_found", "Not a model inference endpoint.");
    return;
  }
  if (!options.rate.allow(evalId)) {
    sendError(res, "openai", 429, "rate_limited", "Too many requests.", 1);
    return;
  }
  const who = await options.principals.resolve(identity.teamId, identity.userId, evalId);
  if (!who.ok) {
    sendError(res, "openai", 403, "forbidden", "This eval can't read shared cases.");
    return;
  }
  let file: string | null;
  try {
    file = await options.evalCases.load(identity.teamId, identity.userId, evalId);
  } catch (err) {
    logger.error({ err, teamId: identity.teamId, evalId }, "eval cases could not be read");
    sendError(res, "openai", 503, "unavailable", "Shared cases are unavailable.");
    return;
  }
  if (file === null) {
    sendError(res, "openai", 404, "not_found", "No shared cases for this eval.");
    return;
  }
  res.writeHead(200, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(file);
}
