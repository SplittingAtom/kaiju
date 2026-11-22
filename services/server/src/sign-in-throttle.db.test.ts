import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClientIpWatch } from "./auth/client-ip-watch.js";
import {
  createSignInThrottle,
  SIGN_IN_THROTTLE,
  signInAccountKey,
  THROTTLED_MESSAGE,
} from "./auth/sign-in-throttle.js";
import { openHarness, PASSWORD, PUBLIC_URL, type Harness } from "./testing/harness.js";
import type { TestBrowser, TestResponse } from "./testing/browser.js";
import { totpFromUri } from "./testing/totp.js";
import { SoftwareAuthenticator } from "./testing/webauthn.js";

/**
 * KOBE-812: failed password and second-factor attempts are counted per account across every
 * client address: 10 in 15 minutes, then one attempt a minute until the window passes (a growing
 * delay, never a lockout); unknown addresses behave exactly like known ones; a successful sign-in
 * or a password reset clears it; the first throttling failure of a window is audited once and
 * shown to Site admins.
 */
let h: Harness;
let siteAdmin: TestBrowser;
let ipSeq = 0;
const WRONG = "definitely not the password";
const { failures, windowMs, intervalMs } = SIGN_IN_THROTTLE;

/** A fresh client address per request: Better Auth's per-address limit (3 per 10 s) stays out. */
const freshIp = () => ({ "x-forwarded-for": `198.18.${Math.floor(ipSeq / 250)}.${ipSeq++ % 250}` });

const signIn = (email: string, password: string, b: TestBrowser = h.browser()) =>
  b.request("POST", "/api/auth/sign-in/email", { email, password }, freshIp());

/** Moves every interval slot a minute back, as if the next allowed attempt were due. */
async function nextMinute(): Promise<void> {
  await h.admin.query(
    `UPDATE kobe_rate_limits SET window_start = window_start - $1::bigint,
       expires_at = expires_at - $1::bigint WHERE key LIKE 'kobe:sign-in-slot:%'`,
    [intervalMs + 1000],
  );
}

/** Turns on TOTP for the account (signed in with the password) and returns its otpauth URI. */
async function enrollTotp(email: string): Promise<string> {
  const b = await h.signIn(email);
  const enable = await b.post("/api/auth/two-factor/enable", { password: PASSWORD });
  const uri: string = enable.json.totpURI;
  const verify = await b.post("/api/auth/two-factor/verify-totp", { code: totpFromUri(uri) });
  expect(verify.status).toBe(200);
  return uri;
}

async function throttledAudits(userId: string): Promise<number> {
  const { rows } = await h.admin.query(
    `SELECT count(*)::int AS n FROM audit_log
     WHERE action = 'auth.sign_in.throttled' AND target->>'userId' = $1`,
    [userId],
  );
  return rows[0].n;
}

/** What a client can observe of an answer (Better Auth's timing-safe paths aside). */
const observable = (r: TestResponse) => ({
  status: r.status,
  json: r.json,
  retry: r.headers.get("x-retry-after") !== null,
});

beforeAll(async () => {
  h = await openHarness();
  await h.createUser("admin@throttle.test", "admin");
  siteAdmin = await h.signIn("admin@throttle.test");
});

afterAll(async () => {
  await h?.close();
});

