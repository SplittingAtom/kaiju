/**
 * Words and checks for Repos in the Files panel and the Convert to repo dialog (KOBE-768, spec
 * workspace-git G16, G17, G19, G20). Host-provided strings (repository and branch names, URLs)
 * are untrusted: callers render them as text, and a link goes only to the connection's own host
 * ({@link hostLink}).
 */
import type { ApiError } from "../api/client";
import { hostOf } from "../admin/git/labels";
import { syncTimeText } from "../workspace/rebuild";
import type { RepoConversion, RepoMirror, RepoView, RepoWorkingCopy } from "./repo-api";

/** The repository name rule the server applies (`gitConversionStartBodySchema`). */
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;
export const REPO_NAME_MAX = 100;

/**
 * The repository's page on the host, or null when the URL the server passed on is not on the
 * connection's own host (scheme, host and port equal to `baseUrl`'s, no credentials in it). An
 * http link is kept only for a connection that is itself plain http.
 */
export function hostLink(repo: Pick<RepoView, "baseUrl" | "webUrl">): string | null {
  let base: URL;
  let page: URL;
  try {
    base = new URL(repo.baseUrl);
    page = new URL(repo.webUrl);
  } catch {
    return null;
  }
  if (page.protocol !== "https:" && page.protocol !== "http:") return null;
  if (page.protocol !== base.protocol) return null;
  if (page.host !== base.host || page.username !== "" || page.password !== "") return null;
  return page.href;
}

/** "github.com · acme/q4-launch": the row's subtitle (G19). */
export function repoSubtitle(repo: Pick<RepoView, "baseUrl" | "fullName">): string {
  return `${hostOf(repo.baseUrl)} · ${repo.fullName}`;
}

/** The branch shown: the member's working copy's, else the host's default branch. */
export function repoBranch(
  repo: Pick<RepoView, "defaultBranch">,
  copy: Pick<RepoWorkingCopy, "branch"> | null,
): string {
  if (copy === null) return repo.defaultBranch;
  return copy.branch ?? "detached";
}

/** Ahead/behind of a mounted working copy against the host (G19): a chip and its words. */
export function aheadBehindText(copy: RepoWorkingCopy): {
  readonly short: string;
  readonly long: string;
} {
  const parts: string[] = [];
  if (copy.ahead > 0) parts.push(`${copy.ahead} ahead`);
  if (copy.behind > 0) parts.push(`${copy.behind} behind`);
  const even = parts.length === 0;
  if (copy.dirty) parts.push("uncommitted changes");
  if (even && !copy.dirty) parts.push("up to date with the host");
  if (!copy.fetched) parts.push("may be out of date (the last fetch failed)");
  const short = even
    ? "✓"
    : [copy.ahead > 0 ? `↑${copy.ahead}` : "", copy.behind > 0 ? `↓${copy.behind}` : ""]
        .filter(Boolean)
        .join(" ");
  return { short, long: parts.join(", ") };
}

/** The read-only banner (G20). */
export function readOnlyText(reason: NonNullable<RepoView["readOnlyReason"]>): string {
  switch (reason) {
    case "archived":
      return "The repository is archived on the host, so this Repo is read-only: Kobe shows its last mirror.";
    case "deleted":
      return "The repository is no longer on the host (deleted, or moved out of the organization), so this Repo is read-only: Kobe shows its last mirror.";
    case "connection_removed":
      return "The Repo's git connection was removed, so this Repo is read-only: Kobe shows its last mirror.";
  }
}

/** One line about the mirror (G17): refreshing, last refreshed, or why the last refresh failed. */
export function mirrorStateText(mirror: RepoMirror, now: number = Date.now()): string {
  if (mirror.refreshing) return "Refreshing from the host…";
  const last =
    mirror.refreshedAt === null
      ? "Not refreshed yet."
      : `Last refreshed ${syncTimeText(mirror.refreshedAt)}.`;
  if (mirror.error === null) return last;
  const next =
    mirror.nextAttemptAt !== null && Date.parse(mirror.nextAttemptAt) > now
      ? ` Kobe tries again ${syncTimeText(mirror.nextAttemptAt)}.`
      : "";
  return `${last} ${mirror.error.message}${mirror.tooLarge ? "" : next}`;
}

/** The dialog's proposed name: the connection's prefix and the project's slug (G16). */
export function proposedRepoName(prefix: string | undefined, slug: string): string {
  return `${prefix ?? ""}${slug}`.slice(0, REPO_NAME_MAX);
}

/** Why a repository name would be refused, in the server's words; null when it is fine. */
export function repoNameProblem(name: string): string | null {
  if (name.trim() === "") return "Enter a repository name.";
  if (name.length > REPO_NAME_MAX) return `At most ${REPO_NAME_MAX} characters.`;
  if (!REPO_NAME.test(name)) return "Use letters, digits, '.', '-' and '_' only.";
  if (name.toLowerCase().endsWith(".git")) return "A repository name cannot end in .git.";
  return null;
}

/** What a running conversion is doing now. */
export function conversionProgressText(c: RepoConversion): string {
  switch (c.step) {
    case "create":
      return c.useExisting
        ? "Checking the chosen repository on the host…"
        : "Creating the repository on the host…";
    case "push":
      return c.commitsTotal === null
        ? "Pushing commits…"
        : `Pushing commits: ${c.commitsPushed} of ${c.commitsTotal}…`;
    case "finish":
    case "done":
      return "Finishing…";
  }
}

/** How a conversion ended (completed, failed with the server's words, abandoned). */
export function conversionEndText(c: RepoConversion): string {
  switch (c.status) {
    case "completed":
      return `The project is now a Repo: ${c.fullName} on ${hostOf(c.baseUrl)} is its record.`;
    case "failed":
      return c.error === null
        ? "The conversion failed."
        : `${c.error.message}${c.error.detail ? ` (${c.error.detail})` : ""}`;
    case "abandoned":
      return "The conversion was abandoned; the project is an ordinary project again.";
    case "running":
      return conversionProgressText(c);
  }
}

interface NamedPath {
  readonly path: string;
  readonly seq: number | null;
}

const isNamedPath = (v: unknown): v is NamedPath =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as NamedPath).path === "string" &&
  ((v as NamedPath).seq === null || typeof (v as NamedPath).seq === "number");

/**
 * A refused start, retry, abandon, refresh, relink or detach in plain words: the server's message
 * (Kobe's own sentence per code, G16 "the dialog says which"), plus the files it names when the
 * message does not already list them.
 */
export function refusalText(error: ApiError): string {
  const raw = error.details?.paths;
  const paths = Array.isArray(raw) ? raw.filter(isNamedPath) : [];
  const missing = paths.filter((p) => !error.message.includes(p.path));
  if (missing.length === 0) return error.message;
  const list = missing
    .map((p) => (p.seq === null ? p.path : `${p.path} (commit #${p.seq})`))
    .join(", ");
  return `${error.message} Files: ${list}.`;
}
