import { describe, expect, it } from "vitest";
import {
  ReceivePackCommands,
  SecretScanner,
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
    expect(s.push(Buffer.from("PACK....ghs_01234"))).toBe(false);
    expect(s.push(Buffer.from("56789abcdef...."))).toBe(true);
    const encoded = Buffer.from("x-access-token:ghs_0123456789abcdef").toString("base64");
    const t = new SecretScanner(secrets);
    expect(t.push(Buffer.from(encoded.slice(0, 7)))).toBe(false);
    expect(t.push(Buffer.from(encoded.slice(7)))).toBe(true);
    expect(new SecretScanner(secrets).push(Buffer.from("nothing here"))).toBe(false);
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
    expect(c.truncated).toBe(false);
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
