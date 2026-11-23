import type { RateLimitRule } from "../../rate-limit.js";

/**
 * Limits of Convert to repo (KOBE-765). Kobe projects hold at most 500 files of at most 50 MiB
 * each and at most 1000 commits (the history cap), so a conversion is bounded; these keep one
 * conversion's memory and time bounded on the server too.
 */

/**
 * Most distinct file content (bytes, all commits carried) one conversion pushes: the smaller of
 * this and the connection's push limit (G11, default 1 GiB). The ceiling is tied to the work
 * folder (coordinator's number, 2026-11-23, pending the owner): the loose objects (at most this,
 * compressed) plus one batch's pack (at most this) fit the server's /tmp `sizeLimit` (6 GiB,
 * `charts/kobe/values.yaml` `server.tmpSizeLimit`) with room for its other temporary files.
 * Packed data is never larger than the content it packs, so this bounds the packed size too.
 */
export const GIT_CONVERSION_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Memory does not depend on commit size (round 2): each batch is written as a pack to the work
 * folder one object at a time and streamed from disk (`pack.ts`). The largest single object is one
 * file, at most {@link GIT_CONVERSION_MAX_FILE_BYTES}; with zlib's buffers a conversion holds about
 * three of them (the stored bytes, the loose object, its packed form), ≈ 300 MiB at worst, within
 * the server's 1 GiB memory limit with one conversion per replica. Kobe's own file cap (50 MiB)
 * keeps it nearer 150 MiB today.
 */
export const GIT_CONVERSION_MAX_FILE_BYTES = 100 * 1024 * 1024;

/** Commits are pushed in batches of about this much new content, oldest first. */
export const GIT_CONVERSION_BATCH_BYTES = 32 * 1024 * 1024;

/** The request cap of one push: a batch may be the whole history (one large commit). */
export const GIT_CONVERSION_MAX_REQUEST_BYTES = GIT_CONVERSION_MAX_BYTES + 64 * 1024 * 1024;

/** A replica's claim on a running conversion, renewed while it works. */
export const GIT_CONVERSION_LEASE_MS = 2 * 60_000;
export const GIT_CONVERSION_HEARTBEAT_MS = 30_000;

/** How often a replica looks for running conversions nobody holds (a restart, a crash). */
export const GIT_CONVERSION_SWEEP_MS = 2 * 60_000;

/**
 * Where conversions build their objects: a dedicated folder under the server's temp dir (the
 * chart's /tmp emptyDir), one subfolder per run, removed when the run ends; at start-up and on
 * every sweep the folders of runs that died with an earlier process are removed. With one
 * conversion per replica and the size limits above, a replica holds at most about one project's
 * content there (≤ 2 GiB); a run checks for room first (`server_capacity`).
 */
export const GIT_CONVERSION_DIR_NAME = "kobe-git-conversions";
export const GIT_CONVERSION_WORK_PREFIX = "run-";
/** Free space a run needs beyond its project's content. */
export const GIT_CONVERSION_DISK_MARGIN_BYTES = 64 * 1024 * 1024;

/** Conversions one replica runs at once (review M3); the rest wait for the sweep. */
export const GIT_CONVERSION_SLOTS = 1;
/**
 * The poison guard (review M3): the sweep fails an attempt (`interrupted`) instead of claiming it
 * again when the last claims ended with the replica gone and no progress this many times in a row,
 * or after this many automatic resumes in all. A person's retry resets both.
 */
export const GIT_CONVERSION_MAX_STALLS = 2;
export const GIT_CONVERSION_MAX_RESUMES = 5;

/** One step's deadline for all its exchanges with the host. */
export const GIT_CONVERSION_STEP_DEADLINE_MS = 30 * 60_000;

/** Starts and retries per member (`git-conversions:<user>`). */
export const GIT_CONVERSION_RATE: RateLimitRule = { windowMs: 60 * 60_000, max: 10 };

/** The description marker that lets an interrupted attempt recognise the repository it created. */
export const conversionMarker = (conversionId: string): string => `kobe-conversion:${conversionId}`;
