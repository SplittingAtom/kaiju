import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { GIT_MIRROR_FAILURES, GIT_REPO_HOST_STATES } from "@kobe/protocol";
import { GIT_REPOSITORY_HOST_STATE_VALUES } from "@kobe/db";
import { GitHostError } from "../../git-hosts/adapter.js";
import { MirrorHeld } from "./apply.js";
import { MirrorError } from "./fetch.js";
import { GIT_MIRROR_BACKOFF_MAX_MS, mirrorBackoffMs } from "./limits.js";
import { idxOffsets, objectSize } from "./pack-sizes.js";
import { failureOf } from "./refresh.js";
import { failureView, MIRROR_FAILURE_MESSAGES, readOnlyReason } from "./store.js";

/** KOBE-766: the mirror's back-off, failure codes, read-only reasons and pack header sizes. */
describe("back-off (ac-2)", () => {
  it("doubles from 5 minutes to 6 hours", () => {
    expect(mirrorBackoffMs(1)).toBe(5 * 60_000);
    expect(mirrorBackoffMs(2)).toBe(10 * 60_000);
    expect(mirrorBackoffMs(3)).toBe(20 * 60_000);
    expect(mirrorBackoffMs(50)).toBe(GIT_MIRROR_BACKOFF_MAX_MS);
  });

  it("maps failures to codes; a rate limit waits for the host's reset; the budget is no failure", () => {
    const now = 1_000_000;
    expect(failureOf(new GitHostError("host_unreachable", "x"), 0, now)).toEqual({
      code: "host_unreachable",
      counts: true,
      nextAt: new Date(now + 5 * 60_000),
    });
    const reset = new Date(now + 60 * 60_000);
    expect(
      failureOf(new GitHostError("rate_limited", "x", { resetAt: reset }), 0, now).nextAt,
    ).toEqual(reset);
    expect(failureOf(new GitHostError("auth_failed", "x"), 2, now)).toMatchObject({
      code: "credential_rejected",
      nextAt: new Date(now + 20 * 60_000),
    });
    expect(failureOf(new GitHostError("forbidden", "x"), 0).code).toBe("credential_forbidden");
    expect(failureOf(new GitHostError("host_refused", "x"), 0).code).toBe("host_not_allowed");
    expect(failureOf(new MirrorError("too_many_files"), 0).code).toBe("too_many_files");
    expect(failureOf(new MirrorHeld(), 0).code).toBe("legal_hold");
    expect(failureOf(new Error("boom"), 0).code).toBe("internal_error");
  });

  it("has a message for every failure and maps unknown codes to internal_error", () => {
    for (const code of GIT_MIRROR_FAILURES) expect(MIRROR_FAILURE_MESSAGES[code]).toBeTruthy();
    expect(failureView(null)).toBeNull();
    expect(failureView("whatever")?.code).toBe("internal_error");
  });
});

describe("read-only reasons (ac-3)", () => {
  it("follows the host state and the connection", () => {
    expect(readOnlyReason("active", "c")).toBeNull();
    expect(readOnlyReason("archived", "c")).toBe("archived");
    expect(readOnlyReason("deleted", "c")).toBe("deleted");
    expect(readOnlyReason("unreachable", "c")).toBe("connection_removed");
    expect(readOnlyReason("active", null)).toBe("connection_removed");
  });

  it("the protocol's host states repeat the table's", () => {
    expect([...GIT_REPO_HOST_STATES]).toEqual([...GIT_REPOSITORY_HOST_STATE_VALUES]);
  });
});

describe("pack header sizes", () => {
  it("reads a whole object's size, multi-byte too", () => {
    // type 3 (blob), size 300 = 0b1_0010_1100: low 4 bits 1100, then 10010.
    expect(objectSize(Buffer.from([0x80 | (3 << 4) | 0x0c, 0x12]))).toBe(300);
    expect(objectSize(Buffer.from([(3 << 4) | 5]))).toBe(5);
  });

  it("reads a delta's target size from the start of its data", () => {
    // Delta header: source size 10, target size 1000 (0xe8 0x07), then instructions.
    const delta = deflateSync(Buffer.from([10, 0xe8, 0x07, 0x90, 1]));
    const ref = Buffer.concat([Buffer.from([(7 << 4) | 5]), Buffer.alloc(20), delta]);
    expect(objectSize(ref)).toBe(1000);
    const ofs = Buffer.concat([Buffer.from([(6 << 4) | 5, 0x81, 0x01]), delta]);
    expect(objectSize(ofs)).toBe(1000);
  });

  it("reads small and large offsets of a version-2 index and refuses others", () => {
    const count = 2;
    const idx = Buffer.alloc(8 + 256 * 4 + count * (20 + 4 + 4) + 8);
    idx.writeUInt32BE(0xff744f63, 0);
    idx.writeUInt32BE(2, 4);
    for (let i = 0; i < 256; i += 1) idx.writeUInt32BE(count, 8 + i * 4);
    const offsets = 8 + 256 * 4 + count * 24;
    idx.writeUInt32BE(12, offsets);
    idx.writeUInt32BE(0x80000000, offsets + 4);
    idx.writeBigUInt64BE(BigInt(2 ** 33), offsets + 8);
    expect(idxOffsets(idx)).toEqual([12, 2 ** 33]);
    expect(() => idxOffsets(Buffer.alloc(16))).toThrow();
  });
});
