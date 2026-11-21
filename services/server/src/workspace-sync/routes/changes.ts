import { Readable } from "node:stream";
import { SYSTEM_ACTOR } from "@kobe/db";
import {
  WORKSPACE_ENTRY_HEADER,
  encodeWorkspaceEntryHeader,
  workspaceCommitRequestSchema,
  workspacePathSchema,
  workspaceRestoreReportSchema,
} from "@kobe/protocol";
import { Hono } from "hono";
import { recordAudit } from "../../audit/record.js";
import { reportMissingContent } from "../lost.js";
import { commitChanges, currentEntry, publicEntry, recordRestore } from "../store.js";
import type { WorkspaceKit } from "./kit.js";
import {
  AUDIT_EVERY_MS,
  REPORT_EVERY_MS,
  WORKSPACE_MAX_TRANSFERS,
  error,
  type Vars,
} from "./shared.js";

/** Commits, file downloads and restore reports. */
export function workspaceChangeRoutes(kit: WorkspaceKit): Hono<Vars> {
  const app = new Hono<Vars>();
  const {
    db,
    objects,
    prefix,
    quota,
    log,
    limits,
    reported,
    transfers,
    audited,
    auditLimit,
    tx,
    busy,
    metaAllowed,
    readJson,
  } = kit;

  app.post("/commit", async (c) => {
    const caller = c.get("caller");
    const limited = metaAllowed(caller, c);
    if (limited) return limited;
    const body = workspaceCommitRequestSchema.safeParse(await readJson(c));
    if (!body.success) return error(c, 400, "invalid_request", "Expected {changes: [...]}.");
    const out = await tx(caller, "commit", (t) =>
      commitChanges(t, caller, body.data.changes, { prefix, quota, maxRows: limits.maxRows }),
    );
    for (const limit of new Set(out.refused)) {
      auditLimit(caller, limit as "workspace_bytes" | "workspace_files" | "workspace_file_size");
    }
    return c.json({ head_rev: out.headRev, results: out.results });
  });

  app.get("/file", async (c) => {
    const caller = c.get("caller");
    const path = workspacePathSchema.safeParse(c.req.query("path"));
    if (!path.success) return error(c, 400, "invalid_request", "A workspace path is required.");
    const release = transfers.take(caller.sandboxId, WORKSPACE_MAX_TRANSFERS);
    if (!release) return busy(c, 429, "Too many transfers at once.");
    let object;
    let entry;
    try {
      entry = await tx(caller, "other", (t) => currentEntry(t, caller, path.data));
      if (!entry || entry.deleted || entry.blobKey === null) {
        release();
        return error(c, 404, "not_found", "No such file in the workspace.");
      }
      object = await objects.get(entry.blobKey);
    } catch (err) {
      release();
      throw err;
    }
    if (!object) {
      release();
      log.error({ sandbox_id: caller.sandboxId, rev: entry.rev }, "workspace object missing");
      // Listed for a sandbox that still holds it to upload again (KOBE-475).
      await reportMissingContent(db, caller, entry, prefix, log);
      return error(c, 502, "content_missing", "The file's content is missing in storage.");
    }
    // The slot is held until the body has been read out of storage (backpressure-bound).
    object.body.once("close", release);
    return new Response(Readable.toWeb(object.body) as ReadableStream, {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(entry.size),
        "cache-control": "no-store",
        [WORKSPACE_ENTRY_HEADER]: encodeWorkspaceEntryHeader(publicEntry(entry)),
      },
    });
  });

  app.post("/restore-report", async (c) => {
    const caller = c.get("caller");
    const limited = metaAllowed(caller, c);
    if (limited) return limited;
    const body = workspaceRestoreReportSchema.safeParse(await readJson(c));
    if (!body.success) return error(c, 400, "invalid_request", "Invalid restore report.");
    const report = body.data;
    const full = report.mode === "full" && report.files > 0;
    const auditIt =
      full && Date.now() - (audited.get(`${caller.sandboxId}:restored`) ?? 0) > AUDIT_EVERY_MS;
    if (auditIt) audited.set(`${caller.sandboxId}:restored`, Date.now());
    const write = auditIt || Date.now() - (reported.get(caller.sandboxId) ?? 0) > REPORT_EVERY_MS;
    if (reported.size > 10_000) reported.clear();
    if (write) reported.set(caller.sandboxId, Date.now());
    if (write) {
      await tx(caller, "other", async (t) => {
        await recordRestore(t, caller, report.duration_ms);
        if (auditIt) {
          await recordAudit(t, {
            action: "workspace.restored",
            actor: SYSTEM_ACTOR,
            teamId: caller.teamId,
            target: {
              sandboxId: caller.sandboxId,
              userId: caller.userId,
              files: report.files,
              bytes: report.bytes,
              durationMs: report.duration_ms,
            },
          });
        }
      });
    }
    log.info(
      { sandbox_id: caller.sandboxId, ...report },
      report.mode === "full" ? "workspace restored onto an empty volume" : "workspace restore",
    );
    return c.body(null, 204);
  });

  return app;
}
