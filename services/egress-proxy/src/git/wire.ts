/**
 * What a git smart-HTTP exchange may carry through the proxy (KOBE-763): allow-lists of request
 * and response headers (everything else is dropped), the response's secret scanner, and the
 * receive-pack command reader that names the pushed refs without buffering the pack.
 */

/** Request headers passed upstream for git; the proxy sets Host, framing and Authorization. */
const UP_ALLOWED: ReadonlySet<string> = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "content-type",
  "content-encoding",
  "git-protocol",
  "pragma",
  "cache-control",
  "user-agent",
]);

/** Response headers relayed to the sandbox for git (never WWW-Authenticate, cookies, Location). */
const DOWN_ALLOWED: ReadonlySet<string> = new Set([
  "content-type",
  "content-encoding",
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

/** The secret forms of a Basic credential: the password and the encoded `user:password`. */
export function credentialSecrets(username: string, password: string): string[] {
  const encoded = Buffer.from(`${username}:${password}`).toString("base64");
  return [password, encoded].filter((s) => s.length >= 8);
}

/**
 * Finds any of `secrets` in a stream of chunks, including across chunk boundaries (keeps the
 * last `longest - 1` bytes). Cost: one `indexOf` per secret per chunk.
 */
export class SecretScanner {
  private readonly needles: readonly Buffer[];
  private readonly keep: number;
  private tail: Buffer = Buffer.alloc(0);

  constructor(secrets: readonly string[]) {
    this.needles = secrets.map((s) => Buffer.from(s));
    this.keep = Math.max(0, ...this.needles.map((n) => n.length - 1));
  }

  /** True when the stream (so far) contains a secret. */
  push(chunk: Buffer): boolean {
    if (this.needles.length === 0) return false;
    const window = this.tail.length === 0 ? chunk : Buffer.concat([this.tail, chunk]);
    const found = this.needles.some((n) => window.includes(n));
    this.tail = Buffer.from(window.subarray(Math.max(0, window.length - this.keep)));
    return found;
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
    if (!OID.test(oldId) || !OID.test(newId) || !REF.test(ref)) return;
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
