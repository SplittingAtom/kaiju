import { Readable } from "node:stream";
import type { Context } from "hono";
import type { SandboxCaller } from "../auth.js";
import { workspaceBlobKey } from "../keys.js";
import { discardOrphanedResend, healBlob } from "../lost.js";
import { IntegrityError, verifyingStream } from "../object-store.js";
import { s3PutSpan } from "../write-spans.js";
import type { WorkspaceKit } from "./kit.js";
import { error } from "./shared.js";

/** Storing verified upload bytes, and resending content whose object was lost (KOBE-475). */
export function blobWriters(kit: WorkspaceKit) {
  const { db, objects, prefix, log, auditIntegrity, finishTx } = kit;

  /**
   * Streams the verified bytes into the content's key. Undefined when stored; otherwise the error
   * response (a mismatch stores nothing).
   */
  const storeVerified = async (
    c: Context,
    caller: SandboxCaller,
    sha256: string,
    size: number,
  ): Promise<Response | undefined> => {
    const raw = c.req.raw.body;
    const source = raw ? Readable.fromWeb(raw as never) : Readable.from([]);
    const verified = source.pipe(verifyingStream(sha256, size));
    source.once("error", (err) => verified.destroy(err));
    try {
      const key = workspaceBlobKey(prefix, caller, sha256);
      await s3PutSpan("blob", "put", () => objects.put(key, verified, size));
      return undefined;
    } catch (err) {
      if (err instanceof IntegrityError || verified.errored instanceof IntegrityError) {
        auditIntegrity(caller);
        return error(c, 422, "hash_mismatch", "The bytes did not match their SHA-256 and size.");
      }
      log.error({ err, sandbox_id: caller.sandboxId }, "workspace blob upload failed");
      return error(c, 502, "storage_unavailable", "Object storage is unavailable; retry.");
    }
  };

  /**
   * KOBE-475: content the workspace already holds (and counts) whose object was lost. Its bytes
   * are stored again — verified against the hash and the row's size — with no reservation (the
   * blob totals already include it), and the mark is cleared.
   */
  const resend = async (c: Context, caller: SandboxCaller, sha256: string, size: number) => {
    const failed = await storeVerified(c, caller, sha256, size);
    if (failed) return failed;
    const outcome = await finishTx(caller, (t) => healBlob(t, caller, sha256, size));
    if (outcome === "deleting" || outcome === "gone") {
      // Collected while the bytes were stored: never leave an object no row accounts for.
      await discardOrphanedResend(db, objects, caller, prefix, sha256, size).catch((err: unknown) =>
        log.error({ err, sandbox_id: caller.sandboxId }, "could not discard a resend"),
      );
      c.header("Retry-After", "5");
      return error(c, 409, "retry_later", "This content is being collected; upload it again.");
    }
    if (outcome === "healed") {
      log.info({ sandbox_id: caller.sandboxId }, "workspace content restored from the sandbox");
    }
    return c.json({ sha256, size }, outcome === "healed" ? 201 : 200);
  };

  return { storeVerified, resend };
}
