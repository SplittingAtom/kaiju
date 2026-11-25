import { readdir, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  KAIJU_STATE_FOLDER,
  PRE_RENAME_STATE_FOLDER,
  STATE_FOLDER_TERMINATION_PREFIX,
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
 * - A failed step leaves `.kobe` intact (`failed`, with the errno code). So does a `.kaiju` that is
 *   neither a folder nor a link (a file, a socket) beside a `.kobe` holding data: the agent could
 *   not use it, so it is `failed` (`ENOTDIR`), never `conflict`.
 *
 * A `failed` start must not go on (review M1): the agent would create `.kaiju` at once (sync state,
 * sessions, a re-cloned working copy) and every later start would see two folders holding data,
 * stranding the old working copies for good. {@link stateFolderAtStart} therefore throws and the
 * agent exits before anything touches the volume; the pod restarts with backoff (the server's
 * start-failure path tells the member) and the move is retried on a clean volume.
 *
 * The outcome goes to the server in `hello.state_folder`, to the agent's log and, when a person must
 * act, into every run's context ({@link stateFolderNotice}). The old folder is never created again
 * by the agent: nothing in it names the folder except this move and the sync exclusions.
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
      } else if (!next.isDirectory()) return { outcome: "failed", code: "ENOTDIR" };
      else return { outcome: "conflict" };
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

/** The agent must not start: the old folder could not be moved and nothing may write `.kaiju`. */
export class StateFolderStartError extends Error {
  constructor(readonly report: StateFolderReport) {
    super(
      `could not move /workspace/${PRE_RENAME_STATE_FOLDER} to /workspace/${KAIJU_STATE_FOLDER}` +
        ` (${report.code ?? "unknown error"}); it is left as it is and the sandbox does not start` +
        " until the move succeeds (KOBE-827)",
    );
    this.name = "StateFolderStartError";
  }
}

/**
 * The move as the agent's start runs it: the report to carry on with, or a throw on `failed`
 * ({@link StateFolderStartError}), so the agent exits before anything creates or fills `.kaiju`.
 */
export async function stateFolderAtStart(
  root: string,
  fs: StateFolderFs = NODE_FS,
): Promise<StateFolderReport | undefined> {
  const report = await moveStateFolder(root, fs);
  if (report?.outcome === "failed") throw new StateFolderStartError(report);
  return report;
}

/**
 * The line every run's context carries while a person must act (review M2: `conflict`,
 * `not_a_folder`): the in-sandbox agent
 * tells the user what happened and what to do. Undefined when there is nothing to tell. Fixed text
 * (no file names from the volume).
 */
export function stateFolderNotice(
  report: { readonly outcome: StateFolderOutcome } | undefined,
): string | undefined {
  const outcome = report?.outcome;
  // `failed` never gets here: the agent does not start (stateFolderAtStart).
  if (outcome !== "conflict" && outcome !== "not_a_folder") return undefined;
  const why =
    outcome === "conflict"
      ? "This sandbox has both /workspace/.kobe/ (Kaiju's folder before the rename) and /workspace/.kaiju/ (its folder now), and both hold data, so Kaiju moved nothing and deleted nothing: you work in /workspace/.kaiju/."
      : "This sandbox has a /workspace/.kobe that is a link or a file, not Kaiju's old folder, so Kaiju left it as it is and deleted nothing; Kaiju's folder is /workspace/.kaiju/.";
  return [
    "## Sandbox folder (a Kaiju notice, not a message from the user)",
    why,
    'Kaiju repeats this notice with every message until an admin resolves it: if you have not told the user about it in this conversation yet, tell them in this answer; after that, bring it up again only when it matters to what they ask. /workspace/.kobe/repos/ may hold commits or changes to their Repos that were never pushed; they are not synced or backed up anywhere else. Never create /workspace/.kobe, and do not merge or delete either folder. If the user wants that work, bring it over with git (git -C /workspace/.kobe/repos/<project> log --branches --not --remotes lists unpushed commits; push them as a branch, or use git format-patch). Then an admin can remove the old folder. The guide page "Working with git" (section An old /workspace/.kobe/ folder) explains it.',
  ].join("\n");
}

/** Where Kubernetes reads a container's termination message (the default `terminationMessagePath`). */
export const TERMINATION_LOG = "/dev/termination-log";

/**
 * Writes the fixed reason of a failed start to the container's termination log (review round 2):
 * the prefix and the errno code, nothing else (no path, no volume content). Never throws: without
 * the file (outside Kubernetes) the exit code alone tells.
 */
export async function writeStartFailure(
  report: StateFolderReport,
  file: string = TERMINATION_LOG,
): Promise<void> {
  const code = report.code !== undefined && ERRNO_CODE.test(report.code) ? report.code : "UNKNOWN";
  await writeFile(file, `${STATE_FOLDER_TERMINATION_PREFIX}: ${code}\n`).catch(() => undefined);
}
