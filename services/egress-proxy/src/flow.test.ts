import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_BUFFERED_BYTES, holdUntilReady, overBuffered } from "./flow.js";

/** KOBE-763 review M2: a source resumes only when its destination drained AND the throttle allows. */
class Source {
  paused = false;
  destroyed = false;
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
  }
}
class Destination extends EventEmitter {
  writableLength = 0;
}

afterEach(() => vi.useRealTimers());

describe("holdUntilReady", () => {
  it("does nothing when the write flushed and no delay is due", () => {
    const src = new Source();
    holdUntilReady(src, new Destination(), true, 0, new Set());
    expect(src.paused).toBe(false);
  });

  it("waits for the drain even after the throttle delay has passed", () => {
    vi.useFakeTimers();
    const src = new Source();
    const dst = new Destination();
    const timers = new Set<NodeJS.Timeout>();
    holdUntilReady(src, dst, false, 10, timers);
    expect(src.paused).toBe(true);
    vi.advanceTimersByTime(50);
    expect(src.paused).toBe(true);
    dst.emit("drain");
    expect(src.paused).toBe(false);
    expect(timers.size).toBe(0);
  });

  it("waits for the throttle delay even after the drain", () => {
    vi.useFakeTimers();
    const src = new Source();
    const dst = new Destination();
    holdUntilReady(src, dst, false, 10, new Set());
    dst.emit("drain");
    expect(src.paused).toBe(true);
    vi.advanceTimersByTime(10);
    expect(src.paused).toBe(false);
  });

  it("never resumes a destroyed source; the backstop reports an over-full destination", () => {
    const src = new Source();
    const dst = new Destination();
    holdUntilReady(src, dst, false, 0, new Set());
    src.destroyed = true;
    dst.emit("drain");
    expect(src.paused).toBe(true);
    dst.writableLength = MAX_BUFFERED_BYTES + 1;
    expect(overBuffered(dst)).toBe(true);
    dst.writableLength = 1024;
    expect(overBuffered(dst)).toBe(false);
  });
});
