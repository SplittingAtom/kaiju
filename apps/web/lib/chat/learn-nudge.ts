/**
 * The Learn nudge (KOBE-410): the server names a crossing (`nudge.key`, the last pass it counts
 * from and the reason); the + button's dot pulses once per crossing per thread. Only a thread's
 * owner reads its Learn state, so the thread id stands for the person. Remembered in this
 * browser's storage (a reload does not pulse again), or in memory when storage is blocked.
 */

export const LEARN_NUDGE_KEY = "kobe.learn-nudge.v1";

const claimed = new Map<string, string>();

/** True the first time `key` is seen for `threadId` (and records it), false after. */
export function claimNudge(threadId: string, key: string): boolean {
  const name = `${LEARN_NUDGE_KEY}:${threadId}`;
  try {
    if (localStorage.getItem(name) === key) return false;
    localStorage.setItem(name, key);
    return true;
  } catch {
    // Storage blocked: remembered for this page only.
    if (claimed.get(threadId) === key) return false;
    claimed.set(threadId, key);
    return true;
  }
}
