import { KeyObject } from "node:crypto";
import { SERVER_CALL_AUDIENCE, type RunTokenClaims, type ServerCallClaims } from "@kaiju/protocol";
import {
  generateSessionKeyPair,
  signRunToken,
  signServerCallToken,
  verifyRunToken,
  verifyServerCallToken,
} from "@kaiju/session-token";
import { toLegacyEnv } from "@kaiju/protocol/testing";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import { hmacEraToken } from "./testing/hmac-era.js";

const PAIR = generateSessionKeyPair();
const env = {
  KAIJU_DATABASE_URL: "postgres://app@db/kobe",
  KAIJU_TRACE_SPAN_KEY: "t".repeat(40),
  KAIJU_SESSION_VERIFY_KEY_MODEL_GATEWAY: PAIR.publicPem,
  KAIJU_MODELS_VIRTUAL_KEY_SECRET: "v".repeat(40),
  KAIJU_BIFROST_URL: "http://kobe-bifrost:8080/",
};

describe("loadConfig", () => {
  it("reads the query pool size (KOBE-736): default 10, 1..200", () => {
    expect(loadConfig(env).dbPoolMax).toBe(10);
    expect(loadConfig({ ...env, KAIJU_DB_POOL_MAX: "25" }).dbPoolMax).toBe(25);
    // The member rate limiter's own pool (KOBE-810).
    expect(loadConfig(env).ratePoolMax).toBe(2);
    expect(loadConfig({ ...env, KAIJU_MODEL_GATEWAY_RATE_POOL_MAX: "4" }).ratePoolMax).toBe(4);
    expect(() => loadConfig({ ...env, KAIJU_MODEL_GATEWAY_RATE_POOL_MAX: "0" })).toThrow();
    expect(() => loadConfig({ ...env, KAIJU_DB_POOL_MAX: "201" })).toThrow(/KAIJU_DB_POOL_MAX/);
  });

  it("reads the chart's env with defaults", () => {
    expect(loadConfig(env)).toMatchObject({
      port: 8080,
      bifrostUrl: "http://kobe-bifrost:8080",
      maxBodyBytes: 8 * 1024 * 1024,
      inflightBytes: 128 * 1024 * 1024,
      inflightBytesPerSandbox: 32 * 1024 * 1024,
      rateBurst: 60,
      ratePerSecond: 10,
      maxCallsPerSandbox: 16,
      cacheTtlMs: 5_000,
    });
  });

  it("run token enforcement is off by default and switched by KAIJU_MODEL_GATEWAY_REQUIRE_RUN_TOKEN", () => {
    expect(loadConfig(env).requireRunToken).toBe(false);
    expect(
      loadConfig({ ...env, KAIJU_MODEL_GATEWAY_REQUIRE_RUN_TOKEN: "true" }).requireRunToken,
    ).toBe(true);
    expect(() => loadConfig({ ...env, KAIJU_MODEL_GATEWAY_REQUIRE_RUN_TOKEN: "yes" })).toThrow(
      /REQUIRE_RUN_TOKEN/,
    );
  });

  it("fails fast on a missing or weak key without echoing it", () => {
    expect(() => loadConfig({ ...env, KAIJU_TRACE_SPAN_KEY: undefined })).toThrow(
      /KAIJU_TRACE_SPAN_KEY is required/,
    );
    expect(() => loadConfig({ ...env, KAIJU_TRACE_SPAN_KEY: "short" })).toThrow(/at least 32/);
    // Session tokens: public key(s) only (KOBE-513); a private key is refused.
    expect(() => loadConfig({ ...env, KAIJU_SESSION_VERIFY_KEY_MODEL_GATEWAY: undefined })).toThrow(
      /KAIJU_SESSION_VERIFY_KEY_MODEL_GATEWAY is required/,
    );
    expect(() =>
      loadConfig({ ...env, KAIJU_SESSION_VERIFY_KEY_MODEL_GATEWAY: PAIR.privatePem }),
    ).toThrow(/public keys only/);
    expect(loadConfig(env).sessionVerifyKeys.has(PAIR.signing.kid)).toBe(true);
    const weak = { ...env, KAIJU_MODELS_VIRTUAL_KEY_SECRET: "weak-secret-value" };
    expect(() => loadConfig(weak)).toThrow(/at least 32/);
    expect(() => loadConfig(weak)).not.toThrow(/weak-secret-value/);
    expect(() => loadConfig({ ...env, KAIJU_BIFROST_URL: "ftp://x" })).toThrow(/KAIJU_BIFROST_URL/);
    expect(() =>
      loadConfig({ ...env, KAIJU_MODEL_GATEWAY_INFLIGHT_BYTES_PER_SANDBOX: "1048576" }),
    ).toThrow(/max body/);
  });
});

