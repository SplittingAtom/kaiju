import * as fs from "node:fs";
import path from "node:path";
import git, { Errors, type HttpClient } from "isomorphic-git";
import { GitHostError } from "../../git-hosts/adapter.js";
import { fitsMount } from "../../projects/paths.js";
import { largestPackedObject } from "./pack-sizes.js";
import { GIT_MIRROR_AUTHOR_MAX, GIT_MIRROR_LOG_MAX, GIT_MIRROR_MESSAGE_MAX } from "@kobe/db";

/**
 * The git side of the Repo mirror (KOBE-766, spec workspace-git G17), independent of the
 * database: the head of the host's default branch (one `info/refs`), and when it moved, a shallow
 * fetch of that branch (the newest {@link GIT_MIRROR_LOG_MAX} commits) into a work folder, then
 * the head's files and the commit list read from it. isomorphic-git runs no hooks, checks out
 * nothing and follows no submodule. Symlinks and submodules are not files: they are left out and
 * counted. Everything read here is untrusted host content: paths are checked against Kobe's
 * project path rules, sizes and counts against the caps, and commit text is cut and kept as
 * plain text.
 */

export type MirrorErrorCode =
  /** The default branch is not on the host (renamed, or the repository is empty). */
  | "branch_missing"
  | "too_many_files"
  | "file_too_large"
  | "repository_too_large"
  /** A path Kobe's projects cannot hold (too long once mounted, or not a valid workspace path). */
  | "unsupported_path"
  | "fetch_failed"
  /** The server has no room for the fetch now. */
  | "server_capacity";

/** A refresh that cannot complete; `detail` names the path or size when one is to blame. */
export class MirrorError extends Error {
  constructor(
    readonly code: MirrorErrorCode,
    readonly detail?: string,
  ) {
    super(`git mirror: ${code}`);
    this.name = "MirrorError";
  }
}

export interface MirrorCaps {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  /** The project's slug: paths must still be valid once mounted under `projects/<slug>/`. */
  readonly slug: string;
}

/** A file of the mirrored head, before its content is read. */
export interface MirrorFile {
  readonly path: string;
  readonly oid: string;
  readonly executable: boolean;
}

/** One entry of the commit list (plain text, cut to the table's limits; no email address). */
export interface MirrorCommit {
  readonly sha: string;
  readonly authorName: string;
  readonly authoredAt: Date;
  readonly message: string;
}

export interface FetchedBranch {
  readonly head: string;
  readonly files: readonly MirrorFile[];
  /** Symlinks and submodules left out. */
  readonly skipped: number;
  readonly commits: readonly MirrorCommit[];
  readBlob(oid: string): Promise<Uint8Array>;
}

const isTimeout = (err: unknown) => err instanceof Error && /took too long/.test(err.message);

/** A failure of isomorphic-git as a host error or a mirror error (never its message text). */
function asFailure(err: unknown): Error {
  if (err instanceof GitHostError || err instanceof MirrorError) return err;
  if (isTimeout(err)) return new GitHostError("host_unreachable", "The git host took too long.");
  if (err instanceof Errors.HttpError) {
    const status = Number(err.data.statusCode);
    if (status === 401)
      return new GitHostError("auth_failed", "The git host refused the credential.");
    if (status === 403) return new GitHostError("forbidden", "The git host refused the request.");
    if (status === 404) return new GitHostError("not_found", "The repository is not on the host.");
    if (status === 429)
      return new GitHostError("rate_limited", "The git host is rate limiting Kobe.");
    if (status >= 500)
      return new GitHostError("host_unreachable", "The git host is not answering.");
  }
  return new MirrorError("fetch_failed");
}

/** The commit the host's `branch` points at; null when the branch does not exist. */
export async function remoteHead(
  http: HttpClient,
  url: string,
  branch: string,
): Promise<string | null> {
  try {
    const info = await git.getRemoteInfo2({ http, url, protocolVersion: 1 });
    const refs = (info.refs ?? []) as { ref: string; oid: string }[];
    return refs.find((r) => r.ref === `refs/heads/${branch}`)?.oid ?? null;
  } catch (err) {
    throw asFailure(err);
  }
}

const firstLine = (message: string) => message.split("\n", 1)[0]?.trim() ?? "";
const cut = (text: string, max: number) => [...text].slice(0, max).join("");

/**
 * Fetches `branch` (its newest {@link GIT_MIRROR_LOG_MAX} commits) into `dir` and reads the
 * head's files and the commit list. `dir` must be an empty folder the caller removes afterwards.
 */
export async function fetchBranch(
  http: HttpClient,
  url: string,
  branch: string,
  dir: string,
  caps: MirrorCaps,
): Promise<FetchedBranch> {
  let head: string;
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await git.init({ fs, dir, defaultBranch: branch });
    await git.addRemote({ fs, dir, remote: "origin", url });
    const fetched = await git.fetch({
      fs,
      http,
      dir,
      remote: "origin",
      ref: branch,
      singleBranch: true,
      depth: GIT_MIRROR_LOG_MAX,
      tags: false,
    });
    if (fetched.fetchHead === null) throw new MirrorError("branch_missing");
    head = fetched.fetchHead;
  } catch (err) {
    if (err instanceof Errors.NotFoundError) throw new MirrorError("branch_missing");
    throw asFailure(err);
  }
  // Before anything is inflated: no object of the fetch may be larger than a file may be.
  const largest = await largestPackedObject(path.join(dir, ".git"));
  if (largest > caps.maxFileBytes) throw new MirrorError("file_too_large", String(largest));
  const files: MirrorFile[] = [];
  let skipped = 0;
  const walk = async (oid: string, prefix: string): Promise<void> => {
    for (const e of (await git.readTree({ fs, dir, oid })).tree) {
      const path = `${prefix}${e.path}`;
      if (e.type === "tree") {
        await walk(e.oid, `${path}/`);
        continue;
      }
      if (e.type !== "blob" || (e.mode !== "100644" && e.mode !== "100755")) {
        skipped += 1;
        continue;
      }
      if (!fitsMount(caps.slug, path)) throw new MirrorError("unsupported_path", path);
      if (files.length + 1 > caps.maxFiles) {
        throw new MirrorError("too_many_files", String(caps.maxFiles));
      }
      files.push({ path, oid: e.oid, executable: e.mode === "100755" });
    }
  };
  const commit = await git.readCommit({ fs, dir, oid: head });
  try {
    await walk(commit.commit.tree, "");
  } catch (err) {
    // isomorphic-git refuses names it considers unsafe (`..`, a backslash, `.git`) itself.
    if (err instanceof Errors.UnsafeFilepathError) throw new MirrorError("unsupported_path");
    throw err;
  }
  const log = await git
    .log({ fs, dir, ref: head, depth: GIT_MIRROR_LOG_MAX })
    .catch(() => [commit]);
  const commits = log.slice(0, GIT_MIRROR_LOG_MAX).map((c): MirrorCommit => ({
    sha: c.oid,
    authorName: cut(c.commit.author.name, GIT_MIRROR_AUTHOR_MAX),
    authoredAt: new Date(c.commit.author.timestamp * 1000),
    message: cut(firstLine(c.commit.message), GIT_MIRROR_MESSAGE_MAX),
  }));
  return {
    head,
    files,
    skipped,
    commits,
    readBlob: async (oid) => {
      const { blob } = await git.readBlob({ fs, dir, oid });
      if (blob.length > caps.maxFileBytes) {
        throw new MirrorError("file_too_large", String(caps.maxFileBytes));
      }
      return blob;
    },
  };
}
