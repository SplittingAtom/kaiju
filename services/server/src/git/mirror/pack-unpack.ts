import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { inflateSync } from "node:zlib";
import git, { type HttpClient } from "isomorphic-git";
import { GitHostError } from "../../git-hosts/adapter.js";
import { MirrorError } from "./mirror-error.js";

/**
 * The Repo mirror's own fetch (KOBE-766 review H1): isomorphic-git's `fetch` buffers the whole
 * pack and inflates every object, deltas applied, without an output cap, so a small pack that
 * inflates to gigabytes would exhaust the server's memory before any check could run. Here:
 *
 * 1. the upload-pack request is written by hand (one `want`, `deepen`, no side-band) and the
 *    answer streamed to a file in the work folder (the guarded client caps its size);
 * 2. the pack's SHA-1 trailer is checked;
 * 3. every object's size is read from its header BEFORE it is inflated; an object over the cap
 *    stops the fetch; an object is inflated with zlib's `maxOutputLength` set to its stated size
 *    (a stream that inflates further is refused, not buffered); a delta's target size is read
 *    from its (bounded) delta data before it is applied; the sum of all objects is capped too;
 * 4. objects are written as loose objects, one at a time, so memory holds at most one object,
 *    its base and its delta (each within the cap; with the read window about 200 MiB per refresh
 *    at worst), never the pack's content; the bytes they take on disk, with the pack's, are
 *    capped per refresh.
 *
 * isomorphic-git then reads the loose objects (each within the cap) to walk the tree.
 */

export interface UnpackCaps {
  /** Largest object (a file, a tree, a delta's data or result), inflated. */
  readonly maxObjectBytes: number;
  /** All objects together, inflated. */
  readonly maxTotalBytes: number;
  /** Most objects in the pack. */
  readonly maxObjects: number;
  /**
   * Bytes on disk for this fetch: the pack plus every loose object as stored (review R2-M1: a
   * pack of deltas is small, its objects written out need not be).
   */
  readonly maxDiskBytes: number;
  /** Milliseconds since the epoch past which unpacking stops. */
  readonly deadlineAt: number;
}

const TYPES: Readonly<Record<number, "commit" | "tree" | "blob" | "tag">> = {
  1: "commit",
  2: "tree",
  3: "blob",
  4: "tag",
};
const OFS_DELTA = 6;
const REF_DELTA = 7;

function pkt(line: string): Buffer {
  const body = Buffer.from(line, "utf8");
  return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, "0")), body]);
}

/** Capabilities Kaiju asks for, of those the host advertised. */
export function wantedCapabilities(advertised: readonly string[]): string[] {
  const has = new Set(advertised.map((c) => c.split("=")[0]));
  return ["ofs-delta", "no-progress", "shallow"].filter((c) => has.has(c));
}

/**
 * Asks for `head` (and `depth` commits of history where the host can deepen) and streams the
 * answer to `file`. Returns where the pack starts in it and the shallow commits.
 */
export async function downloadPack(
  http: HttpClient,
  repositoryUrl: string,
  head: string,
  advertised: readonly string[],
  depth: number,
  file: string,
  maxPackBytes: number,
): Promise<{ readonly packOffset: number; readonly shallows: readonly string[] }> {
  const caps = wantedCapabilities(advertised);
  const deepen = caps.includes("shallow");
  const body = [
    pkt(`want ${head} ${[...caps, "agent=kaiju"].join(" ")}\n`),
    ...(deepen ? [pkt(`deepen ${depth}\n`)] : []),
    Buffer.from("0000"),
    pkt("done\n"),
  ];
  const res = await http.request({
    url: `${repositoryUrl}/git-upload-pack`,
    method: "POST",
    headers: {
      "content-type": "application/x-git-upload-pack-request",
      accept: "application/x-git-upload-pack-result",
    },
    body: (async function* () {
      for (const b of body) yield new Uint8Array(b);
    })(),
  });
  if (res.statusCode === 401) throw new GitHostError("auth_failed", "The git host refused.");
  if (res.statusCode === 403) throw new GitHostError("forbidden", "The git host refused.");
  if (res.statusCode === 404) throw new GitHostError("not_found", "Not on the host.");
  if (res.statusCode === 429) throw new GitHostError("rate_limited", "Rate limited.");
  if (res.statusCode >= 500) throw new GitHostError("host_unreachable", "Not answering.");
  if (res.statusCode !== 200) throw new MirrorError("fetch_failed");
  const out = fs.createWriteStream(file, { mode: 0o600 });
  let received = 0;
  try {
    for await (const chunk of res.body ?? []) {
      received += chunk.length;
      // Review R4-M1: a pack beyond the cap is a repository too large to mirror, not a transient
      // failure (the cap is derived from the Repo limits, so content within them always fits).
      if (received > maxPackBytes) throw new MirrorError("repository_too_large", "pack");
      if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      out.end((err?: Error | null) => (err ? reject(err) : resolve())),
    );
  }
  return readPreamble(file, deepen);
}

