import { withTeam, type KaijuDb } from "@kaiju/db";
import { isProjectKey, loadTree } from "../../projects/tree.js";
import type { BlobStore } from "../../retention/blobs.js";
import { ConversionStepError, type HistorySource } from "./objects.js";

/**
 * Where a conversion reads the project from (KOBE-765): each commit's tree from Postgres (one
 * short read per commit) and each file's bytes from the object store, only from the project's own
 * object tree (`isProjectKey`) and never more than the file's recorded size. A missing or short
 * object stops the attempt (`content_missing`, naming the file).
 */
export function historySource(
  db: KaijuDb,
  blobs: BlobStore,
  teamId: string,
  projectId: string,
): HistorySource {
  return {
    async loadTree(commitId) {
      if (commitId === null) return [];
      const tree = await withTeam(db, teamId, (tx) => loadTree(tx, teamId, commitId));
      return [...tree.values()].map((f) => ({
        path: f.path,
        sha256: f.sha256,
        size: f.size,
        executable: f.executable,
        blobRef: f.blobRef,
      }));
    },
    async readFile(file) {
      if (!isProjectKey(blobs.prefix, teamId, projectId, file.blobRef)) {
        throw new ConversionStepError("content_missing", file.path);
      }
      const object = await blobs.objects.get(file.blobRef).catch(() => null);
      if (!object) throw new ConversionStepError("content_missing", file.path);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of object.body) {
        const c = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        size += c.length;
        if (size > file.size) {
          object.body.destroy();
          throw new ConversionStepError("content_missing", file.path);
        }
        chunks.push(c);
      }
      return Buffer.concat(chunks, size);
    },
  };
}
