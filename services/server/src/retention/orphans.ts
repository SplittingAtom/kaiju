import {
  BLOB_REF_COLUMNS,
  isUnderLegalHold,
  lockLegalHolds,
  sql,
  withTeam,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import type { ListedObject } from "../workspace-sync/object-store.js";
import type { BlobStore } from "./blobs.js";
import { deleteBounded } from "./bounded-delete.js";

/**
 * Orphaned object sweep (KOBE-189), a step of the nightly retention pass (so one replica runs it
 * at a time, under the pass's advisory lock). It deletes two kinds of leftovers of crashes:
 *
 *  - upload staging objects, `<prefix>teams/<team>/users/<user>/workspace/incoming/<uuid>`
 *    (KOBE-184: copied to the content key, then deleted; a crash in between leaves one);
 *  - fork-copied entry bodies, `<prefix>teams/<team>/threads/<id>/entries/<64 hex>` where no
 *    `threads` row has that id (KOBE-236: a crash between the copy and the commit);
 *  - member-level uploads, `<prefix>teams/<team>/users/<user>/uploads/<uuid>` (KOBE-740: an
 *    upload without a thread is stored before its `files` row commits, outside every tree the
 *    release queue may delete in);
 *  - skill bundle attempts (KOBE-740: stored before the version row commits, removed only on a
 *    caught failure): the team's, `<prefix>skills/teams/<team>/<sha256>/<uuid>`, and its
 *    members' personal ones, `<prefix>skills/users/<user>/<sha256>/<uuid>`;
 *  - skill eval objects, `<prefix>teams/<team>/skill-evals/<uuid>/{bundle,fixtures}-<sha256>.zip`
 *    (KOBE-740: stored before the run row commits, and deleted after a purge commits, logged
 *    "orphaned" when that delete fails).
 *
 * Safety: only keys of exactly those shapes inside the configured prefix are ever listed or
 * deleted (the bucket may be shared); only objects older than {@link ORPHAN_GRACE_MS}, so uploads
 * and forks in flight are never touched; never a key any registered blob column of the team
 * references (`BLOB_REF_COLUMNS`; for skill bundles the site-wide columns too: personal and
 * catalog versions) or the release queue still holds; never under a legal hold (staging, uploads
 * and personal bundles: the key's user, or a team-wide hold; fork bodies, team bundles and eval
 * objects have no owner, so any hold in the team). A personal bundle never committed belongs to no
 * record; a hold on its owner in another team is not visible to this team's pass. The delete runs
 * in a transaction holding the legal-hold lock shared, after those checks
 * were repeated. Listing is paged, and one sweep deletes at most {@link MAX_DELETIONS} per team.
 * Logs counts only.
 */
export const ORPHAN_GRACE_MS = 24 * 60 * 60_000;
export const MAX_DELETIONS = 1000;
/** Listing pages (of {@link PAGE_SIZE}) one sweep reads per team and listing before stopping. */
export const MAX_PAGES = 200;
const PAGE_SIZE = 1000;
const BATCH = 100;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface OrphanCounts {
  /** Staging objects deleted. */
  readonly staging: number;
  /** Fork-copied entry bodies deleted. */
  readonly forks: number;
  /** Member-level uploads without a `files` row deleted (KOBE-740). */
  readonly uploads: number;
  /** Skill bundle attempts without a version row deleted, team and personal (KOBE-740). */
  readonly skills: number;
  /** Skill eval objects without a run row deleted (KOBE-740). */
  readonly evals: number;
}

export interface OrphanOptions {
  readonly graceMs?: number;
  readonly maxDeletions?: number;
  readonly stop?: () => boolean;
}

interface Candidate {
  readonly key: string;
  /** Present for staging objects (the workspace owner). */
  readonly userId: string | null;
}

/** All objects under `prefix` (one level when `delimiter`), paged, at most {@link MAX_PAGES}. */
async function* pages(store: BlobStore, prefix: string, delimiter?: string) {
  let cursor: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await store.objects.list(prefix, {
      limit: PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
      ...(delimiter ? { delimiter } : {}),
    });
    yield page;
    if (page.next === undefined) return;
    cursor = page.next;
  }
}

const old = (o: ListedObject, cutoff: number) => o.lastModified.getTime() < cutoff;

async function workspaceUsers(db: KobeDb, teamId: string): Promise<string[]> {
  return withTeam(db, teamId, async (tx) => {
    const res = await tx.execute<{ user_id: string }>(sql`
      SELECT user_id FROM team_members WHERE team_id = ${teamId}
      UNION SELECT user_id FROM workspace_files WHERE team_id = ${teamId}`);
    return res.rows.map((r) => r.user_id);
  });
}

/**
 * Users whose staging folders are swept: team members and users with workspace rows, plus (KOBE-243)
 * the user folders found under `<prefix>teams/<team>/users/` that match neither, i.e. removed
 * members whose uploads died with a crash. The same grace, reference and hold checks apply to them
 * (a hold on a removed user still protects their staging objects).
 */
