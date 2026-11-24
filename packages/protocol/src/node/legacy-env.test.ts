import { describe, expect, it, vi } from "vitest";
import {
  adoptLegacyEnv,
  legacyEnv,
  legacyEnvMessage,
  newEnvName,
  resolveLegacyEnv,
  serviceLinkNames,
} from "./legacy-env.js";

/** What Kubernetes injects for one Service (enableServiceLinks), as the kubelet writes it. */
function serviceLinks(
  svc: string,
  ip: string,
  ports: readonly { port: number; name?: string; proto?: "TCP" | "UDP" | "SCTP" }[],
): Record<string, string> {
  const host = ip.includes(":") ? `[${ip}]` : ip;
  const env: Record<string, string> = { [`${svc}_SERVICE_HOST`]: ip };
  ports.forEach(({ port, name, proto = "TCP" }, i) => {
    const p = proto.toLowerCase();
    if (i === 0) {
      env[`${svc}_SERVICE_PORT`] = String(port);
      env[`${svc}_PORT`] = `${p}://${host}:${port}`;
    }
    if (name !== undefined) env[`${svc}_SERVICE_PORT_${name.toUpperCase()}`] = String(port);
    const base = `${svc}_PORT_${port}_${proto}`;
    env[base] = `${p}://${host}:${port}`;
    env[`${base}_PROTO`] = p;
    env[`${base}_PORT`] = String(port);
    env[`${base}_ADDR`] = ip;
  });
  return env;
}

/** A pod's service-link variables in a namespace whose Services are named kobe-* (KOBE-836). */
const KOBE_SERVICE_LINKS: Record<string, string> = {
  ...serviceLinks("KOBE_SERVER", "10.43.12.7", [
    { port: 80, name: "http" },
    { port: 8082, name: "internal" },
  ]),
  ...serviceLinks("KOBE_WEB", "10.43.200.31", [{ port: 80, name: "http" }]),
  ...serviceLinks("KOBE_MCP_PROXY", "10.43.5.9", [{ port: 80, name: "http" }]),
  ...serviceLinks("KOBE_EGRESS_PROXY", "10.43.77.2", [{ port: 80 }, { port: 8081 }]),
  ...serviceLinks("KOBE_MODEL_GATEWAY", "fd00:10:43::1a", [{ port: 80, name: "http" }]),
  ...serviceLinks("KOBE_BIFROST", "10.43.9.250", [{ port: 8080, name: "http" }]),
  ...serviceLinks("KOBE_CLAMAV", "10.43.1.1", [{ port: 3310, name: "clamd" }]),
};

