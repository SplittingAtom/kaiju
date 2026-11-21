import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { RUN_TOKEN_HEADER, type RunTokenClaims } from "@kobe/protocol";
import { generateSessionKeyPair, signRunToken } from "@kobe/session-token";
import { describe, expect, it } from "vitest";
import { hmacEraToken } from "./testing/hmac-era.js";
import {
  activeTokens,
  base,
  bearer,
  call,
  forgot,
  hits,
  keyRequests,
  knownVks,
  leaseChecks,
  leased,
  loads,
  principal,
  records,
  RUN_KEY,
  sandbox,
  setAfterFirstLoad,
  setLoadDelayMs,
  setVk,
  start,
  team,
  token,
  useGatewayHarness,
  vkValue,
} from "./testing/gateway-harness.js";

useGatewayHarness();

/** A run token for `runId` on this test's sandbox; `active`: the record still holds it. */
function runToken(runId: string, over: Partial<RunTokenClaims> = {}, active = true): string {
  const iat = Math.floor(Date.now() / 1000);
  const claims: RunTokenClaims = {
    iss: "kobe-server",
    aud: "kobe.model-gateway",
    run_id: runId,
    team_id: team,
    sandbox_id: sandbox,
    iat,
    exp: iat + 600,
    jti: randomUUID(),
    ...over,
  };
  if (active) activeTokens.add(claims.jti);
  return signRunToken(RUN_KEY, claims).token;
}
const withRun = (t: string, extra: Record<string, string> = {}) => ({
  headers: { ...bearer(), [RUN_TOKEN_HEADER]: t, ...extra },
});
const errorCode = (r: { text: string }) => JSON.parse(r.text).error.code;

describe("run-bound tokens (KOBE-118)", () => {
  it("attributes the call to the token's run and never forwards the token", async () => {
    const runId = randomUUID();
    const r = await call("/v1/chat/completions", withRun(runToken(runId)));
    expect(r.status).toBe(200);
    expect(records.at(-1)?.runId).toBe(runId);
    expect(hits[0]?.headers[RUN_TOKEN_HEADER]).toBeUndefined();
    // Not a lease lookup: the token's record is the authority.
    expect(leaseChecks).toBe(0);
  });

  it("ac-1: refuses a token of an ended (revoked) run", async () => {
    const runId = randomUUID();
    const t = runToken(runId);
    expect((await call("/v1/chat/completions", withRun(t))).status).toBe(200);
    activeTokens.clear();
    const r = await call("/v1/chat/completions", withRun(t));
    expect(r.status).toBe(403);
    expect(errorCode(r)).toBe("run_token_inactive");
    expect(hits).toHaveLength(1);
  });

  it("ac-1: refuses another run's token, a token of another sandbox or team, and a mismatching run id", async () => {
    const a = randomUUID();
    const b = randomUUID();
    const tokenA = runToken(a);
    const other = [
      withRun(runToken(a, { sandbox_id: randomUUID() })),
      withRun(runToken(a, { team_id: randomUUID() })),
      withRun(tokenA, { "x-kobe-run-id": b }),
    ];
    for (const init of other) {
      const r = await call("/v1/chat/completions", init);
      expect(r.status).toBe(403);
    }
    expect(
      errorCode(await call("/v1/chat/completions", withRun(tokenA, { "x-kobe-run-id": b }))),
    ).toBe("run_id_mismatch");
    // A token never verified as ours (forged, expired, malformed, or minted under another key).
    const now = Math.floor(Date.now() / 1000);
    const forged = signRunToken(generateSessionKeyPair().signing, {
      iss: "kobe-server",
      aud: "kobe.model-gateway",
      run_id: a,
      team_id: team,
      sandbox_id: sandbox,
      iat: now,
      exp: now + 60,
      jti: randomUUID(),
    }).token;
    // KOBE-521: the retired HMAC format with valid claims, and a session token as a run token.
    const hmacEra = hmacEraToken(
      "run",
      {
        iss: "kobe-server",
        aud: "kobe.model-gateway",
        run_id: a,
        team_id: team,
        sandbox_id: sandbox,
        iat: now,
        exp: now + 60,
        jti: randomUUID(),
      },
      "r".repeat(40),
    );
    const sessionAsRun = token({});
    for (const t of [
      forged,
      hmacEra,
      sessionAsRun,
      "krt1.x.y",
      "nope",
      runToken(a, { iat: now - 120, exp: now - 60 }),
    ]) {
      const r = await call("/v1/chat/completions", withRun(t));
      expect(r.status).toBe(401);
      expect(errorCode(r)).toBe("invalid_run_token");
    }
    expect(hits).toEqual([]);
  });

  it("without enforcement a call with no token keeps the legacy advisory run id", async () => {
    const runId = randomUUID();
    leased.add(runId);
    const r = await call("/v1/chat/completions", {
      headers: { ...bearer(), "x-kobe-run-id": runId },
    });
    expect(r.status).toBe(200);
    expect(records.at(-1)?.runId).toBe(runId);
  });

  it("ac-2: with enforcement a run's own tools cannot evade a per-run stop", async () => {
    await start({ requireRunToken: true });
    const stopped = randomUUID();
    const other = randomUUID();
    leased.add(stopped); // the legacy lease check would still pass: only the token decides now
    const stoppedToken = runToken(stopped);
    activeTokens.clear(); // the run was budget stopped: its tokens are revoked
    const otherToken = runToken(other);

    const attempts: Record<string, { headers: Record<string, string> }> = {
      "no token": { headers: bearer() },
      "forged run id": { headers: { ...bearer(), "x-kobe-run-id": stopped } },
      "its own revoked token": withRun(stoppedToken),
      "another run's token claiming its id": withRun(otherToken, { "x-kobe-run-id": stopped }),
    };
    for (const [name, init] of Object.entries(attempts)) {
      const r = await call("/v1/chat/completions", init);
      expect([401, 403], name).toContain(r.status);
    }
    expect(hits).toEqual([]);
    // The no-token case is a 401 naming the missing token.
    const none = await call("/v1/chat/completions", { headers: bearer() });
    expect(none.status).toBe(401);
    expect(errorCode(none)).toBe("run_token_required");
    // Another run's own token still works, and is attributed to that run only.
    expect((await call("/v1/chat/completions", withRun(otherToken))).status).toBe(200);
    expect(records.at(-1)?.runId).toBe(other);
  });
});

