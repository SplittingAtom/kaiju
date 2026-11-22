import { bigint, index, integer, pgTable, text } from "drizzle-orm/pg-core";

/**
 * Kobe's own Postgres rate-limit counters and the password-reset resend claims (KOBE-809), shared
 * by every server replica. Site-level, no team. Kept apart from Better Auth's `rate_limits`: the
 * library prunes that table of every row older than its own longest window (60 s), whatever the
 * key, so Kobe's longer windows would end after about a minute. Times are epoch milliseconds;
 * `expires_at` (window start plus the window) is what Kobe's own prune deletes by.
 */
export const kobeRateLimits = pgTable(
  "kobe_rate_limits",
  {
    key: text().primaryKey(),
    count: integer().notNull(),
    windowStart: bigint({ mode: "number" }).notNull(),
    expiresAt: bigint({ mode: "number" }).notNull(),
  },
  (t) => [index("kobe_rate_limits_expires_at_idx").on(t.expiresAt)],
);
