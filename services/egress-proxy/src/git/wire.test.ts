import { describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import {
  ReceivePackCommands,
  SecretScanner,
  credentialPlain,
  credentialSecrets,
  gitDownstreamHeaders,
  gitUpstreamHeaders,
} from "./wire.js";

const pkt = (s: string) => `${(s.length + 4).toString(16).padStart(4, "0")}${s}`;
const Z = "0".repeat(40);
const A = "a".repeat(40);
const B = "b".repeat(40);

describe("git wire helpers (KOBE-763)", () => {
  it("keeps only allow-listed request headers (never the sandbox's credentials or framing)", () => {
    const out = gitUpstreamHeaders([
      "User-Agent",
      "git/2.47",
      "Authorization",
      "Basic c2FuZGJveDpzZWNyZXQ=",
      "Cookie",
      "a=b",
      "Proxy-Authorization",
      "Basic x",
      "Transfer-Encoding",
      "chunked",
      "Content-Length",
      "5",
      "Host",
      "evil.example",
      "Git-Protocol",
      "version=2",
      "Content-Type",
      "application/x-git-upload-pack-request",
      "Upgrade",
      "h2c",
      "HTTP2-Settings",
      "AAA",
      "Expect",
      "100-continue",
      "X-Forwarded-Host",
      "other",
    ]);
    expect(out).toEqual([
      ["User-Agent", "git/2.47"],
      ["Git-Protocol", "version=2"],
      ["Content-Type", "application/x-git-upload-pack-request"],
    ]);
  });

  it("relays only allow-listed response headers and never one carrying the secret", () => {
    const secrets = credentialSecrets("x-access-token", "ghs_0123456789abcdef");
    const out = gitDownstreamHeaders(
      [
        "Content-Type",
        "application/x-git-upload-pack-advertisement",
        "WWW-Authenticate",
        'Basic realm="GitHub"',
        "Set-Cookie",
        "s=1",
        "Location",
        "https://elsewhere.example/",
        "ETag",
        "ghs_0123456789abcdef",
        "Cache-Control",
        "no-cache",
      ],
      secrets,
    );
    expect(out).toEqual([
      ["Content-Type", "application/x-git-upload-pack-advertisement"],
      ["Cache-Control", "no-cache"],
    ]);
  });

  it("finds the credential in a response body across chunk boundaries", () => {
    const secrets = credentialSecrets("x-access-token", "ghs_0123456789abcdef");
    const s = new SecretScanner(secrets);
    expect(s.push(Buffer.from("PACK....ghs_01234")).found).toBe(false);
    expect(s.push(Buffer.from("56789abcdef....")).found).toBe(true);
    const encoded = Buffer.from("x-access-token:ghs_0123456789abcdef").toString("base64");
    const t = new SecretScanner(secrets);
    expect(t.push(Buffer.from(encoded.slice(0, 7))).found).toBe(false);
    expect(t.push(Buffer.from(encoded.slice(7))).found).toBe(true);
    expect(new SecretScanner(secrets).push(Buffer.from("nothing here")).found).toBe(false);
  });

  it("reads the pushed refs from the command list, in pieces, without the pack", () => {
    const body =
      pkt(`${Z} ${A} refs/heads/feature\0 report-status side-band-64k\n`) +
      pkt(`${A} ${B} refs/heads/main\n`) +
      pkt(`${B} ${Z} refs/tags/old\n`) +
      pkt(`${A} ${B} not-a-ref\n`) +
      "0000PACK\u0000\u0000\u0000\u0002binary...";
    const c = new ReceivePackCommands();
    for (let i = 0; i < body.length; i += 7) c.push(Buffer.from(body.slice(i, i + 7), "latin1"));
    expect(c.refs).toEqual([
      { ref: "refs/heads/feature", change: "create" },
      { ref: "refs/heads/main", change: "update" },
      { ref: "refs/tags/old", change: "delete" },
    ]);
    // `not-a-ref` is a command the audit cannot name: flagged as truncated.
    expect(c.truncated).toBe(true);
  });

  it("caps the refs it names and gives up quietly on junk", () => {
    const many = Array.from({ length: 60 }, (_, i) => pkt(`${Z} ${A} refs/heads/b${i}\n`)).join("");
    const c = new ReceivePackCommands();
    c.push(Buffer.from(`${many}0000`));
    expect(c.refs).toHaveLength(50);
    expect(c.truncated).toBe(true);
    const junk = new ReceivePackCommands();
    junk.push(Buffer.from("zzzz garbage"));
    junk.push(Buffer.from(pkt(`${Z} ${A} refs/heads/late\n`)));
    expect(junk.refs).toEqual([]);
  });
});

describe("hold-back scan (KOBE-763 review R2-M1)", () => {
  const USER = "x-access-token";
  const PW = "ghs_FAKEfakeFAKEfake0123456789";
  const PAIR = `${USER}:${PW}`;
  const scanner = () => new SecretScanner(credentialSecrets(USER, PW), credentialPlain(USER, PW));
  const pct = (t: string, upper = false) =>
    [...Buffer.from(t)]
      .map((b) => `%${upper ? b.toString(16).toUpperCase() : b.toString(16)}`)
      .join("");
  const mixed = (t: string) =>
    [...Buffer.from(t)]
      .map((b, i) => (i % 2 ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase()}`))
      .join("");
  const FORMS: Record<string, string> = {
    raw: PW,
    pair: PAIR,
    base64Pair: Buffer.from(PAIR).toString("base64"),
    base64Off1: Buffer.from(`A${PW}BC`).toString("base64"),
    base64Off2: Buffer.from(`AB${PAIR}C`).toString("base64"),
    percent: pct(PW),
    percentUpperPair: pct(PAIR, true),
    percentMixed: mixed(PW),
  };

  /** Feeds `body` in the given pieces; returns what was forwarded and whether it was cut. */
  function feed(pieces: readonly string[]) {
    const s = scanner();
    const out: Buffer[] = [];
    for (const piece of pieces) {
      const step = s.push(Buffer.from(piece));
      if (step.found) return { cut: true, forwarded: Buffer.concat(out).toString() };
      out.push(step.forward);
    }
    const last = s.end();
    if (last.found) return { cut: true, forwarded: Buffer.concat(out).toString() };
    out.push(last.forward);
    return { cut: false, forwarded: Buffer.concat(out).toString() };
  }

  it("cuts 1-byte chunks before any byte of the echo is forwarded, for every form", () => {
    for (const [name, form] of Object.entries(FORMS)) {
      const body = `${"0008NAK\n".repeat(20)}secret=${form}\n`;
      const result = feed([...body]);
      expect(result.cut, name).toBe(true);
      // Nothing from the echoed form itself reached the sandbox.
      expect(result.forwarded.length, name).toBeLessThanOrEqual(body.indexOf(form));
    }
  });

  it("cuts a split at every offset (two chunks) without forwarding the echo", () => {
    const body = `prefix secret=${PW} suffix`;
    const start = body.indexOf(PW);
    for (let i = 0; i <= body.length; i += 1) {
      const result = feed([body.slice(0, i), body.slice(i)]);
      expect(result.cut, `split at ${i}`).toBe(true);
      expect(result.forwarded.length, `split at ${i}`).toBeLessThanOrEqual(start);
    }
  });

  it("finds a needle spanning three chunks and one at the very end of the stream", () => {
    const third = Math.floor(PW.length / 3);
    expect(
      feed(["head ", PW.slice(0, third), PW.slice(third, 2 * third), PW.slice(2 * third), " tail"])
        .cut,
    ).toBe(true);
    const atEnd = feed(["0008NAK\n".repeat(10), PW]);
    expect(atEnd.cut).toBe(true);
    expect(atEnd.forwarded).not.toContain(PW.slice(0, 8));
  });

  it("streams 50 MB without a needle unchanged, holding back a constant small tail", () => {
    const s = scanner();
    const inHash = createHash("sha256");
    const outHash = createHash("sha256");
    let maxHeld = 0;
    let n = 0;
    for (let i = 0; i < 800; i += 1) {
      const chunk = randomBytes(65_536);
      inHash.update(chunk);
      n += chunk.length;
      const step = s.push(chunk);
      expect(step.found).toBe(false);
      outHash.update(step.forward);
      maxHeld = Math.max(maxHeld, s.held);
    }
    const last = s.end();
    expect(last.found).toBe(false);
    outHash.update(last.forward);
    expect(n).toBeGreaterThan(50_000_000);
    expect(outHash.digest("hex")).toBe(inHash.digest("hex"));
    expect(maxHeld).toBeLessThan(512);
  });
});
