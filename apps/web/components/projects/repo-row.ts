/**
 * A Repo's row in the Files panel (KOBE-768, spec workspace-git G19) and who may convert a project
 * (G16, GQ13): pure, so the tree and the tests share it.
 */
import type { Project } from "../../lib/projects/api";
import { aheadBehindText, readOnlyText, repoBranch, repoSubtitle } from "../../lib/projects/repo";
import type { GitConnections, RepoInfo } from "./workspace-repos";

export interface RepoRowWords {
  /** "github.com · acme/q4-launch"; "Repo" until the repository is read. */
  readonly subtitle: string;
  /** Short chips after the name (decorative; `words` says the same to screen readers). */
  readonly chips: readonly string[];
  readonly words: readonly string[];
}

/** The chips and screen-reader words of a Repo's row. */
export function repoRowWords(info: RepoInfo | undefined): RepoRowWords {
  const view = info?.view ?? null;
  if (view === null) return { subtitle: "Repo", chips: [], words: [] };
  const copy = info?.status?.workingCopy ?? null;
  const branch = repoBranch(view, copy);
  const chips: string[] = [branch];
  const words: string[] = [`branch ${branch}`];
  if (copy !== null) {
    const ab = aheadBehindText(copy);
    chips.push(ab.short);
    words.push(ab.long);
  }
  if (view.readOnly && view.readOnlyReason !== null) {
    chips.push("read-only");
    words.push(readOnlyText(view.readOnlyReason));
  } else if (view.mirror.tooLarge) {
    chips.push("too large to mirror");
    words.push("too large to mirror: Kaiju shows the last mirror");
  } else if (view.mirror.error !== null) {
    chips.push("refresh failed");
    words.push("the last refresh failed");
  }
  return { subtitle: repoSubtitle(view), chips, words };
}

/**
 * The member manages the project: its owner, or a Workspace admin (`my_role` null when not listed;
 * a listed admin is known from the connections answer, review L1).
 */
export const managesProject = (p: Project, admin = false): boolean =>
  admin || p.myRole === "owner" || p.myRole === null;

/**
 * Convert to repo… on a project (G16, GQ13): its owner or a Workspace admin, a live ordinary
 * project, the Site allowing git, a connection at Read and write; or a conversion that runs or
 * failed (to follow it, retry or abandon).
 */
export function mayConvert(project: Project, git: GitConnections | null): boolean {
  if (
    !managesProject(project, git?.admin) ||
    project.archivedAt !== null ||
    project.kind === "repo"
  ) {
    return false;
  }
  if (project.repoConversion === "running" || project.repoConversion === "failed") return true;
  return git !== null && git.enabled && git.connections.some((c) => c.accessLevel === "read_write");
}
