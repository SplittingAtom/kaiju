import type * as FsPromises from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EgressTokenFile } from "../egress/egress-wiring.js";
import { MemoryContextFile } from "../memory/context-file.js";
import { ModelFile } from "../models/model-file.js";

/**
 * KOBE-607: the tripwire (`verify`) of a file the agent rewrites during a run must not race the
 * rewrite. In CI a `get_entries` checked the model file while the trace recorder rewrote it for
 * the run's next turn: the read saw the old text, the write finished before the comparison, and
 * the old text no longer matched the new expected one. Pi was stopped for "runtime_tampered" and
 * the run never ended. Here the read of the file is held open (it has read the file) while the
 * agent's write is started, so the interleaving is the same every time.
 */
const gate = vi.hoisted(() => ({
  held: undefined as { readonly started: () => void; readonly release: Promise<void> } | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof FsPromises>();
  const readFile = (async (...args: Parameters<typeof real.readFile>) => {
    const text = await real.readFile(...args);
    const held = gate.held;
    if (held !== undefined) {
      gate.held = undefined; // one read only
      held.started();
      await held.release;
    }
    return text;
  }) as typeof real.readFile;
  return { ...real, readFile, default: { ...real, readFile } };
});

/** Hold the next readFile after it read the file: `started` resolves then, `release()` lets it go. */
function holdNextRead(): { readonly started: Promise<void>; readonly release: () => void } {
  let release: () => void = () => undefined;
  let started: () => void = () => undefined;
  const startedP = new Promise<void>((resolve) => {
    started = resolve;
  });
  const releaseP = new Promise<void>((resolve) => {
    release = resolve;
  });
  gate.held = { started, release: releaseP };
  return { started: startedP, release };
}

/** Lets a write that is not blocked run to its end (it never waits on the held read). */
const settle = (write: Promise<void>) =>
  Promise.race([write, new Promise<void>((resolve) => setTimeout(resolve, 200))]);

let dir: string | undefined;
afterEach(async () => {
  gate.held = undefined;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function tempDir(): Promise<string> {
  dir = await mkdtemp(path.join(tmpdir(), "kaiju-tripwire-race-"));
  return dir;
}

describe("tripwire vs the agent's own rewrite (KOBE-607)", () => {
  it("the model file: a verify racing a traceparent update is not tampering", async () => {
    const file = new ModelFile(path.join(await tempDir(), "model.json"), {
      gatewayUrl: "http://gw",
      model: null,
      token: "t".repeat(40),
      runId: "3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6072",
    });
    await file.create();
    const read = holdNextRead();
    const verdict = file.verify();
    await read.started;
    const write = file.update({
      traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    });
    await settle(write);
    read.release();
    expect(await verdict).toBe(true);
    await write;
    expect(await file.verify()).toBe(true);
  });

  it("the memory context file: a verify racing a mid-run rewrite is not tampering", async () => {
    const file = new MemoryContextFile(path.join(await tempDir(), "memory.json"));
    await file.write({ tools: true, text: "", project: "" });
    const read = holdNextRead();
    const verdict = file.verify();
    await read.started;
    const write = file.write({ tools: true, text: "", project: "", conflictsLive: "a conflict" });
    await settle(write);
    read.release();
    expect(await verdict).toBe(true);
    await write;
    expect(await file.verify()).toBe(true);
  });

  it("the egress token file: a verify racing a token rotation is not tampering", async () => {
    const file = new EgressTokenFile(path.join(await tempDir(), "egress-token"));
    await file.write("first-token");
    const read = holdNextRead();
    const verdict = file.verify();
    await read.started;
    const write = file.write("rotated-token");
    await settle(write);
    read.release();
    expect(await verdict).toBe(true);
    await write;
    expect(await file.verify()).toBe(true);
  });

  it("still catches a rewrite by someone else", async () => {
    const file = new ModelFile(path.join(await tempDir(), "model.json"), {
      gatewayUrl: "http://gw",
      model: null,
      token: "t".repeat(40),
      runId: null,
    });
    await file.create();
    const { writeFile } = await vi.importActual<typeof FsPromises>("node:fs/promises");
    await writeFile(file.path, "{}");
    expect(await file.verify()).toBe(false);
  });
});