describe("KOBE-521 ac-1: the gateway holds no secret that can mint a credential", () => {
  const NOW = 1_800_000_000;
  const ids = {
    team: "0b5e8f1c-2d3a-4b5c-8d9e-0f1a2b3c4d5e",
    user: "2d7a0b3e-4f5c-4d7e-8fa0-2b3c4d5e6f70",
    sandbox: "4f9c2d5a-6b7e-4f90-8bc2-4d5e6f708192",
    run: "6a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d",
  };
  const runClaims: RunTokenClaims = {
    iss: "kobe-server",
    aud: "kobe.model-gateway",
    run_id: ids.run,
    team_id: ids.team,
    sandbox_id: ids.sandbox,
    iat: NOW,
    exp: NOW + 900,
    jti: "jti-0123456789abcdef",
  };
  const scClaims: ServerCallClaims = {
    iss: "kobe-server",
    aud: SERVER_CALL_AUDIENCE,
    purpose: "title",
    team_id: ids.team,
    user_id: ids.user,
    thread_id: ids.sandbox,
    run_id: ids.run,
    model: "openai/m",
    max_output_tokens: 48,
    iat: NOW,
    exp: NOW + 30,
    jti: "jti-0123456789abcdef",
  };

  it("refuses the retired master secret and any signing key in its env", () => {
    for (const extra of [
      { KAIJU_SESSION_KEY_MODEL_GATEWAY: "m".repeat(40) },
      { KAIJU_SESSION_SIGNING_KEY_MODEL_GATEWAY: PAIR.privatePem },
      { KAIJU_SESSION_SIGNING_KEY_SANDBOX_WIRE: PAIR.privatePem },
    ]) {
      expect(() => loadConfig({ ...env, ...extra })).toThrow(
        /must not be set on the model gateway/,
      );
      expect(() => loadConfig({ ...env, ...extra })).not.toThrow(/PRIVATE KEY|mmmm/);
    }
  });

  it("its loaded config holds public keys only, and none of its secrets mints a token it accepts", () => {
    const config = loadConfig(env);
    const keys = [...config.sessionVerifyKeys.values()];
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(k.type).toBe("public");
    const values = Object.values(config);
    expect(values.some((v) => v instanceof KeyObject && v.type !== "public")).toBe(false);
    // Every secret string the gateway holds, tried as the old HMAC master secret.
    const secrets = values.filter((v): v is string => typeof v === "string");
    expect(secrets).toContain(env.KAIJU_TRACE_SPAN_KEY);
    for (const secret of secrets) {
      const run = hmacEraToken("run", runClaims, secret);
      const sc = hmacEraToken("server-call", scClaims, secret);
      expect(verifyRunToken(config.sessionVerifyKeys, run, NOW).ok).toBe(false);
      expect(verifyServerCallToken(config.sessionVerifyKeys, sc, NOW).ok).toBe(false);
    }
    // Only the server's private key signs what the gateway accepts; any other key is refused.
    const server = PAIR.signing;
    expect(
      verifyRunToken(config.sessionVerifyKeys, signRunToken(server, runClaims).token, NOW).ok,
    ).toBe(true);
    const own = generateSessionKeyPair().signing;
    expect(
      verifyRunToken(config.sessionVerifyKeys, signRunToken(own, runClaims).token, NOW).ok,
    ).toBe(false);
    expect(
      verifyServerCallToken(config.sessionVerifyKeys, signServerCallToken(own, scClaims), NOW).ok,
    ).toBe(false);
  });
});

describe("old KOBE_* names for one release (KOBE-748)", () => {
  it("starts with only the old names and warns once, naming them without values", () => {
    const warn = vi.fn();
    const c = loadConfig(toLegacyEnv(env), warn);
    expect(c.bifrostUrl).toBe("http://kobe-bifrost:8080");
    expect(c.databaseUrl).toBe("postgres://app@db/kobe");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toEqual({
      renamed: [
        "KOBE_BIFROST_URL",
        "KOBE_DATABASE_URL",
        "KOBE_MODELS_VIRTUAL_KEY_SECRET",
        "KOBE_SESSION_VERIFY_KEY_MODEL_GATEWAY",
        "KOBE_TRACE_SPAN_KEY",
      ],
      conflicts: [],
    });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain("t".repeat(40));
    expect(logged).not.toContain("v".repeat(40));
  });

  it("the new name wins when both are set, and the warning names the conflict", () => {
    const warn = vi.fn();
    const c = loadConfig({ ...env, KOBE_BIFROST_URL: "http://old-bifrost:8080/" }, warn);
    expect(c.bifrostUrl).toBe("http://kobe-bifrost:8080");
    expect(warn.mock.calls[0]?.[1]).toEqual({ renamed: [], conflicts: ["KOBE_BIFROST_URL"] });
  });

  it("an old minting key name is refused like the new one", () => {
    expect(() =>
      loadConfig({ ...env, KOBE_SESSION_SIGNING_KEY_MODEL_GATEWAY: "x" }, vi.fn()),
    ).toThrow(/KAIJU_SESSION_SIGNING_KEY_MODEL_GATEWAY must not be set/);
  });
});
