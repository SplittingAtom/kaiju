import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PiIdentities } from "./pi/identities.js";
import { startHarness, type Harness } from "./testing/harness.js";
import type { ReclaimProof } from "./workspace/sync.js";

/**
 * KOBE-733: the agent's wiring of the reclaim proof at shutdown: offered only under Pi identities,
 * and its quiet check fails after a failed cleanup or with another process alive.
 */
let h: Harness | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await h?.close();
  h = undefined;
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A fake /proc: the agent (this process, so its parent chain), plus `others`. */
async function fakeProc(others: readonly { pid: number; uid: number }[]): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "kobe-proc-"));
  dirs.push(root);
  const uid = process.getuid?.() ?? 1000;
  const rows = [{ pid: process.pid, ppid: 0, uid }, ...others.map((o) => ({ ...o, ppid: 1 }))];
  for (const r of rows) {
    await mkdir(path.join(root, String(r.pid)));
    await writeFile(
      path.join(root, String(r.pid), "status"),
      `State:\tS (sleeping)\nPPid:\t${r.ppid}\nUid:\t${r.uid}\t${r.uid}\t${r.uid}\t${r.uid}\n`,
    );
  }
  return root;
}

async function proofAtShutdown(
  identities: { cleanupFailed: boolean } | undefined,
  procRoot: string,
): Promise<{ offered: boolean; quiet?: boolean }> {
  let seen: ReclaimProof | undefined;
  let offered = false;
  let wireClosedFirst = false;
  h = await startHarness({
    ...(identities ? { identities: identities as unknown as PiIdentities } : {}),
    procRoot,
    workspace: () => ({
      beforeRun: () => Promise.resolve(),
      runEnded: () => undefined,
      flush: () => Promise.resolve(),
      prove: (proof) => {
        offered = true;
        seen = proof;
        // KOBE-733: the wire is closed before the proof: a dying pod never keeps it open for it.
        wireClosedFirst = (h?.server.closes ?? 0) > 0;
        return Promise.resolve();
      },
    }),
  });
  await h.server.waitFor((f) => f.type === "hello");
  await h.agent.stop(200);
  if (offered) expect(wireClosedFirst).toBe(true);
  return seen ? { offered, quiet: await seen.quiet() } : { offered };
}

describe("reclaim proof wiring (KOBE-733)", () => {
  it("offers no proof without Pi identities", async () => {
    expect(await proofAtShutdown(undefined, await fakeProc([]))).toEqual({ offered: false });
  });

  it("is quiet only with no failed cleanup and nothing else alive", async () => {
    expect(await proofAtShutdown({ cleanupFailed: false }, await fakeProc([]))).toEqual({
      offered: true,
      quiet: true,
    });
  });

  it("is never quiet after a failed kill or reclaim", async () => {
    expect(await proofAtShutdown({ cleanupFailed: true }, await fakeProc([]))).toEqual({
      offered: true,
      quiet: false,
    });
  });

  it("is never quiet with another process alive", async () => {
    expect(
      await proofAtShutdown({ cleanupFailed: false }, await fakeProc([{ pid: 4242, uid: 2001 }])),
    ).toEqual({ offered: true, quiet: false });
  });
});
