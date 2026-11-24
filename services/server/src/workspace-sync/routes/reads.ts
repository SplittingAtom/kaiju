import { workspaceBlobsMissingRequestSchema } from "@kaiju/protocol/sandbox-wire";
import { WORKSPACE_MAX_BATCH } from "@kaiju/protocol";
import { Hono } from "hono";
import { checkoutRefs } from "../checkouts.js";
import { lostBlobs } from "../lost.js";
import { movesSince } from "../move-journal.js";
import { manifestPage, missingBlobs, publicEntry } from "../store.js";
import type { WorkspaceKit } from "./kit.js";
import { error, type Vars } from "./shared.js";

/** The manifest, journalled moves and the blob lists a sandbox syncs against. */
export function workspaceReadRoutes(kit: WorkspaceKit): Hono<Vars> {
  const app = new Hono<Vars>();
  const { tx, metaAllowed, readJson } = kit;

  app.get("/manifest", async (c) => {
    const caller = c.get("caller");
    const limited = metaAllowed(caller, c);
    if (limited) return limited;
    const since = Number(c.req.query("since") ?? "0");
    const limit = Number(c.req.query("limit") ?? String(WORKSPACE_MAX_BATCH));
    if (!Number.isSafeInteger(since) || since < 0 || !Number.isInteger(limit) || limit < 1) {
      return error(c, 400, "invalid_request", "since and limit must be non-negative integers.");
    }
    const read = await tx(caller, "other", async (t) => ({
      page: await manifestPage(t, caller, since, Math.min(limit, WORKSPACE_MAX_BATCH)),
      // CM4 (KOBE-579): on every page, the caller's checkouts (writable `projects/<slug>/`).
      checkouts: await checkoutRefs(t, caller),
    }));
    const { page } = read;
    if (page.kind === "resync_required") {
      return error(c, 409, "resync_required", "Pull the manifest again from revision 0.");
    }
    return c.json({
      head_rev: page.headRev,
      entries: page.entries.map(publicEntry),
      more: page.more,
      checkouts: read.checkouts,
    });
  });

  /** Moves to replay as local renames before the next pull (KOBE-304; contract `moves`). */
  app.get("/moves", async (c) => {
    const caller = c.get("caller");
    const limited = metaAllowed(caller, c);
    if (limited) return limited;
    const since = Number(c.req.query("since") ?? "0");
    const after = Number(c.req.query("after") ?? "0");
    if (!Number.isSafeInteger(since) || since < 0 || !Number.isSafeInteger(after) || after < 0) {
      return error(c, 400, "invalid_request", "since and after must be non-negative integers.");
    }
    const page = await tx(caller, "other", (t) => movesSince(t, caller, since, after));
    return c.json(page);
  });

  app.post("/blobs/missing", async (c) => {
    const caller = c.get("caller");
    const limited = metaAllowed(caller, c);
    if (limited) return limited;
    const body = workspaceBlobsMissingRequestSchema.safeParse(await readJson(c));
    if (!body.success) return error(c, 400, "invalid_request", "Expected {sha256: [...]}.");
    const missing = await tx(caller, "other", (t) => missingBlobs(t, caller, body.data.sha256));
    return c.json({ missing });
  });

  app.get("/blobs/lost", async (c) => {
    const caller = c.get("caller");
    const limited = metaAllowed(caller, c);
    if (limited) return limited;
    const lost = await tx(caller, "other", (t) => lostBlobs(t, caller));
    return c.json({ lost });
  });

  return app;
}
