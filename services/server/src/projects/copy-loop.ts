import { Transform, type TransformCallback } from "node:stream";
import { withTeam, type KobeDb } from "@kobe/db";
import type { Logger } from "pino";
import { resolveMime, SNIFF_BYTES } from "../uploads/mime.js";
import { verifyingStream, type ObjectStore } from "../workspace-sync/object-store.js";
import { overLimit, type TeamLimits } from "./storage.js";
import { queueProjectBlobs } from "./tree.js";

/**
 * The plan, copy, write loop every multi-step project write shares (KOBE-780, P2-45): a checkout's
 * commit (`commits.ts`), promote to project (`promote.ts`) and an accepted proposal
 * (`from-proposal.ts`). No transaction is held while bytes move:
 *  1. plan (read, its own transaction): the caller's checks, and which contents to store;
 *  2. store (no transaction): the quota checked early, every missing content's key reserved in
 *     `retention_blob_deletions` (due in hours, so a crash leaves nothing the blob deleter won't
 *     take), then each content stored through a hash and size check;
 *  3. write (the caller's locks): plan again; a content not stored yet sends the loop back to 1.
 */

/** One content to store at its content-addressed key. */
export interface Copy {
  readonly sha256: string;
  readonly size: number;
  /** The object the bytes come from (a commit or promote; unused when the caller stores bytes). */
  readonly source: string;
  readonly key: string;
}

/** Thrown when a source object is missing or fails its hash/size check. */
export class CopyFailed extends Error {}

/**
 * Copies `from` to `to` through a hash and size check (the store never completes an object whose
 * bytes do not match), and returns the first bytes for the mime type.
 */
export async function copyVerified(objects: ObjectStore, copy: Copy): Promise<Uint8Array> {
  const source = await objects.get(copy.source);
  if (!source) throw new CopyFailed("source object missing");
  const head: Buffer[] = [];
  let seen = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _enc, done: TransformCallback) {
      if (seen < SNIFF_BYTES) head.push(chunk.subarray(0, SNIFF_BYTES - seen));
      seen += chunk.length;
      done(null, chunk);
    },
  });
  const verified = verifyingStream(copy.sha256, copy.size);
  source.body.once("error", (err) => verified.destroy(err));
  tap.once("error", (err) => verified.destroy(err));
  source.body.pipe(tap).pipe(verified);
  try {
    await objects.put(copy.key, verified, copy.size);
  } catch (err) {
    source.body.destroy();
    throw new CopyFailed(err instanceof Error ? err.message : "copy failed");
  }
  return Buffer.concat(head);
}

/** The default step 2 of one copy: from its source object, the mime type from its first bytes. */
export const copyFrom =
  (objects: ObjectStore) =>
  async (copy: Copy): Promise<string> =>
    resolveMime(await copyVerified(objects, copy), undefined);

export const sumSizes = (copies: readonly Copy[]): number => copies.reduce((n, c) => n + c.size, 0);

const MAX_ROUNDS = 3;

export interface CopyLoop<P, R> {
  readonly db: KobeDb;
  /** Whose write it is (the reservation's team, project and user). */
  readonly teamId: string;
  readonly projectId: string;
  readonly userId: string;
  readonly limits: TeamLimits;
  readonly log: Pick<Logger, "warn">;
  /** The warning logged when a content could not be stored. */
  readonly failure: string;
  /** Step 1: a plan, or the answer now. */
  plan(): Promise<P | R>;
  isPlan(planned: P | R): planned is P;
  /** The contents the plan needs stored (held contents excluded). */
  copiesOf(plan: P): readonly Copy[];
  /** Step 2 of one copy, returning its mime type; undefined when there is no object storage. */
  readonly store: ((copy: Copy, plan: P) => Promise<string>) | undefined;
  /** Step 3, with the mime type of every content stored so far (by sha256). */
  write(mimes: ReadonlyMap<string, string>): Promise<R | "again">;
  readonly refuse: {
    quota(limit: "bytes" | "objects"): R;
    storage(): R;
    /** The plan kept changing for {@link MAX_ROUNDS} rounds. */
    changed(): R;
  };
}

/** Runs steps 1 to 3 (see the module header) until the write lands or refuses. */
export async function copyThenWrite<P, R>(loop: CopyLoop<P, R>): Promise<R> {
  const mimes = new Map<string, string>();
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const planned = await loop.plan();
    if (!loop.isPlan(planned)) return planned;
    const copies = loop.copiesOf(planned);
    const missing = copies.filter((c) => !mimes.has(c.sha256));
    if (missing.length > 0) {
      const store = loop.store;
      if (!store) return loop.refuse.storage();
      // Fail fast on the quota before moving bytes (the write step checks again under the lock).
      const early = await withTeam(loop.db, loop.teamId, (tx) =>
        overLimit(tx, loop.teamId, loop.limits, sumSizes(copies), copies.length),
      );
      if (early !== undefined) return loop.refuse.quota(early);
      await withTeam(loop.db, loop.teamId, (tx) =>
        queueProjectBlobs(
          tx,
          loop.teamId,
          loop.projectId,
          loop.userId,
          missing.map((c) => c.key),
          "reservation",
        ),
      );
      for (const copy of missing) {
        try {
          mimes.set(copy.sha256, await store(copy, planned));
        } catch (err) {
          loop.log.warn({ err, team_id: loop.teamId }, loop.failure);
          return loop.refuse.storage();
        }
      }
    }
    const written = await loop.write(mimes);
    if (written !== "again") return written;
  }
  return loop.refuse.changed();
}