describe("the counter (ac-1)", () => {
  it("allows 10 failures, then one attempt a minute until the 15-minute window passes", async () => {
    let t = 1_000_000;
    const throttle = createSignInThrottle({ db: h.deps.database.db, now: () => t });
    const account = "unit-counter";
    for (let i = 1; i <= failures; i++) {
      const attempt = await throttle.begin(account);
      expect(attempt.allowed).toBe(true);
      if (attempt.allowed) await throttle.failed(account, attempt);
    }
    t += 1000;
    const refused = await throttle.begin(account);
    expect(refused).toEqual({ allowed: false, retryAfterSeconds: 59 });
    t += intervalMs;
    const slot = await throttle.begin(account);
    expect(slot.allowed).toBe(true);
    if (slot.allowed) await throttle.failed(account, slot);
    expect((await throttle.begin(account)).allowed).toBe(false);
    // The window passed: a fresh start, not a lockout.
    t = 1_000_000 + windowMs + 1;
    expect((await throttle.begin(account)).allowed).toBe(true);
  });

  it("gives the attempt back when it was not a failure", async () => {
    const throttle = createSignInThrottle({ db: h.deps.database.db });
    const account = "unit-refund";
    for (let i = 0; i < failures * 2; i++) {
      const attempt = await throttle.begin(account);
      expect(attempt.allowed).toBe(true);
      if (attempt.allowed) await throttle.refund(account, attempt);
    }
  });

  it("gives the minute's slot back with a refunded attempt (review M2)", async () => {
    let t = 5_000_000;
    const throttle = createSignInThrottle({ db: h.deps.database.db, now: () => t });
    const account = "unit-slot-refund";
    for (let i = 0; i < failures; i++) {
      const a = await throttle.begin(account);
      if (a.allowed) await throttle.failed(account, a);
    }
    t += intervalMs + 1;
    const correct = await throttle.begin(account);
    expect(correct.allowed).toBe(true);
    // Refused tries in between don't keep the slot taken once it is given back.
    expect((await throttle.begin(account)).allowed).toBe(false);
    if (correct.allowed) await throttle.refund(account, correct);
    t += 1000;
    const code = await throttle.begin(account);
    expect(code.allowed).toBe(true);
    expect((await throttle.begin(account)).allowed).toBe(false);
  });

  it("lets only 10 of a parallel burst through, plus one interval attempt", async () => {
    const throttle = createSignInThrottle({ db: h.deps.database.db });
    const verdicts = await Promise.all(
      Array.from({ length: 40 }, () => throttle.begin("unit-burst")),
    );
    expect(verdicts.filter((v) => v.allowed)).toHaveLength(failures + 1);
  });

  it("names counters by a keyed hash of the normalized email, never the address", () => {
    const a = signInAccountKey("k".repeat(48), "Ada@Example.test");
    expect(a).toBe(signInAccountKey("k".repeat(48), "ada@example.test"));
    expect(a).not.toBe(signInAccountKey("j".repeat(48), "ada@example.test"));
    expect(a).not.toContain("ada");
  });
});

describe("password sign-in (ac-1, ac-2)", () => {
  it("throttles one account across addresses, the same for an address with no account", async () => {
    await h.createUser("kim@throttle.test");
    const known: TestResponse[] = [];
    const unknown: TestResponse[] = [];
    for (let i = 0; i <= failures; i++) {
      known.push(await signIn("kim@throttle.test", WRONG));
      unknown.push(await signIn("nobody@throttle.test", WRONG));
    }
    expect(known.slice(0, failures).every((r) => r.status === 401)).toBe(true);
    const last = known[failures];
    expect(last?.status).toBe(429);
    expect(last?.json).toEqual({ message: THROTTLED_MESSAGE });
    expect(Number(last?.headers.get("x-retry-after"))).toBeGreaterThan(50);
    expect(last?.headers.get("retry-after")).toBe(last?.headers.get("x-retry-after"));
    expect(unknown.map(observable)).toEqual(known.map(observable));
    // Other spellings of the address share the counter.
    expect((await signIn("KIM@throttle.test", WRONG)).status).toBe(429);
    // The table holds no address.
    const { rows } = await h.admin.query(`SELECT key FROM kobe_rate_limits`);
    expect(JSON.stringify(rows)).not.toMatch(/kim|nobody/i);
  });

  it("refuses even the right password until the next allowed attempt, which then clears it", async () => {
    const id = await h.createUser("lee@throttle.test");
    for (let i = 0; i < failures; i++) await signIn("lee@throttle.test", WRONG);
    expect((await signIn("lee@throttle.test", PASSWORD)).status).toBe(429);
    await nextMinute();
    expect((await signIn("lee@throttle.test", PASSWORD)).status).toBe(200);
    // Cleared: ten more failures before the next delay.
    for (let i = 0; i < failures; i++) {
      expect((await signIn("lee@throttle.test", WRONG)).status).toBe(401);
    }
    expect((await signIn("lee@throttle.test", WRONG)).status).toBe(429);
    await expect.poll(() => throttledAudits(id)).toBe(2);
  });

  it("gives back a correct password's attempt (deactivated account), so it never adds up", async () => {
    const id = await h.createUser("max@throttle.test");
    for (let i = 0; i < failures - 1; i++) {
      expect((await signIn("max@throttle.test", WRONG)).status).toBe(401);
    }
    expect((await siteAdmin.post(`/v1/site/users/${id}/deactivate`)).status).toBe(200);
    // Right password, refused for the deactivation: refunded every time, never throttled.
    for (let i = 0; i < 5; i++) {
      expect((await signIn("max@throttle.test", PASSWORD)).status).toBe(403);
    }
    // Still one failure to go before the delay.
    expect((await signIn("max@throttle.test", WRONG)).status).toBe(401);
    expect((await signIn("max@throttle.test", WRONG)).status).toBe(429);
  });

  it("is not a password oracle elsewhere: /verify-password is switched off (review M1)", async () => {
    await h.createUser("val@throttle.test");
    const b = await h.signIn("val@throttle.test");
    for (const password of [WRONG, PASSWORD]) {
      const res = await b.request("POST", "/api/auth/verify-password", { password }, freshIp());
      expect(res.status).toBe(404);
    }
    const del = await b.request("POST", "/api/auth/delete-user", { password: WRONG }, freshIp());
    expect(del.status).toBe(404);
  });

  it("is cleared by a password reset", async () => {
    await h.createUser("ria@throttle.test");
    for (let i = 0; i < failures; i++) await signIn("ria@throttle.test", WRONG);
    expect((await signIn("ria@throttle.test", WRONG)).status).toBe(429);
    await h.browser().post("/api/auth/request-password-reset", { email: "ria@throttle.test" });
    await h.mailer.settle();
    const token = h.mailer.lastToken("ria@throttle.test");
    const reset = await h
      .browser()
      .post("/api/auth/reset-password", { token, newPassword: "a brand new password" });
    expect(reset.status, JSON.stringify(reset.json)).toBe(200);
    expect((await signIn("ria@throttle.test", "a brand new password")).status).toBe(200);
  });
});

