import { generateSessionKeyPair } from "@kaiju/session-token";
import { toLegacyEnv } from "@kaiju/protocol/testing";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";

const PAIR = generateSessionKeyPair();
const base = {
  KAIJU_DATABASE_URL: "postgres://app@db/kobe",
  KAIJU_SESSION_VERIFY_KEY_EGRESS_PROXY: PAIR.publicPem,
};

describe("loadConfig", () => {
  it("reads the query pool size (KOBE-736): default 10, 1..200", () => {
    expect(loadConfig(base).dbPoolMax).toBe(10);
    expect(loadConfig({ ...base, KAIJU_DB_POOL_MAX: "25" }).dbPoolMax).toBe(25);
    expect(() => loadConfig({ ...base, KAIJU_DB_POOL_MAX: "0" })).toThrow(/KAIJU_DB_POOL_MAX/);
    expect(() => loadConfig({ ...base, KAIJU_DB_POOL_MAX: "x" })).toThrow(/KAIJU_DB_POOL_MAX/);
  });

  it("defaults: port 8080, HTTPS only, limits on", () => {
    const c = loadConfig(base);
    expect(c.port).toBe(8080);
    expect(c.allowedPorts).toEqual([443]);
    expect(c.allowedInternalCidrs).toEqual([]);
    expect(c.maxConnectionsPerSandbox).toBe(64);
    expect(c.bandwidthBytesPerSecond).toBeGreaterThan(0);
  });

  it("reads PORT, ports and CIDR lists from the environment", () => {
    const c = loadConfig({
      ...base,
      PORT: "9090",
      KAIJU_EGRESS_ALLOWED_PORTS: "443, 8443",
      KAIJU_EGRESS_ALLOWED_INTERNAL_CIDRS: "10.43.200.200/32",
      KAIJU_EGRESS_DENIED_CIDRS: "11.0.0.0/8,fd00::/8",
    });
    expect(c.port).toBe(9090);
    expect(c.allowedPorts).toEqual([443, 8443]);
    expect(c.allowedInternalCidrs).toEqual(["10.43.200.200/32"]);
    expect(c.deniedCidrs).toEqual(["11.0.0.0/8", "fd00::/8"]);
  });

  it("rejects invalid values with a clear error and never echoes the key", () => {
    expect(() => loadConfig({ ...base, PORT: "70000" })).toThrow(/PORT/);
    expect(() => loadConfig({ ...base, KAIJU_EGRESS_ALLOWED_PORTS: "0" })).toThrow(/ALLOWED_PORTS/);
    expect(() => loadConfig({ ...base, KAIJU_EGRESS_DENIED_CIDRS: "10.0.0.0/99" })).toThrow(
      /DENIED_CIDRS/,
    );
    expect(() => loadConfig({ KAIJU_DATABASE_URL: "x" })).toThrow(
      /KAIJU_SESSION_VERIFY_KEY_EGRESS_PROXY is required/,
    );
    let message = "";
    try {
      loadConfig({ ...base, KAIJU_SESSION_VERIFY_KEY_EGRESS_PROXY: PAIR.privatePem });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/public keys only/);
    expect(message).not.toContain(PAIR.privatePem.split("\n")[1]);
    expect(loadConfig(base).sessionVerifyKeys.has(PAIR.signing.kid)).toBe(true);
  });

  it("refuses allowed internal CIDRs that overlap an always-refused range (KOBE-694)", () => {
    for (const cidr of ["0.0.0.0/0", "169.254.0.0/16", "127.0.0.0/8", "128.0.0.0/1", "::/0"]) {
      expect(
        () =>
          loadConfig({ ...base, KAIJU_EGRESS_ALLOWED_INTERNAL_CIDRS: `192.168.10.4/30,${cidr}` }),
        cidr,
      ).toThrow(/KAIJU_EGRESS_ALLOWED_INTERNAL_CIDRS.*never reachable/);
    }
    const lan = loadConfig({ ...base, KAIJU_EGRESS_ALLOWED_INTERNAL_CIDRS: "192.168.10.4/30" });
    expect(lan.allowedInternalCidrs).toEqual(["192.168.10.4/30"]);
  });

  it("reads and validates the internal targets (EA4, KOBE-603)", () => {
    expect(loadConfig(base).internalTargets).toEqual([]);
    const c = loadConfig({
      ...base,
      KAIJU_EGRESS_INTERNAL_TARGETS: "192.0.2.10/32, fd12:3456::/48",
    });
    expect(c.internalTargets).toEqual(["192.0.2.10/32", "fd12:3456::/48"]);
    for (const bad of ["192.0.2.0/33", "nope", "169.254.169.254/32", "127.0.0.1", "0.0.0.0/0"]) {
      expect(() => loadConfig({ ...base, KAIJU_EGRESS_INTERNAL_TARGETS: bad }), bad).toThrow(
        /KAIJU_EGRESS_INTERNAL_TARGETS/,
      );
    }
  });

  it("turns git smart-HTTP on only with both the server URL and the internal key (KOBE-763)", () => {
    expect(loadConfig(base).git).toBeUndefined();
    const key = "k".repeat(40);
    const c = loadConfig({
      ...base,
      KAIJU_EGRESS_SERVER_URL: "http://kaiju-server:8082",
      KAIJU_EGRESS_INTERNAL_KEY: key,
    });
    expect(c.git).toMatchObject({
      serverUrl: "http://kaiju-server:8082",
      internalKey: key,
      maxResponseBytes: 4 * 1024 * 1024 * 1024,
      timeoutMs: 1_800_000,
      concurrentPerSandbox: 8,
    });
    expect(() =>
      loadConfig({ ...base, KAIJU_EGRESS_SERVER_URL: "http://kaiju-server:8082" }),
    ).toThrow(/go together/);
    expect(() => loadConfig({ ...base, KAIJU_EGRESS_INTERNAL_KEY: key })).toThrow(/go together/);
    expect(() =>
      loadConfig({
        ...base,
        KAIJU_EGRESS_SERVER_URL: "http://user:pw@kaiju-server:8082/x",
        KAIJU_EGRESS_INTERNAL_KEY: key,
      }),
    ).toThrow(/KAIJU_EGRESS_SERVER_URL/);
    expect(() =>
      loadConfig({
        ...base,
        KAIJU_EGRESS_SERVER_URL: "http://kaiju-server:8082",
        KAIJU_EGRESS_INTERNAL_KEY: "short",
      }),
    ).toThrow(/KAIJU_EGRESS_INTERNAL_KEY/);
  });
});

describe("old KOBE_* names for one release (KOBE-748)", () => {
  it("starts with only the old names and warns once, naming them without values", () => {
    const warn = vi.fn();
    const c = loadConfig(toLegacyEnv({ ...base, KAIJU_DB_POOL_MAX: "25" }), warn);
    expect(c.databaseUrl).toBe("postgres://app@db/kobe");
    expect(c.dbPoolMax).toBe(25);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toEqual({
      renamed: ["KOBE_DATABASE_URL", "KOBE_DB_POOL_MAX", "KOBE_SESSION_VERIFY_KEY_EGRESS_PROXY"],
      conflicts: [],
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("postgres://");
  });

  it("the new name wins when both are set, and the warning names the conflict", () => {
    const warn = vi.fn();
    const c = loadConfig({ ...base, KAIJU_DB_POOL_MAX: "25", KOBE_DB_POOL_MAX: "50" }, warn);
    expect(c.dbPoolMax).toBe(25);
    expect(warn.mock.calls[0]?.[1]).toEqual({ renamed: [], conflicts: ["KOBE_DB_POOL_MAX"] });
  });
});
