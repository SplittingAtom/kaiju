import * as fs from "node:fs";
import path from "node:path";
import git, { Errors, type HttpClient } from "isomorphic-git";
import { GitHostError } from "../../git-hosts/adapter.js";
import { fitsMount } from "../../projects/paths.js";
import { GIT_MIRROR_MAX_OBJECTS } from "./limits.js";
import { MirrorError } from "./mirror-error.js";
import { downloadPack, unpackPack, writeShallow } from "./pack-unpack.js";
import { GIT_MIRROR_AUTHOR_MAX, GIT_MIRROR_LOG_MAX, GIT_MIRROR_MESSAGE_MAX } from "@kobe/db";

/**
 * The git side of the Repo mirror (KOBE-766, spec workspace-git G17), independent of the
 * database: the head of the host's default branch (one `info/refs`), and when it moved, a shallow
 * fetch of that branch (the newest {@link GIT_MIRROR_LOG_MAX} commits) into a work folder, then
 * the head's files and the commit list read from it. isomorphic-git runs no hooks, checks out
 * nothing and follows no submodule. Symlinks and submodules are not files: they are left out and
 * counted. Everything read here is untrusted host content: paths are checked against Kaiju's
 * project path rules, sizes and counts against the caps, and commit text is cut and kept as
 * plain text.
 */

export { MirrorError, type MirrorErrorCode } from "./mirror-error.js";

export interface MirrorCaps {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  /** All objects of the fetch together, inflated (history included). */
  readonly maxTotalBytes: number;
  /** Bytes on disk: the pack plus the objects written loose. */
  readonly maxDiskBytes: number;
  /** The pack downloaded. */
  readonly maxPackBytes: number;
  /** Milliseconds since the epoch past which reading stops. */
  readonly deadlineAt: number;
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
      return new GitHostError("rate_limited", "The git host is rate limiting Kaiju.");
    if (status >= 500)
      return new GitHostError("host_unreachable", "The git host is not answering.");
  }
  return new MirrorError("fetch_failed");
}

export interface RemoteHead {
  /** The commit the branch points at; null when the branch does not exist. */
  readonly head: string | null;
  /** The upload-pack capabilities the host advertised. */
  readonly capabilities: readonly string[];
}

/** The head of the host's `branch` and the host's capabilities (one `info/refs`). */
export async function remoteHead(
  http: HttpClient,
  url: string,
  branch: string,
): Promise<RemoteHead> {
  try {
    const info = await git.getRemoteInfo2({ http, url, protocolVersion: 1 });
    const refs = (info.refs ?? []) as { ref: string; oid: string }[];
    const capabilities = Array.isArray(info.capabilities)
      ? (info.capabilities as string[])
      : Object.keys(info.capabilities ?? {});
    return {
      head: refs.find((r) => r.ref === `refs/heads/${branch}`)?.oid ?? null,
      capabilities,
    };
  } catch (err) {
    throw asFailure(err);
  }
}

const firstLine = (message: string) => message.split("\n", 1)[0]?.trim() ?? "";
// Review L4: no control characters (Postgres refuses NUL); cut by code point.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const cut = (text: string, max: number) => [...text.replace(CONTROL, " ")].slice(0, max).join("");
/** A commit time within what Postgres and JS dates hold; out of range becomes the epoch. */
const MAX_SECONDS = 253_402_300_799; // 9999-12-31
const commitTime = (seconds: number) =>
  new Date(Number.isFinite(seconds) && seconds >= 0 && seconds <= MAX_SECONDS ? seconds * 1000 : 0);

/**
 * Fetches `branch` (its newest {@link GIT_MIRROR_LOG_MAX} commits) into `dir` and reads the
 * head's files and the commit list. `dir` must be an empty folder the caller removes afterwards.
 */
export async function fetchBranch(
  http: HttpClient,
  url: string,
  remote: RemoteHead & { readonly head: string },
  dir: string,
  caps: MirrorCaps,
): Promise<FetchedBranch> {
  const head = remote.head;
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await git.init({ fs, dir });
    const packFile = path.join(dir, "fetch.pack");
    const { packOffset, shallows } = await downloadPack(
      http,
      url,
      head,
      remote.capabilities,
      GIT_MIRROR_LOG_MAX,
      packFile,
      caps.maxPackBytes,
    );
    // Review H1: every object's size is checked before it is inflated (pack-unpack.ts).
    await unpackPack(packFile, packOffset, dir, {
      maxObjectBytes: caps.maxFileBytes,
      maxTotalBytes: caps.maxTotalBytes,
      maxObjects: GIT_MIRROR_MAX_OBJECTS,
      maxDiskBytes: caps.maxDiskBytes,
      deadlineAt: caps.deadlineAt,
    });
    await fs.promises.rm(packFile, { force: true });
    await writeShallow(dir, shallows);
  } catch (err) {
    throw asFailure(err);
  }
  const files: MirrorFile[] = [];
  let skipped = 0;
  const walk = async (oid: string, prefix: string): Promise<void> => {
    if (Date.now() > caps.deadlineAt) {
      throw new GitHostError("host_unreachable", "The refresh took too long.");
    }
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
  const commit = await git.readCommit({ fs, dir, oid: head }).catch(() => {
    throw new MirrorError("fetch_failed");
  });
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
    authoredAt: commitTime(c.commit.author.timestamp),
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
