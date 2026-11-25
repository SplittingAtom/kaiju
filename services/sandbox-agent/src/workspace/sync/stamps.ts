import { chmod, lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { lstatIfExists, parentsAreDirs } from "../fs.js";
import { openAgentTemp, tempPathFor } from "../../atomic-file.js";
import { assertOnVolume } from "../volume.js";

/**
 * KOBE-733: when a file is known to hold its synced content, by its inode stamp. Size and mtime
 * can be set back by tools (`touch -r`, `cp -p`, `rsync -t`, archive extraction); ctime and the
 * inode cannot. Nanoseconds (`bigint` stats), compared with strict equality: any change, even
 * one made after the clock stepped back, makes the file unverified, and it is re-hashed.
 *
 * Git's "racily clean" rule: timestamps move once per kernel tick, so a same-size rewrite in the
 * same tick as the stat would leave the stamp equal. A stamp is therefore recorded only when the
 * file's ctime and mtime are at least {@link RACY_WINDOW_NS} older than the moment hashing
 * started, read on the filesystem's own clock (the mtime of a marker file just written on the
 * volume, {@link volumeNow}). A younger file stays unverified and is re-hashed on a later pass.
 */
export interface FileStamp {
  readonly size: number;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly ino: bigint;
}

export const RACY_WINDOW_NS = 2_000_000_000n;
export const RACY_WINDOW_MS = 2_000;

/** The stamp of a `bigint: true` stat. */
export function stampOf(stat: {
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  ino: bigint;
}): FileStamp {
  return { size: Number(stat.size), mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs, ino: stat.ino };
}

export function sameStamp(a: FileStamp | undefined, b: FileStamp | undefined): boolean {
  return (
    a !== undefined &&
    b !== undefined &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs &&
    a.ino === b.ino
  );
}

/** Whether a stamp is too young to record against hashing that started at `startNs`. */
export function racy(stamp: FileStamp, startNs: bigint | undefined): boolean {
  if (startNs === undefined) return true;
  const edge = startNs - RACY_WINDOW_NS;
  return stamp.ctimeNs >= edge || stamp.mtimeNs >= edge;
}

const KAIJU_DIR = ".kaiju";
/** The agent's own directory: `.kaiju/` is shared with the Pi identities (sessions, 2770). */
const STATE_DIR = `${KAIJU_DIR}/agent`;
const CLOCK_FILE = "workspace-clock";
const STAMPS_FILE = "workspace-verified.json";
/** A marker mtime further than this from the agent's clock is no trustworthy volume clock. */
export const CLOCK_SANITY_MS = 60_000;

const agentUid = (): number | undefined => process.getuid?.();

/** Owned by the agent and private to it (`mode` bits), never a link. */
function agentOwned(stat: { uid: number; mode: number }, mode: number): boolean {
  const uid = agentUid();
  return (uid === undefined || stat.uid === uid) && (stat.mode & 0o777) === mode;
}

/**
 * `.kaiju/agent/` on the volume, created agent-only (0700). Undefined when it is anything else: a
 * link, a file, or a directory not owned by the agent or not 0700. The workspace and `.kaiju/` are
 * writable by the member's identities, who can swap entries in them but cannot make a directory
 * owned by the agent's uid, so a swapped one is never trusted (its stamps count as absent).
 */
async function stateDir(root: string, create: boolean): Promise<string | undefined> {
  const parent = path.join(root, KAIJU_DIR);
  const kaiju = await lstatIfExists(parent);
  if (!kaiju) {
    if (!create) return undefined;
    await mkdir(parent, { mode: 0o700 });
  } else if (!kaiju.isDirectory()) return undefined;
  const dir = path.join(root, STATE_DIR);
  let found = await lstatIfExists(dir);
  if (!found && create) {
    await mkdir(dir, { mode: 0o700 });
    await chmod(dir, 0o700);
    found = await lstatIfExists(dir);
  }
  return found?.isDirectory() && agentOwned(found, 0o700) ? dir : undefined;
}

/** Writes `text` to `.kaiju/<name>` atomically, on the volume only (never through a link). */
async function writeState(root: string, name: string, text: string): Promise<void> {
  const dir = await stateDir(root, true);
  if (dir === undefined) throw new Error(".kaiju/agent is not the agent's own directory");
  const final = path.join(dir, name);
  const temp = tempPathFor(final);
  const handle = await openAgentTemp(temp, 0o600);
  try {
    await assertOnVolume(handle, root, temp);
    await handle.writeFile(text);
    await handle.close();
    await rename(temp, final);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * The volume's clock now (ns): the mtime of a marker file just rewritten on it. Undefined when it
 * cannot be written; then nothing is recorded as verified (every file stays unverified).
 */
export async function volumeNow(root: string): Promise<bigint | undefined> {
  try {
    await writeState(root, CLOCK_FILE, String(Date.now()));
    const mtimeNs = (await lstat(path.join(root, STATE_DIR, CLOCK_FILE), { bigint: true })).mtimeNs;
    // A marker far from the agent's own clock (a volume clock gone wrong): not trustworthy, so
    // nothing is recorded as verified and no proof can follow.
    const skewMs = Math.abs(Number(mtimeNs / 1_000_000n) - Date.now());
    return skewMs > CLOCK_SANITY_MS ? undefined : mtimeNs;
  } catch {
    return undefined;
  }
}

export interface SavedStamp {
  readonly sha256: string;
  readonly stamp: FileStamp;
}

/**
 * Remembers on the volume which files are verified (their content hash and stamp), so a wake on
 * the same volume does not re-hash them: a file whose stamp is still equal has not changed since.
 */
export async function saveStamps(
  root: string,
  entries: Iterable<readonly [string, SavedStamp]>,
): Promise<void> {
  const files = [...entries].map(([p, { sha256, stamp }]) => [
    p,
    sha256,
    stamp.size,
    String(stamp.mtimeNs),
    String(stamp.ctimeNs),
    String(stamp.ino),
  ]);
  await writeState(root, STAMPS_FILE, JSON.stringify({ v: 1, files }));
}

/** What {@link saveStamps} left on this volume (empty when nothing valid is there). */
export async function loadStamps(root: string): Promise<Map<string, SavedStamp>> {
  const out = new Map<string, SavedStamp>();
  try {
    const dir = await stateDir(root, false);
    if (dir === undefined || !(await parentsAreDirs(root, `${STATE_DIR}/${STAMPS_FILE}`))) {
      return out;
    }
    const file = path.join(dir, STAMPS_FILE);
    const stat = await lstat(file);
    if (!stat.isFile() || !agentOwned(stat, 0o600)) return out;
    const parsed = JSON.parse(await readFile(file, "utf8")) as { v?: unknown; files?: unknown };
    if (parsed.v !== 1 || !Array.isArray(parsed.files)) return out;
    for (const row of parsed.files as unknown[]) {
      if (!Array.isArray(row) || row.length !== 6) continue;
      const [p, sha256, size, mtime, ctime, ino] = row as unknown[];
      if (typeof p !== "string" || typeof sha256 !== "string" || typeof size !== "number") continue;
      if (typeof mtime !== "string" || typeof ctime !== "string" || typeof ino !== "string") {
        continue;
      }
      out.set(p, {
        sha256,
        stamp: { size, mtimeNs: BigInt(mtime), ctimeNs: BigInt(ctime), ino: BigInt(ino) },
      });
    }
  } catch {
    out.clear();
  }
  return out;
}