async function stagingUsers(db: KobeDb, teamId: string, store: BlobStore): Promise<string[]> {
  const known = await workspaceUsers(db, teamId);
  const root = `${store.prefix}teams/${teamId}/users/`;
  const folder = new RegExp(`^${escape(root)}(${UUID})/$`);
  const seen = new Set(known);
  for await (const page of pages(store, root, "/")) {
    for (const p of page.prefixes) {
      const id = folder.exec(p)?.[1];
      if (id !== undefined) seen.add(id);
    }
  }
  return [...seen];
}

interface Listing {
  /** The folder listed (no delimiter: everything below it). */
  readonly prefix: string;
  /** What must follow the prefix, as a regular expression source. */
  readonly tail: string;
  /** Whose legal hold protects the objects; null: any hold in the team. */
  readonly holdUser: string | null;
}

/** Old objects of exactly the listings' shapes, at most `max`. */
async function candidatesIn(
  store: BlobStore,
  listings: readonly Listing[],
  cutoff: number,
  max: number,
  stop: () => boolean,
): Promise<Candidate[]> {
  const found: Candidate[] = [];
  for (const { prefix, tail, holdUser } of listings) {
    const shape = new RegExp(`^${escape(prefix)}${tail}$`);
    for await (const page of pages(store, prefix)) {
      for (const o of page.objects) {
        if (shape.test(o.key) && old(o, cutoff)) found.push({ key: o.key, userId: holdUser });
      }
      if (found.length >= max || stop()) return found.slice(0, max);
    }
  }
  return found;
}

async function stagingCandidates(
  db: KobeDb,
  teamId: string,
  store: BlobStore,
  cutoff: number,
  max: number,
  stop: () => boolean,
): Promise<Candidate[]> {
  const listings = (await stagingUsers(db, teamId, store)).map((userId) => ({
    prefix: `${store.prefix}teams/${teamId}/users/${userId}/workspace/incoming/`,
    tail: UUID,
    holdUser: userId,
  }));
  return candidatesIn(store, listings, cutoff, max, stop);
}

/** KOBE-740: member-level uploads (`uploads/store.ts`), also of removed members (KOBE-243). */
async function uploadCandidates(
  db: KobeDb,
  teamId: string,
  store: BlobStore,
  cutoff: number,
  max: number,
  stop: () => boolean,
): Promise<Candidate[]> {
  const listings = (await stagingUsers(db, teamId, store)).map((userId) => ({
    prefix: `${store.prefix}teams/${teamId}/users/${userId}/uploads/`,
    tail: UUID,
    holdUser: userId,
  }));
  return candidatesIn(store, listings, cutoff, max, stop);
}

const SKILL_ATTEMPT = `[0-9a-f]{64}/${UUID}`;

/**
 * KOBE-740: skill bundle attempts (`skills/storage.ts skillBundleKey`): the team's, and the
 * personal ones of the team's members and workspace users.
 */
async function skillCandidates(
  db: KobeDb,
  teamId: string,
  store: BlobStore,
  cutoff: number,
  max: number,
  stop: () => boolean,
): Promise<Candidate[]> {
  const listings: Listing[] = [
    { prefix: `${store.prefix}skills/teams/${teamId}/`, tail: SKILL_ATTEMPT, holdUser: null },
    ...(await workspaceUsers(db, teamId)).map((userId) => ({
      prefix: `${store.prefix}skills/users/${userId}/`,
      tail: SKILL_ATTEMPT,
      holdUser: userId,
    })),
  ];
  return candidatesIn(store, listings, cutoff, max, stop);
}

async function existingThreads(db: KobeDb, teamId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  return withTeam(db, teamId, async (tx) => {
    const res = await tx.execute<{ id: string }>(sql`
      SELECT id FROM threads WHERE team_id = ${teamId}
         AND id = ANY(ARRAY[${sql.join(
           ids.map((i) => sql`${i}`),
           sql`, `,
         )}]::uuid[])`);
    return new Set(res.rows.map((r) => r.id));
  });
}

async function forkCandidates(
  db: KobeDb,
  teamId: string,
  store: BlobStore,
  cutoff: number,
  max: number,
  stop: () => boolean,
): Promise<Candidate[]> {
  const root = `${store.prefix}teams/${teamId}/threads/`;
  const folder = new RegExp(`^${escape(root)}(${UUID})/$`);
  const found: Candidate[] = [];
  for await (const page of pages(store, root, "/")) {
    const dirs = page.prefixes.flatMap((p) => folder.exec(p)?.[1] ?? []);
    const live = await existingThreads(db, teamId, dirs);
    for (const id of dirs.filter((d) => !live.has(d))) {
      const prefix = `${root}${id}/entries/`;
      const shape = new RegExp(`^${escape(prefix)}[0-9a-f]{64}$`);
      for await (const body of pages(store, prefix)) {
        for (const o of body.objects) {
          if (shape.test(o.key) && old(o, cutoff)) found.push({ key: o.key, userId: null });
        }
        if (found.length >= max) return found.slice(0, max);
      }
    }
    if (stop()) break;
  }
  return found;
}

