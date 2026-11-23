import { PROJECT_FILE_MAX_BYTES, PROJECT_FILES_MAX } from "@kobe/protocol";
import type { RateLimitRule } from "../../rate-limit.js";

/**
 * Limits of the Repo mirror (KOBE-766, spec workspace-git G17, G20). A refresh is bounded in
 * time, memory, disk and host calls; it never holds a transaction during a host call, and a
 * failed refresh leaves the last mirror in place (reads never wait for it).
 */

/** The timer (G17: default 5 minutes, no webhooks): a Repo not refreshed for this long is due. */
export const GIT_MIRROR_INTERVAL_MS = 5 * 60_000;
/** How often the mirror job looks for due Repos (one replica at a time). */
export const GIT_MIRROR_SWEEP_MS = 60_000;
/**
 * Opening a Repo refreshes it when the last attempt is older than this: the timer's interval, so
 * opens never make a Repo cost more of the connection's shared read budget than the timer does
 * (review L3).
 */
export const GIT_MIRROR_OPEN_STALE_MS = GIT_MIRROR_INTERVAL_MS;
/**
 * A deleted repository, or one the host stopped showing, is checked again this often (review M2):
 * a narrowed App installation or token that is widened again brings the Repo back.
 */
export const GIT_MIRROR_GONE_RECHECK_MS = 6 * 60 * 60_000;
/** "Not found" answers in a row (spread by the back-off, ≥ 35 minutes) before a Repo is `deleted`. */
export const GIT_MIRROR_GONE_CONFIRMATIONS = 4;
/** One refresh's whole run, local work included, stays well inside its lease (review M1). */
export const GIT_MIRROR_RUN_MS = 8 * 60_000;
/**
 * A push through the egress proxy is decided before its data is sent: the refresh it asks for is
 * due this long after the decision, so it sees the pushed commits.
 */
export const GIT_MIRROR_PUSH_DELAY_MS = 30_000;

/** Back-off after a failed refresh: doubling from the base to the cap (or the host's reset). */
export const GIT_MIRROR_BACKOFF_BASE_MS = 5 * 60_000;
export const GIT_MIRROR_BACKOFF_MAX_MS = 6 * 60 * 60_000;

/** A replica's claim on one Repo's refresh (longer than the deadline, so it never lapses mid-run). */
export const GIT_MIRROR_LEASE_MS = 10 * 60_000;
/** One refresh's deadline for all its exchanges with the host. */
export const GIT_MIRROR_DEADLINE_MS = 5 * 60_000;
/**
 * Refreshes one replica runs at once; the rest wait for the next pass. Each holds at most about
 * 200 MiB of memory (a delta, its base and the result, each within the file cap, plus a read
 * window), so two fit the server's 1 GiB limit next to its other work.
 */
export const GIT_MIRROR_SLOTS = 2;
/** Due Repos one pass takes per Workspace (oldest first). */
export const GIT_MIRROR_PER_TEAM = 20;

/** The pack one refresh may download, streamed to the work folder (never held in memory). */
export const GIT_MIRROR_MAX_PACK_BYTES = 128 * 1024 * 1024;
/**
 * Every object of a fetch together, inflated (the head's files plus the newest commits' trees,
 * commits and changed files): the head's content cap plus room for that history.
 */
export const GIT_MIRROR_MAX_INFLATED_BYTES = 768 * 1024 * 1024;
/**
 * Bytes one refresh may put on disk: the pack plus every object written loose (review R2-M1).
 * Two refreshes at once (1.5 GiB) and a conversion (about 4 GiB) stay inside the server's /tmp
 * limit (`server.tmpSizeLimit`, 6 GiB).
 */
export const GIT_MIRROR_MAX_DISK_BYTES = 768 * 1024 * 1024;
/** Most objects in one fetched pack: 25 commits of a project of at most 500 files need far fewer. */
export const GIT_MIRROR_MAX_OBJECTS = 20_000;
/** A Repo's mirrored files follow Kobe's project limits: at most this many files... */
export const GIT_MIRROR_MAX_FILES = PROJECT_FILES_MAX;
/** ...of at most this size each... */
export const GIT_MIRROR_MAX_FILE_BYTES = PROJECT_FILE_MAX_BYTES;
/** ...and at most this much content in all (review R2-M1: within the per-refresh disk budget). */
export const GIT_MIRROR_MAX_BYTES = 512 * 1024 * 1024;
/** Free space a refresh needs in its work folder beyond the pack and its objects. */
export const GIT_MIRROR_DISK_MARGIN_BYTES = 64 * 1024 * 1024;

/** A member's Refresh action (`git-mirror-refresh:<user>`). */
export const GIT_MIRROR_REFRESH_RATE: RateLimitRule = { windowMs: 10 * 60_000, max: 30 };
/** Relink and detach per Workspace admin (`git-mirror-manage:<user>`). */
export const GIT_MIRROR_MANAGE_RATE: RateLimitRule = { windowMs: 60 * 60_000, max: 20 };

/** Where refreshes fetch: a dedicated folder under the server's temp dir, one subfolder per run. */
export const GIT_MIRROR_DIR_NAME = "kobe-git-mirror";
export const GIT_MIRROR_WORK_PREFIX = "run-";

/** The back-off after `failures` failures in a row (1 = the first failure). */
export function mirrorBackoffMs(failures: number): number {
  const steps = Math.max(0, Math.min(failures - 1, 20));
  return Math.min(GIT_MIRROR_BACKOFF_BASE_MS * 2 ** steps, GIT_MIRROR_BACKOFF_MAX_MS);
}
