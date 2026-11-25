import { readdir, rename, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import {
  KAIJU_STATE_FOLDER,
  PRE_RENAME_STATE_FOLDER,
  type StateFolderOutcome,
} from "@kaiju/protocol";
import { lstatIfExists } from "./fs.js";

/**
 * The move of the pre-rename folder `/workspace/.kobe` to `/workspace/.kaiju` (KOBE-827, spec
 * rename-kaiju §11 A4). The folder holds Pi sessions (rebuildable from Postgres, D15), the agent's
 * sync state and the Repo working copies under `repos/`, which hold unpushed work and are never
 * synced: losing or half-moving one loses a member's work. So:
 *
 * - It runs once per agent start, before the workspace sync, Pi, kernels or any tool (index.ts):
 *   nothing else touches the volume yet.
 * - One `rename(2)` of the whole directory inside `/workspace` (one filesystem): atomic. There is
 *   no copy, so there is no half-moved state; a crash leaves either name, never both halves.
 * - Idempotent: no `.kobe` (a fresh volume, or the move already done) means nothing to do.
 * - Never follows a link: both names are checked with `lstat`. A `.kobe` that is not a real
 *   directory is left alone (`not_a_folder`). A link at `.kaiju` holds no data and is removed
 *   (`rename` would replace it anyway; removing it first keeps the rule explicit), as is an empty
 *   `.kaiju` directory (`rmdir` refuses one that is not empty).
 * - Never merges: when both hold data, both stay exactly as they are (`conflict`), the agent runs on
 *   `.kaiju` and the outcome is reported at every start until a person resolves it. `.kaiju` holds
 *   data only after an earlier move (then something recreated `.kobe`: a rollback to an older image
 *   or a tool) or when someone made it before the upgrade; either way nothing is lost: sessions
 *   are rebuilt from the server, and the old working copies stay in `.kobe/repos`.
 * - An empty `.kobe` beside an existing `.kaiju` is removed (`removed_empty`).
 * - A failed step leaves `.kobe` intact (`failed`, with the errno code); the next start tries again.
 *
 * The outcome goes to the server in `hello.state_folder` and to the agent's log. The old folder is
 * never created again: nothing in the agent names it except this move and the sync exclusions.
 */
export interface StateFolderReport {
  readonly outcome: StateFolderOutcome;
  /** The errno code of a failed step (`failed` only). */
  readonly code?: string;
}

/** The file operations the move uses (tests replace one to simulate a failure). */
export interface StateFolderFs {
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly rmdir: (dir: string) => Promise<void>;
  readonly unlink: (file: string) => Promise<void>;
}

const NODE_FS: StateFolderFs = { rename, rmdir, unlink };

const ERRNO_CODE = /^[A-Z][A-Z0-9_]{0,31}$/;

async function isEmptyDir(dir: string): Promise<boolean> {
  return (await readdir(dir)).length === 0;
}

/**
 * Moves `<root>/.kobe` to `<root>/.kaiju` when there is one to move. Undefined: there was no old
 * folder (nothing to report). Never throws: a failure is the `failed` outcome.
 */
export async function moveStateFolder(
  root: string,
  fs: StateFolderFs = NODE_FS,
): Promise<StateFolderReport | undefined> {
  const from = path.join(root, PRE_RENAME_STATE_FOLDER);
  const to = path.join(root, KAIJU_STATE_FOLDER);
  try {
    // The root (the volume's mount point, from the agent's config) is trusted; only what is under
    // it can be a tool's doing.
    const old = await lstatIfExists(from);
    if (old === undefined) return undefined;
    if (!old.isDirectory()) return { outcome: "not_a_folder" };
    const next = await lstatIfExists(to);
    if (next !== undefined) {
      if (next.isSymbolicLink()) await fs.unlink(to);
      else if (next.isDirectory() && (await isEmptyDir(to))) await fs.rmdir(to);
      else if (await isEmptyDir(from)) {
        await fs.rmdir(from);
        return { outcome: "removed_empty" };
      } else return { outcome: "conflict" };
    }
    await fs.rename(from, to);
    return { outcome: "moved" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      outcome: "failed",
      ...(typeof code === "string" && ERRNO_CODE.test(code) ? { code } : {}),
    };
  }
}
