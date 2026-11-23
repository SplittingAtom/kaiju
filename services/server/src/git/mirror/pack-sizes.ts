import { open, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { constants, inflateSync } from "node:zlib";

/**
 * The size of every object a fetch brought, read from the packs' headers without inflating the
 * objects (KOBE-766). isomorphic-git inflates a whole object into memory to read it, so a small
 * pack could hold a file that inflates to gigabytes; the mirror checks every object's size here
 * first and refuses beyond the cap. A whole object's header states its size; a delta's target
 * size is the second number at the start of its data, so only the first bytes are inflated.
 */

const IDX_MAGIC = 0xff744f63;
const OFS_DELTA = 6;
const REF_DELTA = 7;
const HEADER_BYTES = 64;
const DELTA_HEAD_BYTES = 256;
/** 256 compressed bytes inflate to far less than this. */
const DELTA_INFLATE_MAX = 1024 * 1024;

/** The offsets of a version-2 pack index (SHA-1). */
export function idxOffsets(idx: Buffer): number[] {
  if (idx.length < 8 + 256 * 4 || idx.readUInt32BE(0) !== IDX_MAGIC || idx.readUInt32BE(4) !== 2) {
    throw new Error("pack index: not version 2");
  }
  const count = idx.readUInt32BE(8 + 255 * 4);
  const offsetsAt = 8 + 256 * 4 + count * 20 + count * 4;
  const largeAt = offsetsAt + count * 4;
  if (idx.length < largeAt) throw new Error("pack index: truncated");
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const small = idx.readUInt32BE(offsetsAt + i * 4);
    if ((small & 0x80000000) === 0) {
      out.push(small);
      continue;
    }
    const at = largeAt + (small & 0x7fffffff) * 8;
    if (idx.length < at + 8) throw new Error("pack index: truncated");
    out.push(Number(idx.readBigUInt64BE(at)));
  }
  return out;
}

/** A little-endian base-128 number at `at` (git's delta header). */
function deltaVarint(buf: Buffer, at: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = at;
  for (;;) {
    const b = buf[i];
    if (b === undefined) throw new Error("pack: truncated delta header");
    value += (b & 0x7f) * 2 ** shift;
    shift += 7;
    i += 1;
    if ((b & 0x80) === 0) return { value, next: i };
  }
}

/** The object's (inflated, final) size from the bytes at its offset. */
export function objectSize(head: Buffer): number {
  let i = 0;
  let b = head[i++] ?? 0;
  const type = (b >> 4) & 7;
  let size = b & 15;
  let shift = 4;
  while (b & 0x80) {
    b = head[i++] ?? 0;
    size += (b & 0x7f) * 2 ** shift;
    shift += 7;
  }
  if (type !== OFS_DELTA && type !== REF_DELTA) return size;
  if (type === OFS_DELTA) {
    do b = head[i++] ?? 0;
    while (b & 0x80);
  } else i += 20;
  // Only the start of the delta: its header is source size, then target size.
  const delta = inflateSync(head.subarray(i), {
    finishFlush: constants.Z_SYNC_FLUSH,
    maxOutputLength: DELTA_INFLATE_MAX,
  });
  const source = deltaVarint(delta, 0);
  return deltaVarint(delta, source.next).value;
}

/** The largest object in the packs under `gitdir` (0 when there are none). */
export async function largestPackedObject(gitdir: string): Promise<number> {
  const dir = path.join(gitdir, "objects", "pack");
  const names = await readdir(dir).catch(() => [] as string[]);
  let largest = 0;
  for (const name of names.filter((n) => n.endsWith(".idx"))) {
    const offsets = idxOffsets(await readFile(path.join(dir, name)));
    const pack = await open(path.join(dir, name.replace(/\.idx$/, ".pack")), "r");
    try {
      const head = Buffer.alloc(HEADER_BYTES + DELTA_HEAD_BYTES);
      for (const offset of offsets) {
        const { bytesRead } = await pack.read(head, 0, head.length, offset);
        largest = Math.max(largest, objectSize(head.subarray(0, bytesRead)));
      }
    } finally {
      await pack.close();
    }
  }
  return largest;
}