/** The pkt-lines before the pack: shallow lines and a flush (when deepened), then `NAK`. */
async function readPreamble(
  file: string,
  deepened: boolean,
): Promise<{ packOffset: number; shallows: string[] }> {
  const handle = await open(file, "r");
  try {
    const head = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    const buf = head.subarray(0, bytesRead);
    const shallows: string[] = [];
    let at = 0;
    let flushed = !deepened;
    for (;;) {
      if (buf.subarray(at, at + 4).toString("latin1") === "PACK") break;
      const len = Number.parseInt(buf.subarray(at, at + 4).toString("latin1"), 16);
      if (!Number.isInteger(len) || at + 4 > buf.length) throw new MirrorError("fetch_failed");
      if (len === 0) {
        flushed = true;
        at += 4;
        continue;
      }
      if (len < 4 || at + len > buf.length) throw new MirrorError("fetch_failed");
      const line = buf
        .subarray(at + 4, at + len)
        .toString("utf8")
        .trim();
      at += len;
      if (line.startsWith("shallow ")) {
        const oid = line.slice("shallow ".length);
        if (!/^[0-9a-f]{40}$/.test(oid)) throw new MirrorError("fetch_failed");
        shallows.push(oid);
      } else if (line.startsWith("ERR")) {
        throw new MirrorError("fetch_failed");
      } else if (line !== "NAK" && !line.startsWith("unshallow ") && !line.startsWith("ACK")) {
        throw new MirrorError("fetch_failed");
      }
    }
    if (!flushed) throw new MirrorError("fetch_failed");
    return { packOffset: at, shallows };
  } finally {
    await handle.close();
  }
}

/** Applies a git delta to `base`, refusing anything that does not fit exactly. */
export function applyDelta(base: Buffer, delta: Buffer, start: number, target: number): Buffer {
  const out = Buffer.alloc(target);
  let i = start;
  let o = 0;
  while (i < delta.length) {
    const op = delta[i++] ?? 0;
    if (op & 0x80) {
      let off = 0;
      let len = 0;
      if (op & 0x01) off |= delta[i++] ?? 0;
      if (op & 0x02) off |= (delta[i++] ?? 0) << 8;
      if (op & 0x04) off |= (delta[i++] ?? 0) << 16;
      if (op & 0x08) off += (delta[i++] ?? 0) * 2 ** 24;
      if (op & 0x10) len |= delta[i++] ?? 0;
      if (op & 0x20) len |= (delta[i++] ?? 0) << 8;
      if (op & 0x40) len |= (delta[i++] ?? 0) << 16;
      if (len === 0) len = 0x10000;
      if (off + len > base.length || o + len > target) throw new MirrorError("fetch_failed");
      base.copy(out, o, off, off + len);
      o += len;
    } else if (op > 0) {
      if (i + op > delta.length || o + op > target) throw new MirrorError("fetch_failed");
      delta.copy(out, o, i, i + op);
      i += op;
      o += op;
    } else {
      throw new MirrorError("fetch_failed");
    }
  }
  if (o !== target) throw new MirrorError("fetch_failed");
  return out;
}

/** A little-endian base-128 number (a delta header field). */
function deltaVarint(buf: Buffer, at: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = at;
  for (;;) {
    const b = buf[i];
    if (b === undefined || shift > 49) throw new MirrorError("fetch_failed");
    value += (b & 0x7f) * 2 ** shift;
    shift += 7;
    i += 1;
    if ((b & 0x80) === 0) return { value, next: i };
  }
}

interface Entry {
  readonly type: number;
  readonly size: number;
  readonly dataAt: number;
  readonly baseAt?: number;
  readonly baseOid?: string;
}

