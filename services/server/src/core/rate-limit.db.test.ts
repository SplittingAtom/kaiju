import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimResetLinkSend, releaseResetLinkClaim } from "../auth/reset-links.js";
import { hitRateLimit, pruneExpiredRateLimits } from "../rate-limit.js";
import { openHarness, type Harness } from "../testing/harness.js";

// KOBE-809: Better Auth prunes its own `rate_limits` table of every row older than its longest
// window (60 s), whatever the key, whenever one of its keys starts a new window. Kobe's longer
// limits and the reset-email resend guard must not live where that prune reaches.
let h: Harness;
let tess = "";

const TEN_MINUTES = 10 * 60_000;
const TWO_MINUTES = 2 * 60_000;
const IP = { "x-forwarded-for": "198.51.100.209" };
/** A Better Auth row that the library's prune deletes: it proves the prune ran. */
const SENTINEL = "kobe-809-sentinel-old-library-row";

beforeAll(async () => {
  h = await openHarness();
  tess = await h.createUser("tess@limits.test");
});

afterAll(async () => {
  await h?.close();
});

/**
 * Makes Better Auth start a new window for one of its own keys, which runs its prune
 * (`deleteExpiredRows`), and waits until the prune has gone through.
 */
async function runLibraryPrune(): Promise<void> {
  const reset = () =>
    h.browser().request("POST", "/api/auth/request-password-reset", { email: "x@limits.test" }, IP);
  expect((await reset()).status).toBe(200);
  // That key's window is over (as if its request came two minutes ago), and an old library row
  // sits beside it.
  await h.admin.query(
    `UPDATE rate_limits SET last_request = last_request - $1::bigint WHERE key NOT LIKE 'kobe:%'`,
    [TWO_MINUTES],
  );
  await h.admin.query(`INSERT INTO rate_limits (key, count, last_request) VALUES ($1, 1, $2)`, [
    SENTINEL,
    Date.now() - TWO_MINUTES,
  ]);
  expect((await reset()).status).toBe(200);
  await expect
    .poll(async () => {
      const { rows } = await h.admin.query(`SELECT 1 FROM rate_limits WHERE key = $1`, [SENTINEL]);
      return rows.length;
    })
    .toBe(0);
}

describe("Kobe's rate limits survive the auth library's prune (KOBE-809)", () => {
  it("keeps a 10-minute limit and a pending reset link's resend guard", async () => {
    const db = h.deps.database.db;
    const started = Date.now() - TWO_MINUTES;
    const rule = { windowMs: TEN_MINUTES, max: 1 };
    expect(await hitRateLimit(db, "kobe-809:ten-minutes", rule, started)).toBe(true);

    // A reset link mailed two minutes ago through the real flow, its claim dated accordingly.
    expect(
      (await h.browser().post("/api/auth/request-password-reset", { email: "tess@limits.test" }))
        .status,
    ).toBe(200);
    await h.mailer.settle();
    const token = h.mailer.lastToken("tess@limits.test");
    await releaseResetLinkClaim(db, tess, token);
    expect(await claimResetLinkSend(db, tess, token, started)).toBe(true);

    await runLibraryPrune();

    // Still inside the 10-minute window: the second hit is over the limit.
    expect.soft(await hitRateLimit(db, "kobe-809:ten-minutes", rule)).toBe(false);
    // Still inside the 5-minute resend window: no second email.
    expect.soft(await claimResetLinkSend(db, tess, token)).toBe(false);
  });
});

describe("Kobe's own prune of expired rate-limit rows (KOBE-809)", () => {
  const keysLike = async (prefix: string) =>
    (
      await h.admin.query<{ key: string }>(
        `SELECT key FROM kobe_rate_limits WHERE key LIKE $1 ORDER BY key`,
        [`${prefix}%`],
      )
    ).rows.map((r) => r.key);

  it("deletes expired windows, in bounded batches, when a hit starts a new window", async () => {
    const db = h.deps.database.db;
    const now = Date.now();
    const hour = { windowMs: 60 * 60_000, max: 5 };
    // One window still running, then three that ended (written directly: a hit's own prune runs
    // on the database clock and would take them at once).
    await hitRateLimit(db, "prune:live", hour, now - TWO_MINUTES);
    for (const k of ["a", "b", "c"]) {
      await h.admin.query(
        `INSERT INTO kobe_rate_limits (key, count, window_start, expires_at) VALUES ($1, 1, $2, $3)`,
        [`kobe:prune:old:${k}`, now - TWO_MINUTES, now - TWO_MINUTES + 60_000],
      );
    }
    expect(await keysLike("kobe:prune:old:")).toHaveLength(3);

    // A hit inside a running window prunes nothing.
    await hitRateLimit(db, "prune:live", hour, now);
    expect(await keysLike("kobe:prune:old:")).toHaveLength(3);

    // A new window prunes, at most the batch per call.
    expect(await pruneExpiredRateLimits(db, now, 2)).toBe(2);
    await hitRateLimit(db, "prune:fresh", hour, now);
    expect(await keysLike("kobe:prune:old:")).toEqual([]);
    expect(await keysLike("kobe:prune:live")).toEqual(["kobe:prune:live"]);
    expect(await keysLike("kobe:prune:fresh")).toEqual(["kobe:prune:fresh"]);
  });

  it("also deletes reset-email claims past the resend window", async () => {
    const db = h.deps.database.db;
    await h.admin.query(
      `INSERT INTO kobe_rate_limits (key, count, window_start, expires_at) VALUES ($1, 1, $2, $3)`,
      [`kobe:reset-sent:${tess}:old-claim`, Date.now() - TEN_MINUTES, Date.now() - TWO_MINUTES],
    );
    await hitRateLimit(db, "prune:another-fresh", { windowMs: 60_000, max: 5 });
    expect(await keysLike(`kobe:reset-sent:${tess}:old-claim`)).toEqual([]);
  });
});
