import { PROJECT_FILE_MAX_BYTES, PROJECT_FILES_MAX } from "@kobe/protocol";

/**
 * What a Repo's mirror can hold (KOBE-766, spec workspace-git G17): the files at the tip of the
 * host's default branch. One set of numbers for both sides (review R3-M1): the mirror refuses a
 * refresh beyond them (keeping the last mirror), and Convert to repo (KOBE-765) refuses up front a
 * project whose current files already exceed them, so a new Repo can always be mirrored.
 * The file count and file size are Kobe's own project limits; the content total is the
 * coordinator's number pending the owner (2026-11-23).
 */
export const GIT_REPO_MAX_FILES = PROJECT_FILES_MAX;
export const GIT_REPO_MAX_FILE_BYTES = PROJECT_FILE_MAX_BYTES;
export const GIT_REPO_MAX_CONTENT_BYTES = 512 * 1024 * 1024;

/** The current files' facts a conversion is checked on. */
export interface RepoContentFacts {
  readonly files: number;
  readonly bytes: number;
  readonly largest: number;
}

/** Which limit the files break, if any (counted as the mirror counts them: every file's bytes). */
export function repoContentRefusal(
  facts: RepoContentFacts,
): { readonly limit: "files" | "file_bytes" | "bytes"; readonly limitValue: number } | undefined {
  if (facts.files > GIT_REPO_MAX_FILES) return { limit: "files", limitValue: GIT_REPO_MAX_FILES };
  if (facts.largest > GIT_REPO_MAX_FILE_BYTES) {
    return { limit: "file_bytes", limitValue: GIT_REPO_MAX_FILE_BYTES };
  }
  if (facts.bytes > GIT_REPO_MAX_CONTENT_BYTES) {
    return { limit: "bytes", limitValue: GIT_REPO_MAX_CONTENT_BYTES };
  }
  return undefined;
}
