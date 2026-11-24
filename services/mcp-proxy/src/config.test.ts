import { generateSessionKeyPair } from "@kaiju/session-token";
import { toLegacyEnv } from "@kaiju/protocol/testing";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";

const PAIR = generateSessionKeyPair();
const ENV = {
  KAIJU_SESSION_VERIFY_KEY_MCP_PROXY: PAIR.publicPem,
  KAIJU_MCP_INTERNAL_KEY: "i".repeat(32),
  KAIJU_MCP_SERVER_URL: "http://kaiju-server:8082/",
};

describe("loadConfig", () => {
  it("applies defaults: port 8080, HTTPS on 443 only, nothing internal", () => {
    const config = loadConfig(ENV);
    expect(config.port).toBe(8080);
    expect(config.serverUrl).toBe("http://kaiju-server:8082");
    expect(config.upstream).toEqual({
      allowInsecureHttp: false,
      allowedPorts: [443],
      allowedInternalCidrs: [],
      deniedCidrs: [],
    });
    expect(config.limits.maxRequestBytes).toBe(1024 * 1024);
    expect(config.limits.upstreamTimeoutMs).toBeLessThan(60_000);
  });

  it("waits longer for a grant than for other server calls, so an OAuth refresh fits (KOBE-778)", () => {
    const config = loadConfig(ENV);
    // The server's refresh: up to 10 s waiting for another replica's lease, then its own 5 s
    // token request; the grant call must outlast both.
    expect(config.limits.grantTimeoutMs).toBe(25_000);
    expect(config.limits.grantTimeoutMs).toBeGreaterThan(config.limits.serverTimeoutMs);
    expect(loadConfig({ ...ENV, KAIJU_MCP_GRANT_TIMEOUT_MS: "30000" }).limits.grantTimeoutMs).toBe(
      30_000,
    );
    expect(() =>
      loadConfig({
        ...ENV,
        KAIJU_MCP_SERVER_TIMEOUT_MS: "20000",
        KAIJU_MCP_GRANT_TIMEOUT_MS: "15000",
      }),
    ).toThrow(/KAIJU_MCP_GRANT_TIMEOUT_MS/);
  });

  it("serves the server's routes on their own port with their own key (KOBE-693)", () => {
    const config = loadConfig({ ...ENV, KAIJU_MCP_ROUTES_KEY: "r".repeat(32) });
    expect(config.internalPort).toBe(8081);
    expect(config.routesKey).toBe("r".repeat(32));
    expect(config.routesKeyShared).toBe(false);
    expect(loadConfig({ ...ENV, KAIJU_MCP_INTERNAL_PORT: "9091" }).internalPort).toBe(9091);
    // An existing Secret without the second key: the one key serves both ways, flagged.
    const shared = loadConfig(ENV);
    expect(shared.routesKey).toBe("i".repeat(32));
    expect(shared.routesKeyShared).toBe(true);
    expect(() => loadConfig({ ...ENV, KAIJU_MCP_ROUTES_KEY: "short" })).toThrow(
      /KAIJU_MCP_ROUTES_KEY/,
    );
    expect(() => loadConfig({ ...ENV, KAIJU_MCP_INTERNAL_PORT: "8080" })).toThrow(
      /KAIJU_MCP_INTERNAL_PORT must differ from PORT/,
    );
  });

  it("has no approval key: KAIJU_APPROVAL_KEY in the environment is ignored (KOBE-520)", () => {
    const config = loadConfig({ ...ENV, KAIJU_APPROVAL_KEY: "a".repeat(48) });
    expect(JSON.stringify(config)).not.toContain("a".repeat(48));
    expect(Object.keys(config).some((k) => /approval/i.test(k))).toBe(false);
  });

  it("reads lists and switches", () => {
    const config = loadConfig({
      ...ENV,
      PORT: "9090",
      KAIJU_MCP_ALLOW_INSECURE_HTTP: "true",
      KAIJU_MCP_ALLOWED_PORTS: "443, 8443",
      KAIJU_MCP_ALLOWED_INTERNAL_CIDRS: "10.0.5.0/24,192.168.10.4/30",
      KAIJU_MCP_DENIED_CIDRS: "100.100.0.0/16",
    });
    expect(config.port).toBe(9090);
    expect(config.upstream).toEqual({
      allowInsecureHttp: true,
      allowedPorts: [443, 8443],
      allowedInternalCidrs: ["10.0.5.0/24", "192.168.10.4/30"],
      deniedCidrs: ["100.100.0.0/16"],
    });
  });

  it.each([
    [
      "no session verify key",
      { KAIJU_SESSION_VERIFY_KEY_MCP_PROXY: undefined },
      /KAIJU_SESSION_VERIFY_KEY_MCP_PROXY is required/,
    ],
    [
      "a private key as the verify key",
      { KAIJU_SESSION_VERIFY_KEY_MCP_PROXY: PAIR.privatePem },
      /public keys only/,
    ],
    ["a short internal key", { KAIJU_MCP_INTERNAL_KEY: "short" }, /KAIJU_MCP_INTERNAL_KEY/],
    ["no server URL", { KAIJU_MCP_SERVER_URL: undefined }, /KAIJU_MCP_SERVER_URL/],
    ["a bad port", { PORT: "70000" }, /PORT/],
    ["a bad CIDR", { KAIJU_MCP_ALLOWED_INTERNAL_CIDRS: "nope" }, /CIDRs/],
    ["a bad upstream port", { KAIJU_MCP_ALLOWED_PORTS: "0" }, /KAIJU_MCP_ALLOWED_PORTS/],
    ["a bad switch", { KAIJU_MCP_ALLOW_INSECURE_HTTP: "yes" }, /KAIJU_MCP_ALLOW_INSECURE_HTTP/],
  ])("rejects %s with a clear error", (_, override, message) => {
    expect(() => loadConfig({ ...ENV, ...override })).toThrow(message);
  });

  // KOBE-694: install-wide internal targets never re-open metadata or loopback.
  it.each(["0.0.0.0/0", "169.254.0.0/16", "127.0.0.0/8", "128.0.0.0/1", "::/0"])(
    "rejects the always-refused internal CIDR %s",
    (cidr) => {
      expect(() =>
        loadConfig({ ...ENV, KAIJU_MCP_ALLOWED_INTERNAL_CIDRS: `192.168.10.4/30,${cidr}` }),
      ).toThrow(/KAIJU_MCP_ALLOWED_INTERNAL_CIDRS: CIDR .* never reachable/);
    },
  );

  it("never echoes key values in errors", () => {
    try {
      loadConfig({ ...ENV, KAIJU_MCP_INTERNAL_KEY: "secret-but-short" });
    } catch (err) {
      expect(String(err)).not.toContain("secret-but-short");
    }
  });
});

