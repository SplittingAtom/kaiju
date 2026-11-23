import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { deflate as deflateCb } from "node:zlib";
import type { GitTreeEntry } from "../../git-hosts/trees.js";

/**
 * Git objects for one commit to a Repo (KOBE-767, spec workspace-git G18): blobs of the files the
 * member changed, the trees on their paths and the commit, each written as a loose object into the
 * run's own folder, from which `conversion/pack.ts` writes the receive-pack request. SHA-1
 * repositories only (what every supported host creates); the objects are git's exact format, so
 * a host with `receive.fsckObjects` takes them (db test against `git http-backend`).
 */
const deflate = promisify(deflateCb);

export type GitObjectType = "blob" | "tree" | "commit";

/** The object id of `content` as a `type` object (SHA-1 of `<type> <size>\0<content>`). */
export function gitObjectId(type: GitObjectType, content: Buffer): string {
  return createHash("sha1")
    .update(`${type} ${content.length}\0`, "latin1")
    .update(content)
    .digest("hex");
}

/** Writes `content` as a loose object under `gitdir/objects`; returns its id. */
export async function writeLoose(
  gitdir: string,
  type: GitObjectType,
  content: Buffer,
): Promise<string> {
  const oid = gitObjectId(type, content);
  const dir = path.join(gitdir, "objects", oid.slice(0, 2));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const raw = Buffer.concat([Buffer.from(`${type} ${content.length}\0`, "latin1"), content]);
  try {
    // The same object twice (two equal files) is written once.
    await writeFile(path.join(dir, oid.slice(2)), await deflate(raw), { mode: 0o600, flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  return oid;
}

/** Git's order of tree entries: by name bytes, a folder compared as if it ended with `/`. */
function sortKey(e: Pick<GitTreeEntry, "name" | "type">): Buffer {
  return Buffer.from(e.type === "tree" ? `${e.name}/` : e.name, "utf8");
}

/** A tree object's content: `<mode> <name>\0<20-byte id>` per entry, in git's order. */
export function treeContent(entries: readonly GitTreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => Buffer.compare(sortKey(a), sortKey(b)));
  const parts: Buffer[] = [];
  for (const e of sorted) {
    if (!/^[0-9a-f]{40}$/.test(e.sha)) throw new Error("tree entry is not a SHA-1 object id");
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, "utf8"), Buffer.from(e.sha, "hex"));
  }
  return Buffer.concat(parts);
}

export interface GitIdentityLine {
  readonly name: string;
  readonly email: string;
}

/** A commit object's content: tree, parent, author, committer (UTC), a blank line, the message. */
export function commitContent(input: {
  readonly tree: string;
  readonly parent: string;
  readonly author: GitIdentityLine;
  readonly committer: GitIdentityLine;
  readonly at: Date;
  readonly message: string;
}): Buffer {
  const seconds = Math.floor(input.at.getTime() / 1000);
  const who = (p: GitIdentityLine) => `${p.name} <${p.email}> ${seconds} +0000`;
  const message = `${input.message.replace(/\s+$/, "")}\n`;
  return Buffer.from(
    `tree ${input.tree}\nparent ${input.parent}\nauthor ${who(input.author)}\ncommitter ${who(input.committer)}\n\n${message}`,
    "utf8",
  );
}
