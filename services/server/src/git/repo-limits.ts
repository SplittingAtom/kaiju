import { PROJECT_FILE_MAX_BYTES, PROJECT_FILES_MAX } from "@kobe/protocol";

/**
 * What a Repo's mirror can hold (KOBE-766, spec workspace-git G17): the files at the tip of the
 * host's default branch. One set of numbers for both sides (review R3-M1): the mirror refuses a
 * refresh beyond them (keeping the last mirror, "too large to mirror"), and Convert to repo
 * (KOBE-765) refuses up front a project whose current files already exceed them, so a new Repo
 * can always be mirrored. Every other mirror size (the pack it downloads, what it inflates, what
 * it puts on disk) is derived from these (review R4-M1), so content within them always fits.
 * The file count and file size are Kobe's own project limits; the content total is the
 * coordinator's number pending the owner (2026-11-23).
 */
export interface RepoLimits {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxContentBytes: number;
}

const MiB = 1024 * 1024;

export const GIT_REPO_LIMITS: RepoLimits = Object.freeze({
  maxFiles: PROJECT_FILES_MAX,
  maxFileBytes: PROJECT_FILE_MAX_BYTES,
  maxContentBytes: 256 * MiB,
});
export const GIT_REPO_MAX_FILES = GIT_REPO_LIMITS.maxFiles;
export const GIT_REPO_MAX_FILE_BYTES = GIT_REPO_LIMITS.maxFileBytes;
export const GIT_REPO_MAX_CONTENT_BYTES = GIT_REPO_LIMITS.maxContentBytes;

/** The sizes one mirror refresh may reach, all derived from the Repo limits. */
export interface MirrorFetchLimits extends RepoLimits {
  /**
   * The pack downloaded: the head's content (incompressible content packs to about its own size)
   * plus the newest commits' history.
   */
  readonly maxPackBytes: number;
  /** Every object inflated: the head's content plus the history margin. */
  readonly maxInflatedBytes: number;
  /** On disk at once: the pack plus every object written loose (plus zlib's overhead). */
  readonly maxDiskBytes: number;
}

/**
 * The history margin: trees, commits and files the newest 25 commits changed, beyond the head
 * (half the content cap, at least 16 MiB). A Repo whose recent history is heavier than that is
 * "too large to mirror" until those commits fall out of the newest 25.
 */
export function mirrorFetchLimits(repo: RepoLimits = GIT_REPO_LIMITS): MirrorFetchLimits {
  const history = Math.max(16 * MiB, Math.floor(repo.maxContentBytes / 2));
  const pack = repo.maxContentBytes + history;
  const inflated = repo.maxContentBytes + history;
  return {
    ...repo,
    maxPackBytes: pack,
    maxInflatedBytes: inflated,
    maxDiskBytes: pack + inflated + Math.max(16 * MiB, Math.floor(inflated / 8)),
  };
}

/** The current files' facts a conversion is checked on. */
export interface RepoContentFacts {
  readonly files: number;
  readonly bytes: number;
  readonly largest: number;
}

/** Which limit the files break, if any (counted as the mirror counts them: every file's bytes). */
export function repoContentRefusal(
  facts: RepoContentFacts,
  limits: RepoLimits = GIT_REPO_LIMITS,
): { readonly limit: "files" | "file_bytes" | "bytes"; readonly limitValue: number } | undefined {
  if (facts.files > limits.maxFiles) return { limit: "files", limitValue: limits.maxFiles };
  if (facts.largest > limits.maxFileBytes) {
    return { limit: "file_bytes", limitValue: limits.maxFileBytes };
  }
  if (facts.bytes > limits.maxContentBytes) {
    return { limit: "bytes", limitValue: limits.maxContentBytes };
  }
  return undefined;
}
