import { describe, expect, it } from "vitest";
import { RACY_WINDOW_NS, racy, sameStamp, type FileStamp } from "./stamps.js";

/** KOBE-733: the stamp rules behind "unchanged" for the reclaim proof. */
describe("file stamps", () => {
  const t = 1_800_000_000_000_000_000n;
  const stamp: FileStamp = { size: 4, mtimeNs: t, ctimeNs: t, ino: 7n };

  it("counts a file unchanged only when every field is exactly equal", () => {
    expect(sameStamp(stamp, { ...stamp })).toBe(true);
    expect(sameStamp(stamp, { ...stamp, ctimeNs: t + 1n })).toBe(false);
    // A rewrite after the clock stepped back: an older ctime is a change too.
    expect(sameStamp(stamp, { ...stamp, ctimeNs: t - 5_000_000_000n })).toBe(false);
    expect(sameStamp(stamp, { ...stamp, ino: 8n })).toBe(false);
    expect(sameStamp(stamp, { ...stamp, size: 5 })).toBe(false);
    expect(sameStamp(stamp, undefined)).toBe(false);
  });

  it("treats a stamp inside the window before hashing started as racily clean", () => {
    expect(racy(stamp, t + RACY_WINDOW_NS + 1n)).toBe(false);
    expect(racy(stamp, t + RACY_WINDOW_NS)).toBe(true);
    // Same tick as the stat (a same-size rewrite right after the hash would keep it equal).
    expect(racy(stamp, t)).toBe(true);
    expect(racy({ ...stamp, mtimeNs: t + RACY_WINDOW_NS }, t + RACY_WINDOW_NS + 1n)).toBe(true);
    // No volume clock: never recorded.
    expect(racy(stamp, undefined)).toBe(true);
  });
});