/** Reads one object header at `at` (with the delta base's position or id). */
async function header(handle: fs.promises.FileHandle, at: number): Promise<Entry> {
  const buf = Buffer.alloc(64);
  const { bytesRead } = await handle.read(buf, 0, buf.length, at);
  let i = 0;
  let b = buf[i++] ?? 0;
  const type = (b >> 4) & 7;
  let size = b & 15;
  let shift = 4;
  while (b & 0x80) {
    if (i >= bytesRead || shift > 49) throw new MirrorError("fetch_failed");
    b = buf[i++] ?? 0;
    size += (b & 0x7f) * 2 ** shift;
    shift += 7;
  }
  if (type === OFS_DELTA) {
    b = buf[i++] ?? 0;
    let off = b & 0x7f;
    while (b & 0x80) {
      if (i >= bytesRead || off > 2 ** 45) throw new MirrorError("fetch_failed");
      b = buf[i++] ?? 0;
      off = (off + 1) * 128 + (b & 0x7f);
    }
    if (off <= 0 || off > at) throw new MirrorError("fetch_failed");
    return { type, size, dataAt: at + i, baseAt: at - off };
  }
  if (type === REF_DELTA) {
    if (i + 20 > bytesRead) throw new MirrorError("fetch_failed");
    const baseOid = buf.subarray(i, i + 20).toString("hex");
    return { type, size, dataAt: at + i + 20, baseOid };
  }
  if (!TYPES[type]) throw new MirrorError("fetch_failed");
  return { type, size, dataAt: at + i };
}

/**
 * Inflates the zlib stream at `at` to exactly `size` bytes, never more: returns the data and how
 * many compressed bytes it took. The window read grows (up to `limit`) when the stream is longer
 * than a normal deflate bound.
 */
