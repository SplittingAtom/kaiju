import { toLegacyEnv } from "@kaiju/protocol/testing";
import { describe, expect, it, vi } from "vitest";
import { parseWebConfig } from "./config";

/** KOBE-500: KAIJU_SERVER_URL is validated, origin only; unset warns, invalid fails startup. */
describe("parseWebConfig", () => {
  it("accepts an http(s) origin and normalises a trailing slash away", () => {
    expect(parseWebConfig({ KAIJU_SERVER_URL: "http://kobe-server" })).toEqual({
      serverUrl: "http://kobe-server",
      problem: null,
      publicUrl: null,
    });
    expect(parseWebConfig({ KAIJU_SERVER_URL: "https://kobe-server.ns.svc:8443/" }).serverUrl).toBe(
      "https://kobe-server.ns.svc:8443",
    );
  });

  it("reports a missing value instead of throwing", () => {
    for (const env of [{}, { KAIJU_SERVER_URL: "" }, { KAIJU_SERVER_URL: "  " }]) {
      const config = parseWebConfig(env);
      expect(config.serverUrl).toBeNull();
      expect(config.problem).toMatch(/KAIJU_SERVER_URL is not set/);
    }
  });

  it.each([
    "kobe-server",
    "ftp://kobe-server",
    "http://kobe-server/v1",
    "http://kobe-server?x=1",
    "http://user:pw@kobe-server",
    "javascript:alert(1)",
  ])("fails fast on %s with the reason", (value) => {
    expect(() => parseWebConfig({ KAIJU_SERVER_URL: value })).toThrow(
      /KAIJU_SERVER_URL is invalid: /,
    );
  });

  it("reads KAIJU_PUBLIC_URL as an origin (KOBE-616) and fails on an invalid one", () => {
    expect(parseWebConfig({ KAIJU_PUBLIC_URL: "https://kaiju.example.com/" }).publicUrl).toBe(
      "https://kaiju.example.com",
    );
    expect(parseWebConfig({}).publicUrl).toBeNull();
    expect(() => parseWebConfig({ KAIJU_PUBLIC_URL: "https://kaiju.example.com/app" })).toThrow(
      /KAIJU_PUBLIC_URL is invalid/,
    );
  });
});

describe("old KOBE_* names for one release (KOBE-748)", () => {
  const env = { KAIJU_SERVER_URL: "http://kobe-server", KAIJU_PUBLIC_URL: "https://kaiju.test" };

  it("starts with only the old names and warns once, naming them", () => {
    const warn = vi.fn();
    expect(parseWebConfig(toLegacyEnv(env), warn)).toEqual(parseWebConfig(env, vi.fn()));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toEqual({
      renamed: ["KOBE_PUBLIC_URL", "KOBE_SERVER_URL"],
      conflicts: [],
    });
  });

  it("the new name wins when both are set, and the warning names the conflict", () => {
    const warn = vi.fn();
    const config = parseWebConfig({ ...env, KOBE_SERVER_URL: "http://old-server" }, warn);
    expect(config.serverUrl).toBe("http://kobe-server");
    expect(warn.mock.calls[0]?.[1]).toEqual({ renamed: [], conflicts: ["KOBE_SERVER_URL"] });
  });
});
