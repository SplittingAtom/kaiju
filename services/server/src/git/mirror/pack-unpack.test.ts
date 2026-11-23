import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import git from "isomorphic-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyDelta, unpackPack, wantedCapabilities } from "./pack-unpack.js";

/**
 * KOBE-766 review H1: the mirror's pack reader never inflates more than an object's stated size,
 * refuses an object or delta result over the cap before inflating or applying it, and caps the
 * pack's total. Packs here are built by hand: small on disk, huge if inflated.
 */
let work: string;
let n = 0;

beforeAll(async () => {
  work = await mkdtemp(path.join(tmpdir(), "kobe-unpack-test-"));
});
afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

const MiB = 1024 * 1024;

function objectHeader(type: number, size: number): Buffer {
  const bytes: number[] = [];
  let b = (type << 4) | (size & 15);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    bytes.push(b | 0x80);
    b = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(b);
  return Buffer.from(bytes);
}

function varint(value: number): number[] {
  const out: number[] = [];
  let v = value;
  do {
    let b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    out.push(b);
  } while (v > 0);
  return out;
}

/** git's OFS_DELTA distance encoding. */
function ofsOffset(off: number): Buffer {
  const out = [off & 127];
  let n = Math.floor(off / 128);
  while (n > 0) {
    n -= 1;
    out.unshift(128 | (n & 127));
    n = Math.floor(n / 128);
  }
  return Buffer.from(out);
}

/** An object entry: header with the stated size, then the deflated data. */
const entry = (type: number, stated: number, data: Buffer) =>
  Buffer.concat([objectHeader(type, stated), deflateSync(data)]);

function pack(entries: Buffer[], corrupt = false): Buffer {
  const head = Buffer.alloc(12);
  head.write("PACK", 0, "latin1");
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(entries.length, 8);
  const body = Buffer.concat([head, ...entries]);
  const sum = createHash("sha1").update(body).digest();
  if (corrupt) sum[0] = (sum[0] ?? 0) ^ 0xff;
  return Buffer.concat([body, sum]);
}

async function unpack(bytes: Buffer, caps: Partial<Parameters<typeof unpackPack>[3]> = {}) {
  n += 1;
  const dir = path.join(work, `r${n}`);
  await fs.promises.mkdir(dir);
  await git.init({ fs, dir });
  const file = path.join(work, `p${n}.pack`);
  await writeFile(file, bytes);
  const count = await unpackPack(file, 0, dir, {
    maxObjectBytes: MiB,
    maxTotalBytes: 4 * MiB,
    maxObjects: 1000,
    deadlineAt: Date.now() + 60_000,
    ...caps,
  });
  return { dir, count };
}

const blobOid = (data: Buffer) =>
  createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${data.length}\0`), data]))
    .digest("hex");

/** Bytes outside the V8 heap (Buffers) now. */
const external = () => process.memoryUsage().arrayBuffers;

describe("unpackPack", () => {
  it("writes whole objects and both kinds of delta", async () => {
    const base = Buffer.from("hello mirror, ".repeat(50));
    const target = Buffer.concat([base, Buffer.from("and more")]);
    // Delta: source size, target size, copy the whole base, insert 8 bytes.
    const delta = Buffer.from([
      ...varint(base.length),
      ...varint(target.length),
      0x80 | 0x01 | 0x10 | 0x20,
      0,
      base.length & 0xff,
      base.length >> 8,
      8,
      ...Buffer.from("and more"),
    ]);
    const first = entry(3, base.length, base);
    // OFS delta offset: back to the first object.
    const ofsEntry = Buffer.concat([
      objectHeader(6, delta.length),
      ofsOffset(first.length),
      deflateSync(delta),
    ]);
    const refEntry = Buffer.concat([
      objectHeader(7, delta.length),
      Buffer.from(blobOid(base), "hex"),
      deflateSync(delta),
    ]);
    const { dir, count } = await unpack(pack([first, ofsEntry, refEntry]));
    expect(count).toBe(3);
    const { blob } = await git.readBlob({ fs, dir, oid: blobOid(target) });
    expect(Buffer.from(blob).toString()).toBe(target.toString());
  });

  it("refuses an object stated over the cap without inflating it", async () => {
    // 64 MiB of zeros deflates to about 64 KiB.
    const zeros = Buffer.alloc(64 * MiB);
    const bytes = pack([entry(3, zeros.length, zeros)]);
    expect(bytes.length).toBeLessThan(MiB);
    const before = external();
    await expect(unpack(bytes)).rejects.toMatchObject({ code: "file_too_large" });
    // The bomb's inflated size never reached memory (the fixture's own 64 MiB is already freed
    // or counted before).
    expect(external() - before).toBeLessThan(8 * MiB);
  });

  it("refuses a stream that inflates past its stated size (output capped at the stated size)", async () => {
    const zeros = Buffer.alloc(64 * MiB);
    const lying = pack([entry(3, 1024, zeros)]);
    const before = external();
    await expect(unpack(lying)).rejects.toMatchObject({ code: "fetch_failed" });
    expect(external() - before).toBeLessThan(8 * MiB);
  });

  it("refuses a delta whose result is over the cap before applying it", async () => {
    const base = Buffer.from("x".repeat(1024));
    const huge = 64 * MiB;
    // Copy the base 65,536 times: a 260 KiB delta of copy instructions for a 64 MiB result.
    const ops: number[] = [...varint(base.length), ...varint(huge)];
    for (let i = 0; i < huge / 1024; i += 1) ops.push(0x80 | 0x10 | 0x20, 0x00, 0x04);
    const delta = Buffer.from(ops);
    const first = entry(3, base.length, base);
    const bomb = Buffer.concat([
      objectHeader(6, delta.length),
      ofsOffset(first.length),
      deflateSync(delta),
    ]);
    const before = external();
    await expect(unpack(pack([first, bomb]))).rejects.toMatchObject({
      code: "file_too_large",
      detail: String(huge),
    });
    expect(external() - before).toBeLessThan(8 * MiB);
  });

  it("caps the total of all objects, the object count, and checks the trailer", async () => {
    const parts = [0, 1, 2].map((i) => entry(3, 600 * 1024, Buffer.alloc(600 * 1024, i)));
    await expect(unpack(pack(parts), { maxTotalBytes: MiB })).rejects.toMatchObject({
      code: "repository_too_large",
    });
    await expect(unpack(pack(parts), { maxObjects: 2 })).rejects.toMatchObject({
      code: "too_many_files",
    });
    const small = entry(3, 3, Buffer.from("abc"));
    await expect(unpack(pack([small], true))).rejects.toMatchObject({ code: "fetch_failed" });
  });
});

describe("applyDelta and capabilities", () => {
  it("refuses copies outside the base and results of the wrong size", () => {
    const base = Buffer.from("abcdef");
    expect(applyDelta(base, Buffer.from([0x90, 3]), 0, 3).toString()).toBe("abc");
    expect(() => applyDelta(base, Buffer.from([0x91, 4, 6]), 0, 6)).toThrow();
    expect(() => applyDelta(base, Buffer.from([0x90, 3]), 0, 4)).toThrow();
    expect(() => applyDelta(base, Buffer.from([0x00]), 0, 0)).toThrow();
  });

  it("asks only for capabilities the host advertised", () => {
    expect(wantedCapabilities(["ofs-delta", "shallow", "agent=git/2"])).toEqual([
      "ofs-delta",
      "shallow",
    ]);
  });
});
