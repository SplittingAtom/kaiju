/**
 * What a git smart-HTTP exchange may carry through the proxy (KOBE-763): allow-lists of request
 * and response headers (everything else is dropped), the response's secret scanner, and the
 * receive-pack command reader that names the pushed refs without buffering the pack.
 */

/**
 * Request headers passed upstream for git; the proxy sets Host, framing, Authorization and
 * `Accept-Encoding: identity` (review M1: a compressed response could hide an echoed credential
 * from the scan, so the sandbox's Accept-Encoding is never passed on).
 */
const UP_ALLOWED: ReadonlySet<string> = new Set([
  "accept",
  "accept-language",
  "content-type",
  "content-encoding",
  "git-protocol",
  "pragma",
  "cache-control",
  "user-agent",
]);

/**
 * Response headers relayed to the sandbox for git (never WWW-Authenticate, cookies, Location;
 * never Content-Encoding: an encoded response is refused before this, `responseEncodingRefused`).
 */
const DOWN_ALLOWED: ReadonlySet<string> = new Set([
  "content-type",
  "cache-control",
  "expires",
  "pragma",
  "date",
  "vary",
  "etag",
  "last-modified",
]);

/** Request headers that carry a credential of the sandbox's own: refused for git requests. */
export const CREDENTIAL_HEADERS: readonly string[] = ["authorization", "cookie"];

const CTL = /[\r\n\0]/;

/** The sandbox's headers kept for the upstream request (allow-list; values without CR/LF/NUL). */
export function gitUpstreamHeaders(rawHeaders: readonly string[]): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i] as string;
    const value = rawHeaders[i + 1] as string;
    if (!UP_ALLOWED.has(name.toLowerCase()) || CTL.test(value) || value.length > 1024) continue;
    out.push([name, value]);
  }
  return out;
}

/** The upstream's response headers relayed to the sandbox (allow-list, secret-free). */
export function gitDownstreamHeaders(
  rawHeaders: readonly string[],
  secrets: readonly string[],
): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i] as string;
    const value = rawHeaders[i + 1] as string;
    if (!DOWN_ALLOWED.has(name.toLowerCase())) continue;
    if (secrets.some((s) => value.includes(s))) continue;
    out.push([name, value]);
  }
  return out;
}

/** Base64 of `text` wherever it sits in a longer base64 stream: the three alignments' stable middle. */
function base64Forms(text: string): string[] {
  const bytes = Buffer.from(text);
  const out = [bytes.toString("base64")];
  for (const offset of [1, 2]) {
    const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString("base64");
    // The first 4 characters mix in the padding bytes; the last 4 may hold padding: both dropped.
    out.push(encoded.slice(4, Math.max(4, encoded.length - 4)));
  }
  // Also from offset 0 without the tail group (when more bytes follow in the stream).
  out.push(out[0]?.slice(0, Math.max(0, (out[0]?.length ?? 0) - 4)) ?? "");
  return out;
}

