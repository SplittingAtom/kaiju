import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * KOBE-733: right before the reclaim proof, whether the sandbox is quiet: no process alive in the
 * pod's PID namespace except the agent itself, its ancestors (the container's init) and its own
 * direct children that run as the agent's uid (a helper it is running; a Pi, its tools or a kernel
 * run under identity uids, so a surviving one is always in the way). Anything else could still
 * write to the volume after the completeness check. Zombies (state Z) cannot write and are ignored. Unreadable `/proc` = not
 * quiet. Returns the pids that are in the way (empty: quiet).
 */
export async function processesInTheWay(
  procRoot = "/proc",
  self: number = process.pid,
): Promise<number[] | undefined> {
  let entries: string[];
  try {
    entries = await readdir(procRoot);
  } catch {
    return undefined;
  }
  const status = new Map<number, { ppid: number; uid: number; zombie: boolean }>();
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const text = await readFile(path.join(procRoot, name, "status"), "utf8");
      const ppid = Number(/^PPid:\s+(\d+)/m.exec(text)?.[1] ?? "-1");
      const uid = Number(/^Uid:\s+(\d+)/m.exec(text)?.[1] ?? "-1");
      const zombie = /^State:\s+Z/m.test(text);
      status.set(Number(name), { ppid, uid, zombie });
    } catch {
      // Gone since the listing: it cannot write any more.
    }
  }
  const selfUid = status.get(self)?.uid;
  if (selfUid === undefined) return undefined;
  const allowed = new Set<number>([self]);
  for (let pid = status.get(self)?.ppid; pid !== undefined && pid > 0 && !allowed.has(pid);) {
    allowed.add(pid);
    pid = status.get(pid)?.ppid;
  }
  return [...status.entries()]
    .filter(([pid, s]) => !allowed.has(pid) && !s.zombie && !(s.ppid === self && s.uid === selfUid))
    .map(([pid]) => pid);
}

/** True only when {@link processesInTheWay} found nothing in the way. */
export async function sandboxQuiet(procRoot?: string, self?: number): Promise<boolean> {
  const inTheWay = await processesInTheWay(procRoot, self);
  return inTheWay !== undefined && inTheWay.length === 0;
}
