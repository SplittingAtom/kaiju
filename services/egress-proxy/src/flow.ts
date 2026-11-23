/**
 * Back-pressure for the proxy's HTTP relays (KOBE-763 review M2), as tunnel.ts does it: after a
 * chunk is forwarded, the source stays paused until BOTH the destination has drained (when its
 * write returned false) AND the bandwidth throttle's delay has passed. A throttle timer alone
 * must never resume a source whose destination is still backed up (that buffered without bound).
 *
 * The backstop: a destination holding more than `maxBufferedBytes` unsent is cut by the caller.
 */
export interface FlowSource {
  pause(): void;
  resume(): void;
  readonly destroyed?: boolean;
}

export interface FlowDestination {
  once(event: "drain", listener: () => void): unknown;
  readonly writableLength: number;
}

/** Most bytes one relay direction may hold unsent before it is cut (the destination never reads). */
export const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

/**
 * Call after `dst.write(chunk)` with its result and the throttle delay (ms). Pauses `src` until
 * both conditions hold; `timers` collects the throttle timers so the caller can clear them.
 */
export function holdUntilReady(
  src: FlowSource,
  dst: FlowDestination,
  flushed: boolean,
  delayMs: number,
  timers: Set<NodeJS.Timeout>,
): void {
  if (flushed && delayMs <= 0) return;
  src.pause();
  let waiting = (flushed ? 0 : 1) + (delayMs > 0 ? 1 : 0);
  const done = () => {
    waiting -= 1;
    if (waiting === 0 && src.destroyed !== true) src.resume();
  };
  if (!flushed) dst.once("drain", done);
  if (delayMs > 0) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      done();
    }, delayMs);
    timers.add(timer);
  }
}

/** True when the destination holds more unsent bytes than the backstop allows. */
export function overBuffered(dst: FlowDestination, max = MAX_BUFFERED_BYTES): boolean {
  return dst.writableLength > max;
}
