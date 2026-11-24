import { Readable } from "node:stream";
import { Hono } from "hono";
import { revertProjectRequestSchema, workspacePathSchema } from "@kaiju/protocol";
import { type TeamVariables } from "../../authz/middleware.js";
import { revertTo } from "../../projects/commits.js";
import { fileAt, headZip, servable } from "../../projects/history.js";
import type { TreeFile } from "../../projects/tree.js";
import { logger } from "../../logger.js";
import { attachmentDisposition } from "../../workspace-files/paths.js";
import { invalidRequest, param, parseBody } from "../../http/request.js";
import {
  idParam,
  seqParam,
  fail,
  notFound,
  noStorage,
  commitAnswer,
  type CommitKit,
} from "./shared.js";

/** A commit's files, reverting a commit, and the head as a zip (GV5). */
export function projectHistoryRoutes(kit: CommitKit): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const { deps, db, owner, withProject } = kit;

  app.get("/:id/commits/:seq/files/*", async (c) => {
    const seq = param(c, "seq", seqParam);
    const marker = `/commits/${c.req.param("seq") ?? ""}/files/`;
    const raw = c.req.path.slice(c.req.path.indexOf(marker) + marker.length);
    let decoded: string;
    try {
      decoded = raw.split("/").map(decodeURIComponent).join("/");
    } catch {
      return invalidRequest(c, "That is not a valid file path.");
    }
    const path = workspacePathSchema.safeParse(decoded);
    if (!seq.success || !path.success) return invalidRequest(c, "That is not a valid file path.");
    const blobs = deps.blobs;
    if (!blobs) return noStorage(c);
    let file: TreeFile | undefined;
    const found = await withProject(c, "view", async (tx, access) => {
      file = await fileAt(tx, access.project.teamId, access.project.id, seq.data, path.data);
      if (!file || !servable(blobs, access.project.teamId, access.project.id, file.blobRef)) {
        return fail(c, 404, "not_found", "No such file at that commit.");
      }
      return c.body(null, 200);
    });
    if (found.status !== 200 || file === undefined) return found;
    const object = await blobs.objects.get(file.blobRef);
    if (!object)
      return fail(c, 502, "content_missing", "The file's content is missing in storage.");
    return new Response(Readable.toWeb(object.body) as ReadableStream, {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(file.size),
        "content-disposition": attachmentDisposition(file.path),
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      },
    });
  });

  app.post("/:id/commits/:seq/revert", async (c) => {
    const id = param(c, "id", idParam);
    const seq = param(c, "seq", seqParam);
    if (!id.success) return notFound(c);
    if (!seq.success) return commitAnswer(c, { status: "commit_not_found" });
    const body = await parseBody(c, revertProjectRequestSchema);
    if (!body) return invalidRequest(c, "Optionally give a message (1 to 500 characters).");
    const result = await revertTo(
      { db, mounts: deps.projectMounts, log: logger },
      owner(c),
      id.data,
      seq.data,
      body.message,
    );
    return commitAnswer(c, result);
  });

  /** GV5: the head as a zip (readers may download every file anyway). */
  app.get("/:id/download", async (c) => {
    const blobs = deps.blobs;
    if (!blobs) return noStorage(c);
    let slug = "";
    let projectId = "";
    const allowed = await withProject(c, "view", (_tx, access) => {
      slug = access.project.slug;
      projectId = access.project.id;
      return Promise.resolve(c.body(null, 200));
    });
    if (allowed.status !== 200) return allowed;
    const body = Readable.toWeb(
      Readable.from(headZip(db, blobs, c.get("team").id, projectId, slug)),
    ) as ReadableStream<Uint8Array>;
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-disposition": attachmentDisposition(`${slug}.zip`),
        "cache-control": "private, no-store",
      },
    });
  });

  return app;
}