describe("legacy KOBE_* environment fallback (KOBE-748)", () => {
  it("maps the prefix and nothing else", () => {
    expect(newEnvName("KOBE_PUBLIC_URL")).toBe("KAIJU_PUBLIC_URL");
    expect(newEnvName("KOBE_SESSION_SIGNING_KEY_MODEL_GATEWAY")).toBe(
      "KAIJU_SESSION_SIGNING_KEY_MODEL_GATEWAY",
    );
  });

  it("an old name stands in for an unset new one, without changing the input", () => {
    const input = Object.freeze({ KOBE_PUBLIC_URL: "https://a.test", PORT: "8080" });
    const { env, report } = resolveLegacyEnv(input);
    expect(env).toEqual({ KAIJU_PUBLIC_URL: "https://a.test", PORT: "8080" });
    expect(report).toEqual({ renamed: ["KOBE_PUBLIC_URL"], conflicts: [] });
    expect(input).toEqual({ KOBE_PUBLIC_URL: "https://a.test", PORT: "8080" });
  });

  it("when both are set the new name wins, and the old one is reported as a conflict", () => {
    const { env, report } = resolveLegacyEnv({ KOBE_X: "old", KAIJU_X: "new" });
    expect(env).toEqual({ KAIJU_X: "new" });
    expect(report).toEqual({ renamed: [], conflicts: ["KOBE_X"] });
  });

  it("an empty new name does not hide a non-empty old one, and the warning says so", () => {
    // The chart renders KAIJU_S3_PREFIX="" by default; a hand-set KOBE_S3_PREFIX must survive.
    const { env, report } = resolveLegacyEnv({ KOBE_S3_PREFIX: "team-a/", KAIJU_S3_PREFIX: "" });
    expect(env).toEqual({ KAIJU_S3_PREFIX: "team-a/" });
    expect(report).toEqual({
      renamed: ["KOBE_S3_PREFIX"],
      conflicts: [],
      emptyNew: ["KOBE_S3_PREFIX"],
    });
    expect(legacyEnvMessage(report)).toContain(
      "KOBE_S3_PREFIX → KAIJU_S3_PREFIX (KAIJU_S3_PREFIX is set but empty, so KOBE_S3_PREFIX is used)",
    );
    const adopted: Record<string, string | undefined> = {
      KOBE_S3_PREFIX: "team-a/",
      KAIJU_S3_PREFIX: "",
    };
    adoptLegacyEnv(adopted);
    expect(adopted).toEqual({ KAIJU_S3_PREFIX: "team-a/" });
  });

  it("both empty: the new name is used, reported as a conflict", () => {
    const { env, report } = resolveLegacyEnv({ KOBE_X: "", KAIJU_X: "" });
    expect(env).toEqual({ KAIJU_X: "" });
    expect(report).toEqual({ renamed: [], conflicts: ["KOBE_X"] });
  });

  it("the warning names the variables, never their values", () => {
    const message = legacyEnvMessage({ renamed: ["KOBE_A"], conflicts: ["KOBE_B"] }) ?? "";
    expect(message).toContain("KOBE_A → KAIJU_A");
    expect(message).toContain("KOBE_B (KAIJU_B is used)");
    expect(message).toContain("next release");
    expect(legacyEnvMessage({ renamed: [], conflicts: [] })).toBeUndefined();

    const warn = vi.fn();
    legacyEnv({ KOBE_SECRET: "s3cr3t-value", KAIJU_KEY: "k3y-value", KOBE_KEY: "old-k3y" }, warn);
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain("KOBE_SECRET");
    expect(logged).toContain("KOBE_KEY");
    expect(logged).not.toMatch(/s3cr3t|k3y/);
  });

  it("warns once per environment, and not at all without old names", () => {
    const warn = vi.fn();
    const env = { KOBE_A: "1" };
    legacyEnv(env, warn);
    legacyEnv(env, warn);
    expect(warn).toHaveBeenCalledTimes(1);
    legacyEnv({ KAIJU_A: "1" }, warn);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("adopting moves old names in place, and the config load still warns about them once", () => {
    const env: Record<string, string | undefined> = {
      KOBE_A: "1",
      KOBE_B: "old",
      KAIJU_B: "new",
      HOME: "/h",
    };
    expect(adoptLegacyEnv(env)).toEqual({ renamed: ["KOBE_A"], conflicts: ["KOBE_B"] });
    expect(env).toEqual({ KAIJU_A: "1", KAIJU_B: "new", HOME: "/h" });
    // A second adoption finds nothing left.
    expect(adoptLegacyEnv(env)).toEqual({ renamed: [], conflicts: [] });

    const warn = vi.fn();
    expect(legacyEnv(env, warn)).toEqual({ KAIJU_A: "1", KAIJU_B: "new", HOME: "/h" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toEqual({ renamed: ["KOBE_A"], conflicts: ["KOBE_B"] });
    legacyEnv(env, warn);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  describe("Kubernetes service-link variables (KOBE-836)", () => {
    const base = { KAIJU_PUBLIC_URL: "https://k.test", HOME: "/h" };

    it("ac-1: a pod's service-link env gives no warning and no KAIJU_* copies", () => {
      expect(Object.keys(KOBE_SERVICE_LINKS).length).toBeGreaterThan(50);
      expect(KOBE_SERVICE_LINKS).toMatchObject({
        KOBE_SERVER_SERVICE_HOST: "10.43.12.7",
        KOBE_SERVER_SERVICE_PORT_HTTP: "80",
        KOBE_MCP_PROXY_PORT_80_TCP_ADDR: "10.43.5.9",
        KOBE_WEB_PORT: "tcp://10.43.200.31:80",
        KOBE_MODEL_GATEWAY_PORT: "tcp://[fd00:10:43::1a]:80",
      });
      const input = { ...base, ...KOBE_SERVICE_LINKS };
      expect(serviceLinkNames(input)).toEqual(new Set(Object.keys(KOBE_SERVICE_LINKS)));

      const { env, report } = resolveLegacyEnv(input);
      expect(report).toEqual({ renamed: [], conflicts: [] });
      expect(env).toEqual(input); // passed through unchanged, nothing copied
      expect(Object.keys(env).filter((k) => k.startsWith("KAIJU_"))).toEqual(["KAIJU_PUBLIC_URL"]);

      const warn = vi.fn();
      legacyEnv({ ...input }, warn);
      expect(warn).not.toHaveBeenCalled();

      const processEnv: Record<string, string | undefined> = { ...input };
      expect(adoptLegacyEnv(processEnv)).toEqual({ renamed: [], conflicts: [] });
      expect(processEnv).toEqual(input); // not ours to delete either
      legacyEnv(processEnv, warn);
      expect(warn).not.toHaveBeenCalled();
    });

    it("ac-2: real old names beside service links still warn and fall back", () => {
      const input = {
        ...KOBE_SERVICE_LINKS,
        KOBE_PUBLIC_URL: "https://k.test",
        KOBE_SMTP_PORT: "587",
        KAIJU_S3_BUCKET: "new",
        KOBE_S3_BUCKET: "old",
      };
      const warn = vi.fn();
      const env = legacyEnv(input, warn);
      const expected = {
        renamed: ["KOBE_PUBLIC_URL", "KOBE_SMTP_PORT"],
        conflicts: ["KOBE_S3_BUCKET"],
      };
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[1]).toEqual(expected);
      expect(warn.mock.calls[0]?.[0]).not.toMatch(/SERVICE_HOST|_TCP/);
      expect(env).toMatchObject({
        KAIJU_PUBLIC_URL: "https://k.test",
        KAIJU_SMTP_PORT: "587",
        KAIJU_S3_BUCKET: "new",
        KOBE_SERVER_SERVICE_HOST: "10.43.12.7",
      });
      expect(env).not.toHaveProperty("KAIJU_SERVER_SERVICE_HOST");
      expect(env).not.toHaveProperty("KOBE_PUBLIC_URL");

      const processEnv: Record<string, string | undefined> = { ...input };
      expect(adoptLegacyEnv(processEnv)).toEqual(expected);
      expect(processEnv.KAIJU_PUBLIC_URL).toBe("https://k.test");
      expect(processEnv.KOBE_WEB_PORT).toBe("tcp://10.43.200.31:80");
    });

    it("a look-alike without its SERVICE_HOST sibling, or with the wrong value shape, is a setting", () => {
      const { report } = resolveLegacyEnv({
        // No KOBE_FOO_SERVICE_HOST: kept as a setting even though the value looks like a link.
        KOBE_FOO_PORT: "tcp://10.0.0.1:80",
        KOBE_FOO_SERVICE_PORT: "80",
        // Sibling present, but the value is not service-link shaped.
        KOBE_SERVER_SERVICE_HOST: "10.43.12.7",
        KOBE_SERVER_PORT: "8080",
        KOBE_SERVER_SERVICE_PORT_HTTP: "http",
        KOBE_SERVER_PORT_80_TCP: "udp://10.43.12.7:80",
        KOBE_SERVER_PORT_80_TCP_PROTO: "http",
        KOBE_SERVER_PORT_80_TCP_ADDR: "server.example",
        // A sibling that is not an IP marks nothing.
        KOBE_DB_SERVICE_HOST: "db.example.com",
        KOBE_DB_SERVICE_PORT: "5432",
      });
      expect(report.renamed).toEqual([
        "KOBE_DB_SERVICE_HOST",
        "KOBE_DB_SERVICE_PORT",
        "KOBE_FOO_PORT",
        "KOBE_FOO_SERVICE_PORT",
        "KOBE_SERVER_PORT",
        "KOBE_SERVER_PORT_80_TCP",
        "KOBE_SERVER_PORT_80_TCP_ADDR",
        "KOBE_SERVER_PORT_80_TCP_PROTO",
        "KOBE_SERVER_SERVICE_PORT_HTTP",
      ]);
    });
  });
});
