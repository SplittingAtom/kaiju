import { expect } from "vitest";
import type { OperationLimit } from "../operation-limits.js";
import type { TestResponse } from "./browser.js";

interface Queryable {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

/**
 * Fills `subject`'s bucket of `limit` to its maximum in a window that starts now (superuser
 * connection), so the next hit is refused without sending `max` real requests (KOBE-813).
 */
export async function fillLimit(
  admin: Queryable,
  limit: OperationLimit,
  subject: string,
  now = Date.now(),
): Promise<void> {
  await admin.query(
    `INSERT INTO kobe_rate_limits (key, count, window_start, expires_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (key) DO UPDATE SET count = EXCLUDED.count, window_start = EXCLUDED.window_start,
       expires_at = EXCLUDED.expires_at`,
    [`kobe:${limit.bucket}:${subject}`, limit.max, now, now + limit.windowMs],
  );
}

/** Empties `subject`'s bucket of `limit`. */
export async function clearLimit(
  admin: Queryable,
  limit: OperationLimit,
  subject: string,
): Promise<void> {
  await admin.query(`DELETE FROM kobe_rate_limits WHERE key = $1`, [
    `kobe:${limit.bucket}:${subject}`,
  ]);
}

/** The standard refusal: 429 `rate_limited`, the limit's sentence and a `Retry-After` in seconds. */
export function expectRateLimited(res: TestResponse, limit: OperationLimit): void {
  expect(res.status, JSON.stringify(res.json)).toBe(429);
  expect(res.json).toEqual({ code: "rate_limited", message: limit.message });
  const retry = Number(res.headers.get("retry-after"));
  expect(retry).toBeGreaterThanOrEqual(1);
  expect(retry).toBeLessThanOrEqual(Math.ceil(limit.windowMs / 1000));
}