/** Percent-encoded forms (upper and lower case hex, and `+` for spaces is irrelevant to tokens). */
function percentForms(text: string): string[] {
  const upper = [...Buffer.from(text)]
    .map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`)
    .join("");
  return [encodeURIComponent(text), upper, upper.toLowerCase()];
}

/**
 * Every form of a Basic credential a response could echo (review M1): the password and the
 * `user:password` pair, each raw, base64 (at any alignment in a longer base64 stream) and
 * percent-encoded. Forms shorter than 8 characters are not matched (they would cut real packs).
 */
export function credentialSecrets(username: string, password: string): string[] {
  const pair = `${username}:${password}`;
  const forms = new Set<string>();
  for (const text of [password, pair]) {
    forms.add(text);
    for (const f of base64Forms(text)) forms.add(f);
    for (const f of percentForms(text)) forms.add(f);
  }
  return [...forms].filter((s) => s.length >= 8);
}

/**
 * Why a response must not be relayed as it is (review M1): any Content-Encoding other than
 * identity (the proxy asked for identity; the scan must see plain bytes), or a Transfer-Encoding
 * other than chunked. Undefined when the response is plain.
 */
export function responseEncodingRefused(headers: {
  readonly [name: string]: string | string[] | undefined;
}): string | undefined {
  const value = (name: string) => {
    const v = headers[name];
    return (Array.isArray(v) ? v.join(",") : (v ?? "")).trim().toLowerCase();
  };
  const ce = value("content-encoding");
  if (ce !== "" && ce !== "identity") return "content-encoding";
  const te = value("transfer-encoding");
  if (te !== "" && te !== "chunked") return "transfer-encoding";
  return undefined;
}

/** The plain secrets (password and `user:password`), also looked for in percent-decoded text. */
export function credentialPlain(username: string, password: string): string[] {
  return [password, `${username}:${password}`];
}

/** `%XX` sequences decoded (any mix of encoded and raw bytes); other bytes unchanged. */
function percentDecoded(window: Buffer): Buffer {
  if (!window.includes(0x25)) return window;
  const out = Buffer.allocUnsafe(window.length);
  let n = 0;
  const hex = (b: number | undefined) =>
    b === undefined
      ? -1
      : b >= 48 && b <= 57
        ? b - 48
        : b >= 65 && b <= 70
          ? b - 55
          : b >= 97 && b <= 102
            ? b - 87
            : -1;
  for (let i = 0; i < window.length; i += 1) {
    const hi = window[i] === 0x25 ? hex(window[i + 1]) : -1;
    const lo = hi >= 0 ? hex(window[i + 2]) : -1;
    if (lo >= 0) {
      out[n++] = hi * 16 + lo;
      i += 2;
    } else {
      out[n++] = window[i] as number;
    }
  }
  return out.subarray(0, n);
}

export interface ScanStep {
  /** A secret appeared: cut the response, forward nothing more. */
  readonly found: boolean;
  /** Bytes now safe to forward (never any byte of a match). */
  readonly forward: Buffer;
}

/**
 * Finds any of `secrets` in a stream and says which bytes are safe to forward (review R2-M1):
 * the last `longest needle - 1` bytes are held back until more data arrives or the stream ends,
 * so a credential echoed in small pieces is cut before any byte of it reaches the sandbox. A
 * needle that starts in the forwarded part would end inside the scanned window, so it is always
 * seen first. `plain` secrets are also matched in a percent-decoded copy of the window (mixed
 * `%XX` and raw characters); their encoded span is at most the percent form's length, which the
 * caller includes in `secrets`, so the hold-back covers it. Memory: the held tail only.
 */
export class SecretScanner {
  private readonly needles: readonly Buffer[];
  private readonly plain: readonly Buffer[];
  private readonly keep: number;
  private tail: Buffer = Buffer.alloc(0);

  constructor(secrets: readonly string[], plain: readonly string[] = []) {
    this.needles = secrets.map((s) => Buffer.from(s));
    this.plain = plain.filter((s) => s.length >= 8).map((s) => Buffer.from(s));
    this.keep = Math.max(0, ...this.needles.map((n) => n.length - 1));
  }

  /** Bytes held back right now (they count toward the relay's buffered-bytes ceiling). */
  get held(): number {
    return this.tail.length;
  }

  private found(window: Buffer): boolean {
    if (this.needles.some((n) => window.includes(n))) return true;
    if (this.plain.length === 0) return false;
    const decoded = percentDecoded(window);
    return decoded !== window && this.plain.some((n) => decoded.includes(n));
  }

  push(chunk: Buffer): ScanStep {
    const window = this.tail.length === 0 ? chunk : Buffer.concat([this.tail, chunk]);
    if (this.found(window)) {
      this.tail = Buffer.alloc(0);
      return { found: true, forward: Buffer.alloc(0) };
    }
    const cut = Math.max(0, window.length - this.keep);
    this.tail = Buffer.from(window.subarray(cut));
    return { found: false, forward: window.subarray(0, cut) };
  }

  /** The end of the stream: the held tail (already scanned with everything before it). */
  end(): ScanStep {
    const rest = this.tail;
    this.tail = Buffer.alloc(0);
    return { found: this.found(rest), forward: rest };
  }
}

export type RefChange = "create" | "update" | "delete";

export interface PushedRef {
  readonly ref: string;
  readonly change: RefChange;
}

/** Refs named per push in the audit row; more are counted as truncated. */
export const MAX_AUDITED_REFS = 50;
/** The command list is read from at most this many leading bytes of the push. */
const MAX_COMMAND_BYTES = 64 * 1024;
const OID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const REF = /^refs\/[A-Za-z0-9._/@+-]{1,250}$/;

/**
 * Reads the receive-pack command list (`<old> <new> <ref>` pkt-lines up to the flush packet) from
 * the first bytes of a push while the body streams on untouched. Gives up quietly on anything it
 * does not understand (the push is not affected; the audit row then names no refs).
 */
export class ReceivePackCommands {
  private buffer: Buffer = Buffer.alloc(0);
  private done = false;
  readonly refs: PushedRef[] = [];
  truncated = false;

  push(chunk: Buffer): void {
    if (this.done) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.parse();
    if (!this.done && this.buffer.length > MAX_COMMAND_BYTES) this.stop();
  }

  private stop(): void {
    this.done = true;
    this.buffer = Buffer.alloc(0);
  }

  private parse(): void {
    while (!this.done && this.buffer.length >= 4) {
      const lenText = this.buffer.subarray(0, 4).toString("latin1");
      if (!/^[0-9a-f]{4}$/.test(lenText)) return this.stop();
      const len = parseInt(lenText, 16);
      if (len === 0) return this.stop();
      if (len < 4) return this.stop();
      if (this.buffer.length < len) return;
      const line = this.buffer.subarray(4, len).toString("utf8");
      this.buffer = this.buffer.subarray(len);
      this.command(line);
    }
  }

  private command(line: string): void {
    const text = line.split("\0")[0]?.replace(/\n$/, "") ?? "";
    const [oldId = "", newId = "", ref = ""] = text.split(" ");
    if (!OID.test(oldId) || !OID.test(newId)) return;
    // A ref the audit cannot name (outside its pattern, e.g. non-ASCII) is flagged, not dropped
    // silently (review round 2).
    if (!REF.test(ref)) {
      this.truncated = true;
      return;
    }
    if (this.refs.length >= MAX_AUDITED_REFS) {
      this.truncated = true;
      return;
    }
    const change: RefChange = /^0+$/.test(oldId)
      ? "create"
      : /^0+$/.test(newId)
        ? "delete"
        : "update";
    this.refs.push({ ref, change });
  }
}