async function inflateAt(
  handle: fs.promises.FileHandle,
  at: number,
  size: number,
  end: number,
): Promise<{ data: Buffer; used: number }> {
  let window = Math.min(end - at, size + (size >> 10) + 1024);
  for (;;) {
    const buf = Buffer.alloc(window);
    const { bytesRead } = await handle.read(buf, 0, window, at);
    try {
      const out = inflateSync(buf.subarray(0, bytesRead), {
        info: true,
        maxOutputLength: Math.max(size, 1),
      }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
      if (out.buffer.length !== size) throw new MirrorError("fetch_failed");
      return { data: out.buffer, used: out.engine.bytesWritten };
    } catch (err) {
      if (err instanceof MirrorError) throw err;
      const code = (err as { code?: string }).code;
      // Truncated input: a stream longer than the window (padding blocks); read more, bounded.
      if (code === "Z_BUF_ERROR" && window < end - at) {
        window = Math.min(end - at, window * 2);
        continue;
      }
      throw new MirrorError("fetch_failed");
    }
  }
}

/** Checks the pack's trailing SHA-1 over everything before it. */
async function checkTrailer(file: string, from: number, size: number): Promise<void> {
  if (size - from < 32) throw new MirrorError("fetch_failed");
  const hash = createHash("sha1");
  for await (const chunk of fs.createReadStream(file, { start: from, end: size - 21 })) {
    hash.update(chunk as Buffer);
  }
  const handle = await open(file, "r");
  try {
    const trailer = Buffer.alloc(20);
    await handle.read(trailer, 0, 20, size - 20);
    if (!hash.digest().equals(trailer)) throw new MirrorError("fetch_failed");
  } finally {
    await handle.close();
  }
}

/**
 * Unpacks the pack at `offset` of `file` into loose objects of the repository at `dir`, under
 * the caps (see the module header). Returns the number of objects.
 */
export async function unpackPack(
  file: string,
  offset: number,
  dir: string,
  caps: UnpackCaps,
): Promise<number> {
  const size = (await fs.promises.stat(file)).size;
  await checkTrailer(file, offset, size);
  const end = size - 20;
  const handle = await open(file, "r");
  try {
    const head = Buffer.alloc(12);
    await handle.read(head, 0, 12, offset);
    const version = head.readUInt32BE(4);
    if (head.subarray(0, 4).toString("latin1") !== "PACK" || (version !== 2 && version !== 3)) {
      throw new MirrorError("fetch_failed");
    }
    const count = head.readUInt32BE(8);
    // Review R2-L4: a count beyond the cap is a size refusal, not a file count.
    if (count > caps.maxObjects) throw new MirrorError("repository_too_large", "objects");
    const written = new Map<number, { oid: string; type: string }>();
    const byOid = new Map<string, { oid: string; type: string }>();
    // Review R2-L1: deltas waiting for their base, by the base's position or id (linear).
    const waiting = new Map<string, { at: number; entry: Entry }[]>();
    let waitingCount = 0;
    let total = 0;
    // Review R2-M1: bytes this unpack put on disk (the pack, then each loose object as stored).
    let disk = size;
    let at = offset + 12;
    const tick = () => {
      if (Date.now() > caps.deadlineAt) throw new GitHostError("host_unreachable", "Too long.");
    };
    const account = (n: number) => {
      if (n > caps.maxObjectBytes) throw new MirrorError("file_too_large", String(n));
      total += n;
      if (total > caps.maxTotalBytes) {
        throw new MirrorError("repository_too_large", String(caps.maxTotalBytes));
      }
    };
    const checkDisk = () => {
      if (disk > caps.maxDiskBytes) {
        throw new MirrorError("repository_too_large", String(caps.maxDiskBytes));
      }
    };
    checkDisk();
    const store = async (type: string, object: Buffer): Promise<string> => {
      const oid = await git.writeObject({
        fs,
        dir,
        type: type as "blob",
        object,
        format: "content",
      });
      if (!byOid.has(oid)) {
        const loose = path.join(dir, ".git", "objects", oid.slice(0, 2), oid.slice(2));
        disk += (await fs.promises.stat(loose)).size;
        checkDisk();
      }
      return oid;
    };
    const keyOf = (e: Entry) => (e.baseAt !== undefined ? `@${e.baseAt}` : `#${e.baseOid ?? ""}`);
    const remember = (objAt: number, w: { oid: string; type: string }): void => {
      written.set(objAt, w);
      byOid.set(w.oid, w);
      // Deltas that waited for this object become ready (resolved by `drain`, iteratively).
      for (const key of [`@${objAt}`, `#${w.oid}`]) {
        const list = waiting.get(key);
        if (!list) continue;
        waiting.delete(key);
        waitingCount -= list.length;
        ready.push(...list);
      }
    };
    const ready: { at: number; entry: Entry }[] = [];
    const drain = async () => {
      for (let p = ready.pop(); p; p = ready.pop()) await resolveDelta(p.at, p.entry);
    };
    async function resolveDelta(objAt: number, e: Entry, inflated?: Buffer): Promise<void> {
      tick();
      const base = e.baseAt !== undefined ? written.get(e.baseAt) : byOid.get(e.baseOid ?? "");
      if (!base) {
        const key = keyOf(e);
        const list = waiting.get(key) ?? [];
        list.push({ at: objAt, entry: e });
        waiting.set(key, list);
        waitingCount += 1;
        return;
      }
      const delta = inflated ?? (await inflateAt(handle, e.dataAt, e.size, end)).data;
      const source = deltaVarint(delta, 0);
      const target = deltaVarint(delta, source.next);
      account(target.value);
      const { object } = await git.readObject({ fs, dir, oid: base.oid, format: "content" });
      const baseBuf = Buffer.from(object as Uint8Array);
      if (baseBuf.length !== source.value) throw new MirrorError("fetch_failed");
      const result = applyDelta(baseBuf, delta, target.next, target.value);
      remember(objAt, { oid: await store(base.type, result), type: base.type });
    }
    for (let n = 0; n < count; n += 1) {
      tick();
      if (at >= end) throw new MirrorError("fetch_failed");
      const e = await header(handle, at);
      // The stated size first: nothing over the cap is ever inflated.
      if (e.size > caps.maxObjectBytes) throw new MirrorError("file_too_large", String(e.size));
      // Every inflation counts, a delta's data too (review R2-L1: a delta whose base never
      // comes cannot make the server inflate without limit).
      account(e.size);
      const { data, used } = await inflateAt(handle, e.dataAt, e.size, end);
      if (e.type === OFS_DELTA || e.type === REF_DELTA) {
        await resolveDelta(at, e, data);
      } else {
        const type = TYPES[e.type] as string;
        remember(at, { oid: await store(type, data), type });
      }
      await drain();
      at = e.dataAt + used;
    }
    if (at !== end || waitingCount > 0) throw new MirrorError("fetch_failed");
    return count;
  } finally {
    await handle.close();
  }
}

/** Records the shallow commits so history walks stop there. */
export async function writeShallow(dir: string, shallows: readonly string[]): Promise<void> {
  if (shallows.length === 0) return;
  await fs.promises.writeFile(path.join(dir, ".git", "shallow"), `${shallows.join("\n")}\n`);
}