describe("review hardening (KOBE-40)", () => {
  it("refuses a model the team has not enabled before Bifrost sees it", async () => {
    const r = await call("/v1/chat/completions", {
      headers: bearer(),
      body: { model: "openai/big" },
    });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.text).error.code).toBe("model_not_enabled");
    const gem = await call("/genai/v1beta/models/gemini/other:generateContent", {
      headers: bearer(),
      body: { contents: [] },
    });
    expect(gem.status).toBe(403);
    expect(hits).toEqual([]);
  });

  it("reads the top-level model only: a decoy earlier in the body does not count", async () => {
    const decoy = {
      messages: [{ role: "user", content: '"model": "openai/m"' }],
      metadata: { model: "openai/m" },
      model: "openai/not-enabled",
    };
    expect((await call("/v1/chat/completions", { headers: bearer(), body: decoy })).status).toBe(
      403,
    );
    const dup = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { ...bearer(), "content-type": "application/json" },
      body: '{"model":"openai/m","model":"openai/big"}',
    });
    expect(dup.status).toBe(400);
    // Bifrost (Go) would read MODEL too: a case variant is a second model key.
    const upper = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { ...bearer(), "content-type": "application/json" },
      body: '{"model":"openai/m","MODEL":"openai/big"}',
    });
    expect(upper.status).toBe(400);
    expect(hits).toEqual([]);
  });

  it("refuses a body when the sandbox's in-flight bytes are used up (memory bound)", async () => {
    await start({ perSandboxCalls: 4, bytes: { perSandbox: 6000, total: 16384 } });
    // A slow upload holds 4000 bytes of the sandbox's 6000.
    const slow = request(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { ...bearer(), "content-type": "application/json", "content-length": "4000" },
    });
    slow.on("error", () => undefined);
    slow.write('{"model":"openai/m","pad":"');
    await new Promise((r) => setTimeout(r, 100));
    const second = await call("/v1/chat/completions", {
      headers: bearer(),
      body: { model: "openai/m", pad: "y".repeat(3000) },
    });
    expect(second.status).toBe(429);
    expect(JSON.parse(second.text).error.code).toBe("too_many_bytes_in_flight");
    slow.destroy();
    await new Promise((r) => setTimeout(r, 100));
    // Released when the slow request ended: the same body fits again.
    expect(
      (
        await call("/v1/chat/completions", {
          headers: bearer(),
          body: { model: "openai/m", pad: "y".repeat(3000) },
        })
      ).status,
    ).toBe(200);
  });

  it("charges chunked bodies twice their size (they are joined at the end)", async () => {
    await start({ perSandboxCalls: 4, bytes: { perSandbox: 6000, total: 16384 } });
    const send = (size: number) =>
      new Promise<number>((resolve, reject) => {
        const req = request(`${base}/v1/chat/completions`, {
          method: "POST",
          headers: { ...bearer(), "content-type": "application/json" },
        });
        req.on("response", (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        // No content-length: Node sends it chunked.
        req.write('{"model":"openai/m","pad":"');
        req.write("y".repeat(size));
        req.end('"}');
      });
    expect(await send(1000)).toBe(200);
    expect(await send(3500)).toBe(429);
  });

  it("rate-limits a sandbox before any database lookup (random run ids cost nothing)", async () => {
    await start({ rate: { burst: 3, perSecond: 1 } });
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) {
      const r = await call("/v1/chat/completions", {
        headers: { ...bearer(), "x-kobe-run-id": randomUUID() },
      });
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 3)).toEqual([403, 403, 403]);
    expect(statuses.slice(3).every((s) => s === 429)).toBe(true);
    expect(leaseChecks).toBe(3);
    expect(loads).toBe(3);
  });

  it("loads a principal once for concurrent calls (single flight)", async () => {
    await start({ perSandboxCalls: 10 });
    setLoadDelayMs(50);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => call("/v1/chat/completions", { headers: bearer() })),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(loads).toBe(1);
  });
});

