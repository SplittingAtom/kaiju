import { z } from "zod";
import { artifactCallShape, artifactFailFields, artifactOkFields } from "../../artifacts.js";
import { idSchema, uuidSchema } from "../../common.js";
import { fileShareCallShape, fileShareOkFields, shareFileWorkspaceRefSchema } from "../../files.js";
import { frame } from "./wire.js";

/** Artifact and file-share frames (KOBE-127, KOBE-147) and their answers. */

/**
 * Sandbox -> server (KOBE-127, artifacts.ts), behind hello capability `artifacts`: the
 * `create_artifact` / `update_artifact` call kaiju-policy let through. The server answers with
 * `artifact.result` for the same `request_id`. At most 1 MiB (own entry in
 * {@link SANDBOX_FRAME_MAX_BYTES_BY_TYPE}); the server refuses it from a connection that did not
 * announce the capability and checks it against what it allowed for `tool_call_id` (KOBE-129).
 */
const artifactPutFields = {
  request_id: idSchema,
  run_id: uuidSchema,
  thread_id: uuidSchema,
  tool_call_id: idSchema,
};
export const artifactPutFrameSchema = z.union([
  frame("artifact.put", { ...artifactPutFields, ...artifactCallShape.create }),
  frame("artifact.put", { ...artifactPutFields, ...artifactCallShape.update }),
]);

/**
 * Sandbox -> server (KOBE-147, files.ts), behind hello capability `files`: the `share_file` call
 * kaiju-policy let through, sent AFTER the agent pushed the file through workspace sync (push-then-
 * share, files.ts); `workspace` is the pushed entry the server must find unchanged. Answered by
 * `file.share_result` for the same `request_id`. A small frame (no own size entry).
 */
export const fileShareFrameSchema = frame("file.share", {
  request_id: idSchema,
  run_id: uuidSchema,
  thread_id: uuidSchema,
  tool_call_id: idSchema,
  ...fileShareCallShape,
  workspace: shareFileWorkspaceRefSchema,
});

/**
 * Server -> sandbox answer to `artifact.put` (KOBE-127). `error.code` is open (known:
 * `ARTIFACT_ERROR_CODES`); the tool result handed to the model is this answer.
 */
export const artifactResultFrameSchema = z.union([
  frame("artifact.result", { request_id: idSchema, ...artifactOkFields }),
  frame("artifact.result", { request_id: idSchema, ...artifactFailFields }),
]);

/** Server -> sandbox answer to `file.share` (KOBE-147). `error.code` is open (known: `FILE_SHARE_ERROR_CODES`). */
export const fileShareResultFrameSchema = z.union([
  frame("file.share_result", { request_id: idSchema, ...fileShareOkFields }),
  frame("file.share_result", { request_id: idSchema, ...artifactFailFields }),
]);