/**
 * Keys among `keys` that a registered blob column of the team references or the queue holds; with
 * `site`, also the site-wide columns (personal and catalog skill versions, which have no team).
 */
async function protectedKeys(
  tx: KobeTx,
  teamId: string,
  keys: string[],
  site: boolean,
): Promise<Set<string>> {
  const list = sql`ARRAY[${sql.join(
    keys.map((k) => sql`${k}`),
    sql`, `,
  )}]::text[]`;
  const keep = new Set<string>();
  for (const ref of BLOB_REF_COLUMNS.filter((r) => site || !r.site)) {
    const team = ref.site ? sql`` : sql`x.team_id = ${teamId} AND `;
    const res = await tx.execute<{ key: string }>(sql`
      SELECT DISTINCT x.${sql.identifier(ref.column)} AS key FROM ${sql.identifier(ref.table)} x
       WHERE ${team}x.${sql.identifier(ref.column)} = ANY(${list})`);
    for (const row of res.rows) keep.add(row.key);
  }
  const queued = await tx.execute<{ key: string }>(sql`
    SELECT key FROM retention_blob_deletions WHERE team_id = ${teamId} AND key = ANY(${list})`);
  for (const row of queued.rows) keep.add(row.key);
  return keep;
}

/** Deletes one batch under the shared legal-hold lock; returns how many objects went. */
async function deleteBatch(
  db: KobeDb,
  teamId: string,
  store: BlobStore,
  batch: Candidate[],
): Promise<number> {
  return withTeam(db, teamId, async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = '5s'`));
    await lockLegalHolds(tx);
    const skillRoot = `${store.prefix}skills/`;
    const keep = await protectedKeys(
      tx,
      teamId,
      batch.map((c) => c.key),
      batch.some((c) => c.key.startsWith(skillRoot)),
    );
    const doomed: string[] = [];
    for (const c of batch) {
      if (keep.has(c.key)) continue;
      // The key's user's (or a team-wide) hold; ownerless shapes (fork bodies, team skill
      // bundles): any hold in the team.
      if (await isUnderLegalHold(tx, teamId, c.userId)) continue;
      doomed.push(c.key);
    }
    if (doomed.length > 0) await deleteBounded(store.objects, doomed, store.deleteTimeoutMs);
    return doomed.length;
  });
}

async function deleteAll(
  db: KobeDb,
  teamId: string,
  store: BlobStore,
  found: Candidate[],
): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < found.length; i += BATCH) {
    deleted += await deleteBatch(db, teamId, store, found.slice(i, i + BATCH));
  }
  return deleted;
}

export const NO_ORPHANS: OrphanCounts = { staging: 0, forks: 0, uploads: 0, skills: 0, evals: 0 };

/** KOBE-740: skill eval objects (`skills/evals/storage.ts evalTree`) no run row names. */
async function evalCandidates(
  _db: KobeDb,
  teamId: string,
  store: BlobStore,
  cutoff: number,
  max: number,
  stop: () => boolean,
): Promise<Candidate[]> {
  const listing: Listing = {
    prefix: `${store.prefix}teams/${teamId}/skill-evals/`,
    tail: `${UUID}/(bundle|fixtures)-[0-9a-f]{64}\\.zip`,
    holdUser: null,
  };
  return candidatesIn(store, [listing], cutoff, max, stop);
}

type Finder = (
  db: KobeDb,
  teamId: string,
  store: BlobStore,
  cutoff: number,
  max: number,
  stop: () => boolean,
) => Promise<Candidate[]>;

const SHAPES: readonly (readonly [keyof OrphanCounts, Finder])[] = [
  ["staging", stagingCandidates],
  ["forks", forkCandidates],
  ["uploads", uploadCandidates],
  ["skills", skillCandidates],
  ["evals", evalCandidates],
];

export async function sweepOrphanObjects(
  db: KobeDb,
  teamId: string,
  store: BlobStore,
  options: OrphanOptions = {},
): Promise<OrphanCounts> {
  const cutoff = Date.now() - (options.graceMs ?? ORPHAN_GRACE_MS);
  const max = options.maxDeletions ?? MAX_DELETIONS;
  const stop = options.stop ?? (() => false);
  const counts: Record<keyof OrphanCounts, number> = { ...NO_ORPHANS };
  let deleted = 0;
  for (const [i, [shape, find]] of SHAPES.entries()) {
    // The first shape always runs (as before KOBE-740); the others only with time and room left.
    if (i > 0 && (stop() || deleted >= max)) break;
    counts[shape] = await deleteAll(
      db,
      teamId,
      store,
      await find(db, teamId, store, cutoff, max - deleted, stop),
    );
    deleted += counts[shape];
  }
  return counts;
}