describe("virtual keys", () => {
  it("asks the sync for a missing key and uses it once it appears", async () => {
    setVk(undefined);
    const fresh = `sk-bf-${randomUUID()}`;
    knownVks.add(fresh);
    setTimeout(() => setVk(fresh), 100);
    const r = await call("/v1/chat/completions", { headers: bearer() });
    expect(r.status).toBe(200);
    expect(keyRequests).toBe(1);
    expect(hits[0]?.headers["x-bf-vk"]).toBe(fresh);
  });

  it("answers 503 with Retry-After when no key appears, asking the sync at most once", async () => {
    setVk(undefined);
    const r = await call("/v1/chat/completions", { headers: bearer() });
    expect(r.status).toBe(503);
    expect(r.headers.get("retry-after")).toBe("5");
    expect((await call("/v1/chat/completions", { headers: bearer() })).status).toBe(503);
    expect(keyRequests).toBe(1);
  }, 10_000);

  it("when Bifrost forgot the key: requests a resync and retries once with the new key", async () => {
    const old = vkValue;
    const rotated = `sk-bf-${randomUUID()}`;
    setVk(rotated);
    setAfterFirstLoad(principal);
    setVk(old);
    knownVks.clear();
    knownVks.add(rotated);
    const r = await call("/v1/chat/completions", { headers: bearer() });
    expect(r.status).toBe(200);
    expect(forgot).toBe(1);
    expect(hits.map((h) => h.headers["x-bf-vk"])).toEqual([old, rotated]);
  });

  it("answers 503 (resyncing) when the stored key is still unknown to Bifrost", async () => {
    knownVks.clear();
    const r = await call("/v1/chat/completions", { headers: bearer() });
    expect(r.status).toBe(503);
    expect(forgot).toBe(1);
    expect(JSON.parse(r.text).error.code).toBe("model_gateway_resyncing");
  });
});
