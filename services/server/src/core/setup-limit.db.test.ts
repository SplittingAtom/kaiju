import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPERATION_LIMITS, UNKNOWN_CLIENT } from "../operation-limits.js";
import { openHarness, type Harness } from "../testing/harness.js";
import { clearLimit, expectRateLimited, fillLimit } from "../testing/operation-limits.js";

/**
 * KOBE-813 (ac-5): before setup is finished, the setup token can't be guessed at unlimited speed.
 * Attempts are counted per client IP; a request whose IP can't be resolved shares one bucket with
 * every other such request (fails closed). The right token is refused too once over the limit.
 */
const RIGHT = "setup-token-for-harness-tests-01";
const limit = OPERATION_LIMITS.setupAttempt;
let h: Harness;

beforeAll(async () => {
  h = await openHarness();
});
afterAll(async () => {
  await h?.close();
});

/** An X-Forwarded-For that names no address: the client IP can't be resolved. */
const NO_IP = "not-an-address";

const attempt = (setupToken: string, ip: string) =>
  h
    .browser()
    .request(
      "POST",
      "/v1/setup",
      { setupToken, email: "owner@setup.test", name: "Owner", password: "a long enough password" },
      { "x-forwarded-for": ip },
    );

describe("POST /v1/setup attempts", () => {
  it("allows 10 per IP in 10 minutes, then refuses even the right token", async () => {
    const ip = "198.51.100.31";
    for (let i = 0; i < limit.max; i += 1) {
      const res = await attempt("wrong-token", ip);
      expect(res.status, JSON.stringify(res.json)).toBe(403);
    }
    expectRateLimited(await attempt("wrong-token", ip), limit);
    expectRateLimited(await attempt(RIGHT, ip), limit);
    // Another address has its own allowance.
    expect((await attempt("wrong-token", "198.51.100.32")).status).toBe(403);
  });

  it("puts requests without a resolvable IP in one shared bucket", async () => {
    await fillLimit(h.admin, limit, UNKNOWN_CLIENT);
    expectRateLimited(await attempt("wrong-token", NO_IP), limit);
    await clearLimit(h.admin, limit, UNKNOWN_CLIENT);
    expect((await attempt("wrong-token", NO_IP)).status).toBe(403);
  });

  it("lets the right token through within the limit, then answers setup_complete", async () => {
    const res = await attempt(RIGHT, "198.51.100.33");
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    const after = await attempt(RIGHT, "198.51.100.33");
    expect(after.status).toBe(409);
    expect(after.json.code).toBe("setup_complete");
  });
});
