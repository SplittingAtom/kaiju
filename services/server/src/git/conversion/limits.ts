import type { RateLimitRule } from "../../rate-limit.js";

/**
 * Limits of Convert to repo (KOBE-765). Kobe projects hold at most 500 files of at most 50 MiB
 * each and at most 1000 commits (the history cap), so a conversion is bounded; these keep one
 * conversion's memory and time bounded on the server too.
 */

/**
 * Most distinct file content (bytes, all commits carried) one conversion pushes: the smaller of
 * this and the connection's push limit (G11, default 1 GiB).
 */
export const GIT_CONVERSION_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Most new content one git commit may bring (bytes). A push of one batch is held in memory as a
 * packfile (isomorphic-git builds packs in memory), so a single commit larger than this is refused
 * before anything starts (`commit_too_large`), naming the commit.
 */
export const GIT_CONVERSION_MAX_PUSH_BYTES = 256 * 1024 * 1024;

/** Commits are pushed in batches of about this much new content, oldest first. */
export const GIT_CONVERSION_BATCH_BYTES = 32 * 1024 * 1024;

/** The request cap of one push (a batch's pack plus git's framing). */
export const GIT_CONVERSION_MAX_REQUEST_BYTES = GIT_CONVERSION_MAX_PUSH_BYTES + 16 * 1024 * 1024;

/** A replica's claim on a running conversion, renewed while it works. */
export const GIT_CONVERSION_LEASE_MS = 2 * 60_000;
export const GIT_CONVERSION_HEARTBEAT_MS = 30_000;

/** How often a replica looks for running conversions nobody holds (a restart, a crash). */
export const GIT_CONVERSION_SWEEP_MS = 2 * 60_000;

/** One step's deadline for all its exchanges with the host. */
export const GIT_CONVERSION_STEP_DEADLINE_MS = 30 * 60_000;

/** Starts and retries per member (`git-conversions:<user>`). */
export const GIT_CONVERSION_RATE: RateLimitRule = { windowMs: 60 * 60_000, max: 10 };

/**
 * The largest file each host accepts (G16: "a file the host would reject"). GitHub refuses files
 * over 100 MiB; Gitea and Forgejo have no default limit. Kobe's own file cap (50 MiB) is below
 * both, so this matters only if that cap is raised.
 */
export const GIT_HOST_MAX_FILE_BYTES: Readonly<Record<string, number>> = {
  github: 100 * 1024 * 1024,
};

/** The description marker that lets an interrupted attempt recognise the repository it created. */
export const conversionMarker = (conversionId: string): string => `kobe-conversion:${conversionId}`;