describe("old KOBE_* names for one release (KOBE-748)", () => {
  it("starts with only the old names and warns once, naming them without values", () => {
    const warn = vi.fn();
    const config = loadConfig(toLegacyEnv(ENV), warn);
    expect(config.serverUrl).toBe("http://kaiju-server:8082");
    expect(config.internalKey).toBe("i".repeat(32));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toEqual({
      renamed: [
        "KOBE_MCP_INTERNAL_KEY",
        "KOBE_MCP_SERVER_URL",
        "KOBE_SESSION_VERIFY_KEY_MCP_PROXY",
      ],
      conflicts: [],
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("i".repeat(32));
  });

  it("the new name wins when both are set, and the warning names the conflict", () => {
    const warn = vi.fn();
    const config = loadConfig({ ...ENV, KOBE_MCP_SERVER_URL: "http://old-server:8082/" }, warn);
    expect(config.serverUrl).toBe("http://kaiju-server:8082");
    expect(warn.mock.calls[0]?.[1]).toEqual({ renamed: [], conflicts: ["KOBE_MCP_SERVER_URL"] });
    expect(warn.mock.calls[0]?.[0]).toContain("KOBE_MCP_SERVER_URL (KAIJU_MCP_SERVER_URL is used)");
  });

  it("no warning with the new names only", () => {
    const warn = vi.fn();
    loadConfig({ ...ENV }, warn);
    expect(warn).not.toHaveBeenCalled();
  });
});
