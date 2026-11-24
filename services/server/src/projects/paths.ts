import { CONFLICT_COPY_PATTERN, PROJECT_WORKSPACE_DIR, workspacePathIssue } from "@kaiju/protocol";

/**
 * The path rules every write of a project's files shares (KOBE-780): upload, Add to project, a
 * checkout's commit, revert, promote and an accepted proposal.
 */

/** Where a project file appears in members' workspaces: `projects/<slug>/<path>`. */
export const mountPathOf = (slug: string, path: string): string =>
  `${PROJECT_WORKSPACE_DIR}/${slug}/${path}`;

/**
 * A valid path inside the project that still is a valid workspace path once mounted (P2-8): the
 * `projects/<slug>/` prefix counts against the 1024-byte limit, else every mount, checkout and
 * update of the project would fail on it.
 */
export const fitsMount = (slug: string, path: string): boolean =>
  workspacePathIssue(path) === undefined &&
  workspacePathIssue(mountPathOf(slug, path)) === undefined;

/** A sync conflict copy (`<stem>.conflict-YYYYMMDDTHHMMSSZ[-n]<ext>`), judged by the file name. */
export const isConflictCopy = (path: string): boolean =>
  CONFLICT_COPY_PATTERN.test(path.slice(path.lastIndexOf("/") + 1));

/**
 * A path that would be a file inside a file (an ancestor is a file), or a file where a folder is
 * (files lie under it). The exact path itself is not a clash.
 */
export function clashesInTree(
  tree: { has(path: string): boolean; keys(): Iterable<string> },
  rel: string,
): boolean {
  const parts = rel.split("/");
  for (let i = 1; i < parts.length; i++) {
    if (tree.has(parts.slice(0, i).join("/"))) return true;
  }
  const folder = `${rel}/`;
  for (const path of tree.keys()) if (path.startsWith(folder)) return true;
  return false;
}
