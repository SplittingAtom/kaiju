import type { GitTreeEntry } from "../../git-hosts/trees.js";
import { treeContent } from "./objects.js";

/**
 * A commit to a Repo applies the member's changes, path by path, to the host's tree of the commit
 * the working copy started from (KOBE-767, G18): only the folders on a changed path are read from
 * the host and written again; every other entry (folders, links, submodules, files Kobe does not
 * show) keeps its id, so nothing the commit does not touch changes on the host.
 */

/** A file the commit writes (its blob id and executable bit), or removes (`null`). */
export type FileEdit = { readonly blob: string; readonly executable: boolean } | null;

/** The host's tree and Kobe's copy disagree about a path (a folder where Kobe has a file). */
export class TreeMismatch extends Error {
  constructor(readonly path: string) {
    super(`the repository does not match Kobe's copy at ${path}`);
    this.name = "TreeMismatch";
  }
}

/** Most folders one commit may read from the host. */
export const TREE_EDIT_MAX_READS = 500;

export interface TreeEditIo {
  /** One level of a tree (or of a commit's tree) on the host. */
  read(sha: string): Promise<readonly GitTreeEntry[]>;
  /** Writes a tree object; returns its id. */
  write(content: Buffer): Promise<string>;
}

interface Node {
  readonly files: Map<string, FileEdit>;
  readonly dirs: Map<string, Node>;
}

const node = (): Node => ({ files: new Map(), dirs: new Map() });

function plan(edits: ReadonlyMap<string, FileEdit>): Node {
  const root = node();
  for (const [path, edit] of edits) {
    const parts = path.split("/");
    const name = parts.pop() as string;
    let at = root;
    for (const part of parts) {
      let next = at.dirs.get(part);
      if (!next) {
        next = node();
        at.dirs.set(part, next);
      }
      at = next;
    }
    at.files.set(name, edit);
  }
  return root;
}

/**
 * The new root tree id after applying `edits` (path → edit, paths relative to the repository root)
 * to the tree of `base` (a commit id: the hosts read a commit's tree by the commit's id). Returns
 * the root tree's id and how many folders were read.
 */
export async function editTree(
  base: string,
  edits: ReadonlyMap<string, FileEdit>,
  io: TreeEditIo,
): Promise<{ readonly tree: string; readonly reads: number }> {
  let reads = 0;
  const read = async (sha: string) => {
    reads += 1;
    if (reads > TREE_EDIT_MAX_READS) throw new TreeMismatch("(too many folders)");
    return io.read(sha);
  };
  const apply = async (at: Node, sha: string | null, prefix: string): Promise<string | null> => {
    const entries = new Map<string, GitTreeEntry>();
    if (sha !== null) for (const e of await read(sha)) entries.set(e.name, e);
    for (const [name, edit] of at.files) {
      const existing = entries.get(name);
      if (existing?.type === "tree" || existing?.type === "commit") {
        throw new TreeMismatch(`${prefix}${name}`);
      }
      if (edit === null) entries.delete(name);
      else {
        entries.set(name, {
          name,
          mode: edit.executable ? "100755" : "100644",
          type: "blob",
          sha: edit.blob,
        });
      }
    }
    for (const [name, sub] of at.dirs) {
      const existing = entries.get(name);
      if (existing !== undefined && existing.type !== "tree") {
        throw new TreeMismatch(`${prefix}${name}`);
      }
      const written = await apply(sub, existing?.sha ?? null, `${prefix}${name}/`);
      if (written === null) entries.delete(name);
      else entries.set(name, { name, mode: "40000", type: "tree", sha: written });
    }
    // An emptied folder goes (git has no empty folders); the root stays, possibly empty.
    if (entries.size === 0 && prefix !== "") return null;
    return io.write(treeContent([...entries.values()]));
  };
  const tree = (await apply(plan(edits), base, "")) as string;
  return { tree, reads };
}
