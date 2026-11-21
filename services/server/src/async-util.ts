/** The logger part {@link fireAndLog} needs (a pino logger fits). */
export interface WarnLog {
  warn(obj: object, msg?: string): void;
}

/**
 * Runs `work` without waiting for it (KOBE-705, review CODE-27): a failure is logged at warn with
 * the error as `<what> failed`, never swallowed silently and never thrown. Use it for work that
 * matters but may not hold up the caller (a budget evaluation after a change, a mount reconcile);
 * plain resource cleanup (ending a dead client) does not need it.
 */
export function fireAndLog(
  log: WarnLog,
  what: string,
  work: Promise<unknown> | undefined,
  context: Readonly<Record<string, unknown>> = {},
): void {
  if (work === undefined) return;
  work.then(
    () => undefined,
    (err: unknown) => {
      try {
        log.warn({ err, ...context }, `${what} failed`);
      } catch {
        // A failing logger must not turn into an unhandled rejection.
      }
    },
  );
}
