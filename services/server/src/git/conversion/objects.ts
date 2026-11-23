import { createHash } from "node:crypto";
import * as fs from "node:fs";
import git, { type TreeEntry } from "isomorphic-git";
import type { GitConversionFailure } from "@kobe/protocol";
import type { ConversionPlan, PlanIdentity } from "./plan.js";

/**
 * Builds a conversion's git objects (KOBE-765, G16) in a bare repository on local disk (the
 * server's temp directory), deterministically: the same plan and the same file contents give the
 * same blob, tree and commit ids on every attempt, so a retry recognises what an interrupted push
 * already left on the host. Blobs are the files' bytes (verified against Kobe's SHA-256 before
 * they are written); trees use git's order and modes (100644, or 100755 for an executable file);
 * commits carry the plan's author, committer, time (UTC) and message, each on the previous one.
 * One file is in memory at a time (at most a project file's size).
 */
export interface SourceFile {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly executable: boolean;
  readonly blobRef: string;
}

export interface HistorySource {
  /** The tree of a Kobe commit (null: an empty tree). */
  loadTree(commitId: string | null): Promise<readonly SourceFile[]>;
  /** The bytes of one file (throws a {@link ConversionStepError} when missing). */
  readFile(file: SourceFile): Promise<Uint8Array>;
}

export interface BuiltHistory {
  /** The git commit of each plan entry, oldest first. */
  readonly commits: readonly string[];
  /** The bytes of file content each commit adds that no earlier commit had. */
  readonly newBytes: readonly number[];
}

/** A step's failure with its code and, where one is to blame, the file or commit. */
export class ConversionStepError extends Error {
  constructor(
    readonly code: GitConversionFailure,
    readonly detail: string | null = null,
  ) {
    super(code);
    this.name = "ConversionStepError";
  }
}

const BLOB = "100644";
const EXECUTABLE = "100755";
const TREE = "040000";

/** Git's tree order: byte order of names, a directory compared as `name/`. */
function gitOrder(a: TreeEntry, b: TreeEntry): number {
  const ka = Buffer.from(a.type === "tree" ? `${a.path}/` : a.path);
  const kb = Buffer.from(b.type === "tree" ? `${b.path}/` : b.path);
  return Buffer.compare(ka, kb);
}

interface Dir {
  readonly dirs: Map<string, Dir>;
  readonly files: Map<string, { oid: string; executable: boolean }>;
}

const emptyDir = (): Dir => ({ dirs: new Map(), files: new Map() });

function place(root: Dir, path: string, oid: string, executable: boolean): void {
  const parts = path.split("/");
  const name = parts.pop() as string;
  let node = root;
  for (const part of parts) {
    if (node.files.has(part)) throw new ConversionStepError("internal_error", path);
    let next = node.dirs.get(part);
    if (!next) {
      next = emptyDir();
      node.dirs.set(part, next);
    }
    node = next;
  }
  if (node.dirs.has(name) || node.files.has(name)) {
    throw new ConversionStepError("internal_error", path);
  }
  node.files.set(name, { oid, executable });
}

async function writeDir(gitdir: string, node: Dir): Promise<string> {
  const entries: TreeEntry[] = [];
  for (const [name, child] of node.dirs) {
    entries.push({ mode: TREE, path: name, type: "tree", oid: await writeDir(gitdir, child) });
  }
  for (const [name, f] of node.files) {
    entries.push({ mode: f.executable ? EXECUTABLE : BLOB, path: name, type: "blob", oid: f.oid });
  }
  return git.writeTree({ fs, gitdir, tree: entries.sort(gitOrder) });
}

const signature = (who: PlanIdentity, time: number) => ({
  name: who.name,
  email: who.email,
  timestamp: time,
  timezoneOffset: 0,
});

/** Creates the bare repository in `gitdir` (an empty directory the caller owns). */
export async function initRepository(gitdir: string, branch: string): Promise<void> {
  await git.init({ fs, gitdir, bare: true, defaultBranch: branch });
}

/** Writes every object of the plan and returns the commits, oldest first. */
export async function buildHistory(
  gitdir: string,
  plan: ConversionPlan,
  source: HistorySource,
  onCommit?: (index: number) => Promise<void> | void,
): Promise<BuiltHistory> {
  const blobs = new Map<string, string>();
  const commits: string[] = [];
  const newBytes: number[] = [];
  let parent: string | null = null;
  for (const [index, entry] of plan.commits.entries()) {
    const root = emptyDir();
    let added = 0;
    for (const file of await source.loadTree(entry.kobeCommitId)) {
      let oid = blobs.get(file.sha256);
      if (oid === undefined) {
        const bytes = await source.readFile(file);
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (digest !== file.sha256 || bytes.length !== file.size) {
          throw new ConversionStepError("content_missing", file.path);
        }
        oid = await git.writeBlob({ fs, gitdir, blob: bytes });
        blobs.set(file.sha256, oid);
        added += file.size;
      }
      place(root, file.path, oid, file.executable);
    }
    const tree = await writeDir(gitdir, root);
    const commit: string = await git.writeCommit({
      fs,
      gitdir,
      commit: {
        message: entry.message,
        tree,
        parent: parent === null ? [] : [parent],
        author: signature(entry.author, entry.time),
        committer: signature(entry.committer, entry.time),
      },
    });
    commits.push(commit);
    newBytes.push(added);
    parent = commit;
    await onCommit?.(index);
  }
  return { commits, newBytes };
}
