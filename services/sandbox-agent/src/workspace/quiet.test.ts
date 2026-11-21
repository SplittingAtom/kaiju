import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { processesInTheWay, sandboxQuiet } from "./quiet.js";

/** KOBE-733: the /proc check right before the reclaim proof, over a fake /proc. */
const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

async function proc(
  entries: readonly { pid: number; ppid: number; uid: number; state?: string }[],
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "kobe-proc-"));
  roots.push(root);
  for (const e of entries) {
    await mkdir(path.join(root, String(e.pid)));
    await writeFile(
      path.join(root, String(e.pid), "status"),
      `Name:\tx\nState:\t${e.state ?? "S (sleeping)"}\nPPid:\t${e.ppid}\nUid:\t${e.uid}\t${e.uid}\t${e.uid}\t${e.uid}\n`,
    );
  }
  await mkdir(path.join(root, "self"));
  return root;
}

describe("sandbox quiet check (KOBE-733)", () => {
  const init = { pid: 1, ppid: 0, uid: 1000 };
  const agent = { pid: 7, ppid: 1, uid: 1000 };

  it("is quiet with only the init, the agent and a helper child of the agent's uid", async () => {
    const root = await proc([init, agent, { pid: 9, ppid: 7, uid: 1000 }]);
    expect(await processesInTheWay(root, 7)).toEqual([]);
    expect(await sandboxQuiet(root, 7)).toBe(true);
  });

  it("is not quiet with a surviving Pi, tool or kernel (an identity uid), even a child", async () => {
    expect(await sandboxQuiet(await proc([init, agent, { pid: 12, ppid: 7, uid: 2001 }]), 7)).toBe(
      false,
    );
    // A re-parented background job (nohup, setsid) of the agent's uid.
    expect(
      await processesInTheWay(await proc([init, agent, { pid: 30, ppid: 1, uid: 1000 }]), 7),
    ).toEqual([30]);
  });

  it("ignores zombies, and is never quiet when /proc cannot be read", async () => {
    const root = await proc([init, agent, { pid: 40, ppid: 1, uid: 2002, state: "Z (zombie)" }]);
    expect(await sandboxQuiet(root, 7)).toBe(true);
    expect(await sandboxQuiet(path.join(root, "missing"), 7)).toBe(false);
  });
});
