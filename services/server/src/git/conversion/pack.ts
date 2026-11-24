import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { deflate as deflateCb, inflate as inflateCb } from "node:zlib";
import { ConversionStepError } from "./objects.js";

/**
 * A git receive-pack request written to a file in the conversion's work folder (KOBE-765, round 2):
 * the ref update command (`<old> <new> <ref>`, with `report-status`), then a version 2 packfile of
 * the given objects, read one at a time from the loose objects isomorphic-git wrote. Memory holds
 * at most one object (a file is at most 100 MiB) whatever the batch's size, and the request is
 * then streamed from disk (`git-wire.ts` `postFile`). The pack is not thin and never references a
 * base the host lacks: the objects are those the batch's commits introduce, the host has the
 * earlier ones (it acknowledged their commits).
 *
 * isomorphic-git's own `push` builds the whole pack in memory, which tied memory to commit size;
 * this writes the same format git's `pack-objects` would (undeltified entries).
 */
const inflate = promisify(inflateCb);
const deflate = promisify(deflateCb);

const ZERO = "0".repeat(40);
const TYPES: Readonly<Record<string, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** One pkt-line (`git` smart protocol framing). */
export function pktLine(payload: string): Buffer {
  const body = Buffer.from(payload, "utf8");
  return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, "0")), body]);
}

/** A pack entry's header: type and size, size in 7-bit little-endian groups. */
export function entryHeader(type: number, size: number): Buffer {
  const bytes: number[] = [];
  let rest = Math.floor(size / 16);
  let byte = (type << 4) | (size & 0x0f);
  while (rest > 0) {
    bytes.push(byte | 0x80);
    byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(byte);
  return Buffer.from(bytes);
}

/** A loose object's type and content (`objects/aa/bb…`, zlib of `<type> <size>\0<content>`). */
export async function readLoose(
  gitdir: string,
  oid: string,
): Promise<{ type: number; content: Buffer }> {
  if (!/^[0-9a-f]{40}$/.test(oid)) throw new ConversionStepError("internal_error", "object id");
  const raw = await inflate(
    await readFile(path.join(gitdir, "objects", oid.slice(0, 2), oid.slice(2))),
  );
  const nul = raw.indexOf(0);
  const [name, size] = raw.subarray(0, nul).toString("latin1").split(" ");
  const type = TYPES[name ?? ""];
  const content = raw.subarray(nul + 1);
  if (type === undefined || Number(size) !== content.length) {
    throw new ConversionStepError("internal_error", `object ${oid}`);
  }
  return { type, content };
}

export interface ReceivePackRequest {
  readonly gitdir: string;
  readonly ref: string;
  /** The ref's value on the host now (null: the branch does not exist yet). */
  readonly oldOid: string | null;
  readonly newOid: string;
  readonly objects: readonly string[];
  /** Where to write it (overwritten). */
  readonly file: string;
}

/** Writes the request; returns its size in bytes. */
export async function writeReceivePack(req: ReceivePackRequest): Promise<number> {
  const out = createWriteStream(req.file, { mode: 0o600 });
  const failed = new Promise<never>((_, reject) => out.once("error", reject));
  failed.catch(() => undefined);
  const write = async (chunk: Buffer) => {
    if (!out.write(chunk))
      await Promise.race([new Promise<void>((r) => out.once("drain", () => r())), failed]);
  };
  const hash = createHash("sha1");
  const packed = async (chunk: Buffer) => {
    hash.update(chunk);
    await write(chunk);
  };
  await write(
    pktLine(`${req.oldOid ?? ZERO} ${req.newOid} ${req.ref}\0report-status agent=kaiju\n`),
  );
  await write(Buffer.from("0000"));
  const header = Buffer.alloc(12);
  header.write("PACK", 0, "latin1");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(req.objects.length, 8);
  await packed(header);
  for (const oid of req.objects) {
    const { type, content } = await readLoose(req.gitdir, oid);
    await packed(entryHeader(type, content.length));
    await packed(await deflate(content));
  }
  await write(hash.digest());
  await Promise.race([new Promise<void>((r) => out.end(() => r())), failed]);
  return (await stat(req.file)).size;
}

export type ReceivePackOutcome =
  { readonly ok: true } | { readonly ok: false; readonly reason: string; readonly stale: boolean };

/**
 * Reads the host's `report-status` answer: `unpack ok` and `ok <ref>`, or `unpack <error>` / `ng
 * <ref> <reason>`. `stale` when the ref moved under us (someone else pushed), as git reports it.
 */
export function parseReportStatus(body: Buffer, ref: string): ReceivePackOutcome {
  const lines: string[] = [];
  let at = 0;
  while (at + 4 <= body.length) {
    const len = Number.parseInt(body.subarray(at, at + 4).toString("latin1"), 16);
    if (!Number.isFinite(len)) break;
    if (len === 0) {
      at += 4;
      continue;
    }
    if (len < 4 || at + len > body.length) break;
    lines.push(
      body
        .subarray(at + 4, at + len)
        .toString("utf8")
        .replace(/\n$/, ""),
    );
    at += len;
  }
  const unpack = lines.find((l) => l.startsWith("unpack "));
  if (unpack === undefined) return { ok: false, reason: "no report from the host", stale: false };
  if (unpack !== "unpack ok") return { ok: false, reason: unpack, stale: false };
  if (lines.includes(`ok ${ref}`)) return { ok: true };
  const ng = lines.find((l) => l.startsWith(`ng ${ref} `));
  const reason = ng?.slice(`ng ${ref} `.length) ?? "the host did not update the branch";
  return {
    ok: false,
    reason,
    stale: /stale info|fetch first|non-fast-forward|failed to lock|cannot lock/i.test(reason),
  };
}
