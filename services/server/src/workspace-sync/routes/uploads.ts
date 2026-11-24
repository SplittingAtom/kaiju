import { sha256HexSchema } from "@kaiju/protocol";
import { Hono } from "hono";
import { param } from "../../http/request.js";
import { teamObjectsAllow } from "../../uploads/quota.js";
import { healBlob, lostBlobSize } from "../lost.js";
import { blobState, finishUpload, recordBlob, reserveUpload } from "../store.js";
import { WRITE_SPAN, writeTxSpan } from "../write-spans.js";
import { blobWriters } from "./blob-writes.js";
import type { WorkspaceKit } from "./kit.js";
import { WORKSPACE_MAX_TRANSFERS, error, type Vars } from "./shared.js";

/** Content uploads (`PUT /blobs/:sha256`): reserved, verified, recorded, or resent when lost. */
export function workspaceUploadRoutes(kit: WorkspaceKit): Hono<Vars> {
  const app = new Hono<Vars>();
  const { deps, log, limits, transfers, auditLimit, auditIntegrity, tx, finishTx, busy } = kit;
  const { storeVerified, resend } = blobWriters(kit);

  app.put("/blobs/:sha256", async (c) => {
    const caller = c.get("caller");
    const sha = param(c, "sha256", sha256HexSchema);
    const size = Number(c.req.header("content-length") ?? "NaN");
    if (!sha.success) return error(c, 400, "invalid_request", "The name must be a SHA-256.");
    if (!Number.isSafeInteger(size) || size < 0) {
      return error(c, 411, "length_required", "Content-Length is required.");
    }
    if (size > limits.maxFileBytes) {
      auditLimit(caller, "workspace_file_size");
      const max = limits.maxFileBytes;
      return error(c, 413, "file_too_large", `Files over ${max} bytes are not synced.`);
    }
    const release = transfers.take(caller.sandboxId, WORKSPACE_MAX_TRANSFERS);
    if (!release) return busy(c, 429, "Too many transfers at once.");
    try {
      // Reserve the bytes (and one blob) before accepting any: concurrent uploads can't overshoot.
      const reserve = () =>
        tx(caller, "other", async (t) => {
          const lostSize = await lostBlobSize(t, caller, sha.data);
          if (lostSize !== undefined) return lostSize === size ? "lost" : "lost_mismatch";
          const held = await blobState(t, caller, sha.data);
          if (held !== "absent") return held;
          // GV2 (KOBE-579): a new object past the team's object budget is refused.
          if (
            deps.teamMaxObjects !== undefined &&
            !(await teamObjectsAllow(t, caller.teamId, deps.teamMaxObjects))
          ) {
            return "over_objects";
          }
          return (await reserveUpload(t, caller, size, limits)) ? "reserved" : "over_quota";
        });
      const state = await writeTxSpan(WRITE_SPAN.reserveTx, "blob", reserve, String);
      if (state === "lost") return await resend(c, caller, sha.data, size);
      if (state === "lost_mismatch") {
        auditIntegrity(caller);
        return error(c, 422, "hash_mismatch", "The bytes did not match their SHA-256 and size.");
      }
      if (state === "held") return c.json({ sha256: sha.data, size }, 200);
      if (state === "deleting") {
        c.header("Retry-After", "5");
        return error(c, 409, "retry_later", "This content is being collected; upload it later.");
      }
      if (state === "over_objects") {
        return c.json(
          {
            code: "quota_exceeded",
            limit: "objects",
            message: "The workspace holds as many stored objects as its budget allows.",
          },
          507,
        );
      }
      if (state === "over_quota") {
        auditLimit(caller, "workspace_bytes");
        deps.onQuotaPressure?.(caller);
        return error(c, 507, "quota_exceeded", "The workspace holds too much unsynced content.");
      }
      // Recording and ending the reservation are short and bounded by the transfer slots: they
      // take no in-flight slot (an upload that finished must never be left unrecorded).
      let outcome: "added" | "exists" | "deleting" | "failed" = "failed";
      let finished = false;
      try {
        const failed = await storeVerified(c, caller, sha.data, size);
        if (failed) return failed;
        const record = () =>
          finishTx(caller, async (t) => {
            const recorded = await recordBlob(t, caller, sha.data, size);
            await finishUpload(t, caller, size, recorded === "added");
            // Marked lost while this upload ran: these verified bytes are that content.
            if (recorded === "exists") await healBlob(t, caller, sha.data, size);
            return recorded;
          });
        outcome = await writeTxSpan(WRITE_SPAN.blobTx, "blob", record, String);
        finished = true;
      } finally {
        // A failed upload still ends its reservation (a crash leaves it to collection).
        if (!finished) {
          await finishTx(caller, (t) => finishUpload(t, caller, size, false)).catch(
            (err: unknown) => log.error({ err }, "could not end an upload reservation"),
          );
        }
      }
      if (outcome === "deleting") {
        c.header("Retry-After", "5");
        return error(c, 409, "retry_later", "This content is being collected; upload it again.");
      }
      return c.json({ sha256: sha.data, size }, outcome === "added" ? 201 : 200);
    } finally {
      release();
    }
  });

  return app;
}
