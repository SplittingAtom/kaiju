import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SyncClient } from "./client.js";
import { MoveReplay, applyLocalMove } from "./moves.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function dir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), "kaiju-mv-"));
  dirs.push(d);
  return d;
}
async function put(root: string, rel: string, text = "x"): Promise<void> {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await writeFile(path.join(root, rel), text);
}

describe("server moves as local renames (KOBE-304)", () => {
  it("renames a file or a whole folder, creating the destination's folders", async () => {
    const root = await dir();
    await put(root, "a/b.txt", "b");
    await put(root, "tree/node_modules/x.js", "x");
    expect(await applyLocalMove(root, { from: "a/b.txt", to: "c/d/b.txt", type: "file" })).toBe(
      "renamed",
    );
    expect(await readFile(path.join(root, "c/d/b.txt"), "utf8")).toBe("b");
    expect(await readdir(root)).not.toContain("a"); // emptied, pruned
    expect(await applyLocalMove(root, { from: "tree", to: "moved/tree", type: "dir" })).toBe(
      "renamed",
    );
    expect(await readFile(path.join(root, "moved/tree/node_modules/x.js"), "utf8")).toBe("x");
  });

  it("is a no-op when the source is gone (a replay), and refuses an existing destination", async () => {
    const root = await dir();
    await put(root, "b.txt");
    expect(await applyLocalMove(root, { from: "a.txt", to: "b.txt", type: "file" })).toBe("absent");
    await put(root, "a.txt");
    expect(await applyLocalMove(root, { from: "a.txt", to: "b.txt", type: "file" })).toBe("exists");
    expect(await readdir(root)).toEqual(["a.txt", "b.txt"]);
  });

  it("never follows or moves links, and never leaves the volume", async () => {
    const root = await dir();
    const outside = await dir();
    await put(outside, "secret.txt", "s");
    // The source itself is a link.
    await symlink(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
    expect(await applyLocalMove(root, { from: "link.txt", to: "x.txt", type: "file" })).toBe(
      "refused",
    );
    // A parent of the source is a link: as if absent here (nothing is touched).
    await symlink(outside, path.join(root, "out"));
    expect(await applyLocalMove(root, { from: "out/secret.txt", to: "y.txt", type: "file" })).toBe(
      "absent",
    );
    // A parent of the destination is a link.
    await put(root, "mine.txt", "m");
    expect(await applyLocalMove(root, { from: "mine.txt", to: "out/mine.txt", type: "file" })).toBe(
      "refused",
    );
    expect(await readdir(outside)).toEqual(["secret.txt"]);
    expect(await readFile(path.join(root, "mine.txt"), "utf8")).toBe("m");
  });

  it("refuses paths that are not the agent's own, traversal, into itself, or a kind mismatch", async () => {
    const root = await dir();
    await put(root, "a/x");
    await put(root, "f.txt");
    for (const move of [
      { from: "a", to: "uploads/a", type: "dir" },
      { from: "uploads/x", to: "a2", type: "file" },
      { from: "a", to: ".kaiju/a", type: "dir" },
      { from: "a", to: "../a", type: "dir" },
      { from: "../etc", to: "e", type: "dir" },
      { from: "a", to: "a/b", type: "dir" },
      { from: "a", to: "b", type: "file" },
      { from: "f.txt", to: "g", type: "dir" },
    ] as const) {
      expect(await applyLocalMove(root, move), JSON.stringify(move)).toBe("refused");
    }
  });

  // CODE-25 review: a destination the agent cannot stat skips that one move, not the replay.
  it.skipIf(process.getuid?.() === 0)(
    "skips a move it cannot check and replays the rest",
    async () => {
      const root = await dir();
      await mkdir(path.join(root, "private/sub"), { recursive: true });
      await put(root, "a.txt", "a");
      const moves = [
        { rev: 1, from: "gone.txt", to: "private/sub/gone.txt", type: "file" as const },
        { rev: 2, from: "a.txt", to: "b.txt", type: "file" as const },
      ];
      const client = { moves: () => Promise.resolve({ moves, more: false }) };
      const warnings: string[] = [];
      const logger = {
        debug: () => {},
        info: () => {},
        warn: (_o: unknown, m: string) => warnings.push(m),
        error: () => {},
      };
      const replay = new MoveReplay(root, client as unknown as SyncClient, logger);
      await chmod(path.join(root, "private"), 0o000);
      try {
        expect(await replay.replay(0)).toEqual([{ from: "a.txt", to: "b.txt", now: true }]);
      } finally {
        await chmod(path.join(root, "private"), 0o755);
      }
      expect(await readFile(path.join(root, "b.txt"), "utf8")).toBe("a");
      expect(warnings.length).toBe(1);
    },
  );
});
