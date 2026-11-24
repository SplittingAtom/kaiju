import { z } from "zod";
import { idSchema, uuidSchema } from "../common.js";
import {
  memoryFailFields,
  memoryPutOkFields,
  memoryReadOkFields,
  memoryShowOkFields,
  recallInputSchema,
  rememberInputSchema,
  showMemoryItemInputSchema,
} from "../memory.js";
import { SANDBOX_WIRE_VERSION } from "./connection.js";

/** Memory frames (KOBE-153, memory.ts), behind hello capability `memory`. Same shape as `frame()` in frames.ts. */
function frame<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.strictObject({ v: z.literal(SANDBOX_WIRE_VERSION), type: z.literal(type), ...shape });
}

/** Sandbox -> server: the `remember` call kaiju-policy let through. Answered by `memory.result`. */
export const memoryPutFrameSchema = frame("memory.put", {
  request_id: idSchema,
  run_id: uuidSchema,
  thread_id: uuidSchema,
  tool_call_id: idSchema,
  input: rememberInputSchema,
});

/** Sandbox -> server: a `recall` call. Answered by `memory.result`. */
export const memoryReadFrameSchema = frame("memory.read", {
  request_id: idSchema,
  run_id: uuidSchema,
  thread_id: uuidSchema,
  /** The `recall` call kaiju-policy let through: the server only reads for an allowed call (D-3). */
  tool_call_id: idSchema,
  input: recallInputSchema,
});

/** Sandbox -> server: a `show_memory_item` call (KOBE-399). Answered by `memory.result`. */
export const memoryShowFrameSchema = frame("memory.show", {
  request_id: idSchema,
  run_id: uuidSchema,
  thread_id: uuidSchema,
  /** The call kaiju-policy let through (D-3), like `memory.read`. */
  tool_call_id: idSchema,
  input: showMemoryItemInputSchema,
});

/** Server -> sandbox; `error.code` is open (known: `MEMORY_ERROR_CODES`). */
export const memoryResultFrameSchema = z.union([
  frame("memory.result", { request_id: idSchema, ...memoryPutOkFields }),
  frame("memory.result", { request_id: idSchema, ...memoryReadOkFields }),
  frame("memory.result", { request_id: idSchema, ...memoryShowOkFields }),
  frame("memory.result", { request_id: idSchema, ...memoryFailFields }),
]);