describe("Site admins see it (ac-3)", () => {
  it("audits the first throttling failure of a window once and lists the account", async () => {
    const id = await h.createUser("ned@throttle.test");
    for (let i = 0; i < failures; i++) await signIn("ned@throttle.test", WRONG);
    for (let i = 0; i < 3; i++) {
      await nextMinute();
      expect((await signIn("ned@throttle.test", WRONG)).status).toBe(401);
    }
    await expect.poll(() => throttledAudits(id)).toBe(1);
    await h.deps.background.idle();
    expect(await throttledAudits(id)).toBe(1);
    const res = await siteAdmin.get("/v1/site/users/sign-in-protection");
    expect(res.status).toBe(200);
    const row = res.json.throttled.find((t: { userId: string }) => t.userId === id);
    expect(Date.parse(row.until)).toBeGreaterThan(Date.now());
    // A successful sign-in takes the account off the list.
    await nextMinute();
    expect((await signIn("ned@throttle.test", PASSWORD)).status).toBe(200);
    const after = await siteAdmin.get("/v1/site/users/sign-in-protection");
    expect(after.json.throttled.map((t: { userId: string }) => t.userId)).not.toContain(id);
  });

  it("records nothing for an address without an account", async () => {
    const before = await h.admin.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'auth.sign_in.throttled'`,
    );
    for (let i = 0; i < failures + 1; i++) await signIn("ghost@throttle.test", WRONG);
    await h.deps.background.idle();
    const after = await h.admin.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'auth.sign_in.throttled'`,
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("is for site.users.manage only", async () => {
    await h.createUser("pia@throttle.test");
    const member = await h.signIn("pia@throttle.test");
    expect((await member.get("/v1/site/users/sign-in-protection")).status).toBe(403);
  });
});

describe("second factor and signed-in password checks (ac-1)", () => {
  it("counts wrong authenticator codes against the account, password failures included", async () => {
    await h.createUser("tom@throttle.test");
    const b = await h.signIn("tom@throttle.test");
    const enable = await b.post("/api/auth/two-factor/enable", { password: PASSWORD });
    const uri: string = enable.json.totpURI;
    expect(
      (await b.post("/api/auth/two-factor/verify-totp", { code: totpFromUri(uri) })).status,
    ).toBe(200);

    const browser = h.browser();
    const challenge = async () => {
      const first = await signIn("tom@throttle.test", PASSWORD, browser);
      expect(first.json).toMatchObject({ twoFactorRedirect: true });
    };
    await challenge();
    let counted = 0;
    while (counted < failures) {
      const res = await browser.request(
        "POST",
        "/api/auth/two-factor/verify-totp",
        { code: "000000" },
        freshIp(),
      );
      if (res.status === 401) counted++;
      else await challenge(); // the challenge ran out of tries: a new one (password step not counted)
    }
    const code = totpFromUri(uri);
    const refused = await browser.request(
      "POST",
      "/api/auth/two-factor/verify-totp",
      { code },
      freshIp(),
    );
    expect(refused.status).toBe(429);
    // Same account: the password step waits too.
    expect((await signIn("tom@throttle.test", PASSWORD)).status).toBe(429);
  });

  it("throttled: the owner's right password then right code signs in within one slot (review M2)", async () => {
    await h.createUser("zoe@throttle.test");
    const uri = await enrollTotp("zoe@throttle.test");
    for (let i = 0; i < failures; i++) {
      expect((await signIn("zoe@throttle.test", WRONG)).status).toBe(401);
    }
    expect((await signIn("zoe@throttle.test", WRONG)).status).toBe(429);
    await nextMinute(); // the attacker leaves the slot alone this minute
    const owner = h.browser();
    const first = await signIn("zoe@throttle.test", PASSWORD, owner);
    expect(first.json).toMatchObject({ twoFactorRedirect: true });
    const code = await owner.request(
      "POST",
      "/api/auth/two-factor/verify-totp",
      { code: totpFromUri(uri) },
      freshIp(),
    );
    expect(code.status, JSON.stringify(code.json)).toBe(200);
    // Signed in: the counter is gone.
    expect((await signIn("zoe@throttle.test", WRONG)).status).toBe(401);
  });

  it("counts wrong backup codes like authenticator codes", async () => {
    await h.createUser("bea@throttle.test");
    await enrollTotp("bea@throttle.test");
    const browser = h.browser();
    const challenge = async () => {
      const first = await signIn("bea@throttle.test", PASSWORD, browser);
      expect(first.json).toMatchObject({ twoFactorRedirect: true });
    };
    await challenge();
    let counted = 0;
    while (counted < failures) {
      const res = await browser.request(
        "POST",
        "/api/auth/two-factor/verify-backup-code",
        { code: "ABCDE-FGHIJ" },
        freshIp(),
      );
      if (res.status === 401) counted++;
      else await challenge();
    }
    const refused = await browser.request(
      "POST",
      "/api/auth/two-factor/verify-backup-code",
      { code: "ABCDE-FGHIJ" },
      freshIp(),
    );
    expect(refused.status).toBe(429);
  });

  it("lets a passkey sign in while throttled, without clearing the counter (review L2)", async () => {
    await h.createUser("pat@throttle.test");
    const b = await h.signIn("pat@throttle.test");
    const key = new SoftwareAuthenticator("kobe.test", PUBLIC_URL);
    const options = await b.get("/api/auth/passkey/generate-register-options");
    const registered = await b.post("/api/auth/passkey/verify-registration", {
      response: key.register(options.json),
      name: "key",
    });
    expect(registered.status, JSON.stringify(registered.json)).toBe(200);
    for (let i = 0; i < failures; i++) await signIn("pat@throttle.test", WRONG);
    expect((await signIn("pat@throttle.test", WRONG)).status).toBe(429);
    const p = h.browser();
    const auth = await p.get("/api/auth/passkey/generate-authenticate-options");
    const signedIn = await p.post("/api/auth/passkey/verify-authentication", {
      response: key.authenticate(auth.json),
    });
    expect(signedIn.status, JSON.stringify(signedIn.json)).toBe(200);
    // A session holder could register a passkey: its sign-in must not reset the guesses.
    expect((await signIn("pat@throttle.test", WRONG)).status).toBe(429);
  });

  it("counts a wrong current password on change-password", async () => {
    await h.createUser("una@throttle.test");
    const b = await h.signIn("una@throttle.test");
    const change = (currentPassword: string) =>
      b.request(
        "POST",
        "/api/auth/change-password",
        { currentPassword, newPassword: "another long password" },
        freshIp(),
      );
    for (let i = 0; i < failures; i++) expect((await change(WRONG)).status).toBe(400);
    expect((await change(PASSWORD)).status).toBe(429);
    expect((await signIn("una@throttle.test", PASSWORD)).status).toBe(429);
  });
});

describe("unknown client addresses (ac-4)", () => {
  it("warns once per source and keeps a shared sighting for the Site console", async () => {
    const warn = vi.fn();
    const watch = createClientIpWatch({
      db: h.deps.database.db,
      log: { warn } as never,
      background: h.deps.background,
    });
    expect(await watch.seen()).toBeNull();
    watch.unknown("sign-in");
    watch.unknown("sign-in");
    await h.deps.background.idle();
    expect(warn).toHaveBeenCalledTimes(1);
    const seen = await watch.seen();
    expect(seen?.since).toBeLessThanOrEqual(Date.now());
    const res = await siteAdmin.get("/v1/site/users/sign-in-protection");
    expect(Date.parse(res.json.unknownClientIp.since)).toBe(seen?.since);
  });
});
