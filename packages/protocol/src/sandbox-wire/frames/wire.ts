import { z } from "zod";
import { idSchema } from "../../common.js";
import { SANDBOX_ERROR_CODES, SANDBOX_WIRE_VERSION } from "../connection.js";

/**
 * Shared building blocks of the frame schemas (frames.ts and its `frames/*` modules). Semantics are
 * documented in connection.ts. Only {@link OPEN_CODE_PATTERN} is public; the rest stays internal.
 */

export const v = z.literal(SANDBOX_WIRE_VERSION);
export const seq = z.number().int().positive();
export const nonce = z.string().min(1).max(64);
export const commandId = idSchema;

export function frame<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.strictObject({ v, type: z.literal(type), ...shape });
}

export const pingFrame = frame("ping", { nonce });
export const pongFrame = frame("pong", { nonce });
/**
 * Forward compatibility (normative). After an upgrade the server is newer than the sandboxes still
 * running, so **server → sandbox informational enums are open**: a code the agent does not know
 * still decodes, as an opaque string of {@link OPEN_CODE_PATTERN} shape (reason codes and stages,
 * error codes, stop and shutdown reasons; extra keys in a reason are kept). The server may add
 * codes freely. **Decisions and modes stay closed** (`policy.result.decision`, `run.stop.mode`, Pi
 * config values): those change behaviour, so a new value is a wire version change. Sandbox →
 * server frames stay strict: the server is never older than the agents it talks to.
 */
export const OPEN_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
export const openCode = z.string().regex(OPEN_CODE_PATTERN);

const errorFields = {
  message: z.string().max(2000),
  /** The `command_id` / `request_id` / frame type the error refers to, if any. */
  ref: z.string().max(256).optional(),
};
/** Sandbox → server: closed codes. */
export const errorFrame = frame("error", { code: z.enum(SANDBOX_ERROR_CODES), ...errorFields });
/** Server → sandbox: open codes ({@link SANDBOX_ERROR_CODES} today; newer servers may add some). */
export const serverErrorFrame = frame("error", { code: openCode, ...errorFields });
