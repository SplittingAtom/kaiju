import { toLegacyEnv } from "@kaiju/protocol/testing";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";

const REQUIRED = {
  KAIJU_DATABASE_URL: "postgres://kobe_app:pw@db:5432/kobe",
  KAIJU_PUBLIC_URL: "https://kaiju.example.com",
  KAIJU_AUTH_SECRET: "x".repeat(32),
  KAIJU_SETUP_TOKEN: "t".repeat(24),
  KAIJU_SMTP_HOST: "smtp.example.com",
  KAIJU_SMTP_FROM: "Kaiju <kaiju@example.com>",
};

describe("loadConfig", () => {
  it("reads the pool sizes and the connection budget inputs (KOBE-736)", () => {
    expect(loadConfig(REQUIRED)).toMatchObject({
      dbPools: { max: 10, streamMax: 4 },
      dbBudget: undefined,
    });
    const c = loadConfig({
      ...REQUIRED,
      KAIJU_DB_POOL_MAX: "20",
      KAIJU_DB_STREAM_POOL_MAX: "6",
      KAIJU_DB_BUDGET_SERVER_REPLICAS: "3",
      KAIJU_DB_BUDGET_PEER_CONNECTIONS: "44",
    });
    expect(c.dbPools).toEqual({ max: 20, streamMax: 6 });
    expect(c.dbBudget).toEqual({ serverReplicas: 3, peerConnections: 44 });
    for (const [name, bad] of [
      ["KAIJU_DB_POOL_MAX", "0"],
      ["KAIJU_DB_POOL_MAX", "201"],
      ["KAIJU_DB_STREAM_POOL_MAX", "x"],
      ["KAIJU_DB_BUDGET_SERVER_REPLICAS", "0"],
      ["KAIJU_DB_BUDGET_PEER_CONNECTIONS", "-1"],
    ] as const) {
      expect(() => loadConfig({ ...REQUIRED, [name]: bad })).toThrow(new RegExp(name));
    }
  });

  it("defaults the retention table sweeps to the owner's periods; 0 turns one off (KOBE-741)", () => {
    expect(loadConfig(REQUIRED).retentionSweeps).toEqual({
      eventsDays: 30,
      readNotificationsDays: 180,
      runUsageMonths: 13,
      evalHistoryMonths: 12,
    });
    const c = loadConfig({
      ...REQUIRED,
      KAIJU_RETENTION_EVENTS_DAYS: "0",
      KAIJU_RETENTION_READ_NOTIFICATIONS_DAYS: "90",
      KAIJU_RETENTION_RUN_USAGE_MONTHS: "0",
      KAIJU_RETENTION_EVAL_HISTORY_MONTHS: "24",
    });
    expect(c.retentionSweeps).toEqual({
      eventsDays: null,
      readNotificationsDays: 90,
      runUsageMonths: null,
      evalHistoryMonths: 24,
    });
    // An empty value is the default, never "off".
    expect(
      loadConfig({
        ...REQUIRED,
        KAIJU_RETENTION_EVENTS_DAYS: "",
        KAIJU_RETENTION_RUN_USAGE_MONTHS: " ",
      }).retentionSweeps,
    ).toMatchObject({ eventsDays: 30, runUsageMonths: 13 });
    for (const [name, bad] of [
      // Inside the scheduler's grace window plus a day.
      ["KAIJU_RETENTION_EVENTS_DAYS", "1"],
      ["KAIJU_RETENTION_READ_NOTIFICATIONS_DAYS", "-1"],
      // The ledger's trigger refuses rows younger than 90 days.
      ["KAIJU_RETENTION_RUN_USAGE_MONTHS", "3"],
      ["KAIJU_RETENTION_EVAL_HISTORY_MONTHS", "1.5"],
      ["KAIJU_RETENTION_EVAL_HISTORY_MONTHS", "121"],
    ] as const) {
      expect(() => loadConfig({ ...REQUIRED, [name]: bad })).toThrow(new RegExp(name));
    }
  });

  it("defaults the port to 8080 and the process to the API server", () => {
    expect(loadConfig(REQUIRED)).toMatchObject({ port: 8080, process: "server" });
  });

  it("reads PORT and KAIJU_PROCESS", () => {
    expect(loadConfig({ ...REQUIRED, PORT: "9090", KAIJU_PROCESS: "scheduler" })).toMatchObject({
      port: 9090,
      process: "scheduler",
    });
  });

  it("rejects an invalid port or process role with a clear error", () => {
    expect(() => loadConfig({ ...REQUIRED, PORT: "70000" })).toThrow(/PORT/);
    expect(() => loadConfig({ ...REQUIRED, KAIJU_PROCESS: "worker" })).toThrow(/KAIJU_PROCESS/);
  });

  it("session token TTL defaults to 15 min, shortened only within 10–900 s (KOBE-241, e2e)", () => {
    expect(loadConfig(REQUIRED).sessionTokenTtlSeconds).toBe(900);
    expect(
      loadConfig({ ...REQUIRED, KAIJU_SESSION_TOKEN_TTL_SECONDS: "15" }).sessionTokenTtlSeconds,
    ).toBe(15);
    for (const bad of ["9", "901", "x"]) {
      expect(() => loadConfig({ ...REQUIRED, KAIJU_SESSION_TOKEN_TTL_SECONDS: bad })).toThrow(
        /KAIJU_SESSION_TOKEN_TTL_SECONDS/,
      );
    }
  });

  it("model token defaults: 16384 output, 32768 for reasoning models, 128000 window, each configurable (KOBE-259)", () => {
    expect(loadConfig(REQUIRED).modelTokenDefaults).toEqual({
      maxOutputTokens: 16_384,
      reasoningMaxOutputTokens: 32_768,
      contextWindow: 128_000,
    });
    expect(
      loadConfig({
        ...REQUIRED,
        KAIJU_MODEL_DEFAULT_MAX_OUTPUT_TOKENS: "8192",
        KAIJU_MODEL_DEFAULT_REASONING_MAX_OUTPUT_TOKENS: "65536",
        KAIJU_MODEL_DEFAULT_CONTEXT_WINDOW: "200000",
      }).modelTokenDefaults,
    ).toEqual({ maxOutputTokens: 8_192, reasoningMaxOutputTokens: 65_536, contextWindow: 200_000 });
    for (const [name, bad] of [
      ["KAIJU_MODEL_DEFAULT_MAX_OUTPUT_TOKENS", "255"],
      ["KAIJU_MODEL_DEFAULT_REASONING_MAX_OUTPUT_TOKENS", "131073"],
      ["KAIJU_MODEL_DEFAULT_CONTEXT_WINDOW", "1023"],
      ["KAIJU_MODEL_DEFAULT_CONTEXT_WINDOW", "x"],
    ] as const) {
      expect(() => loadConfig({ ...REQUIRED, [name]: bad }), name).toThrow(new RegExp(name));
    }
    // Either output default must leave room for input in the default window.
    expect(() => loadConfig({ ...REQUIRED, KAIJU_MODEL_DEFAULT_CONTEXT_WINDOW: "32768" })).toThrow(
      /KAIJU_MODEL_DEFAULT_REASONING_MAX_OUTPUT_TOKENS/,
    );
  });

  it("caps agent versions at 1000 by default, configurable within 1–100000 (KOBE-46)", () => {
    expect(loadConfig(REQUIRED).agentMaxVersions).toBe(1000);
    expect(loadConfig({ ...REQUIRED, KAIJU_AGENT_MAX_VERSIONS: "50" }).agentMaxVersions).toBe(50);
    expect(() => loadConfig({ ...REQUIRED, KAIJU_AGENT_MAX_VERSIONS: "0" })).toThrow(
      /KAIJU_AGENT_MAX_VERSIONS/,
    );
  });

  it("suspends unfinished skill rescans after 24 h by default, 0 for never (KOBE-781 review)", () => {
    const hours = (v?: string) =>
      loadConfig({
        ...REQUIRED,
        ...(v === undefined ? {} : { KAIJU_SKILL_RESCAN_INCOMPLETE_SUSPEND_HOURS: v }),
      }).skillRescanIncompleteSuspendHours;
    expect(hours()).toBe(24);
    expect(hours("0")).toBe(0);
    expect(hours("72")).toBe(72);
    for (const bad of ["-1", "8761", "1.5"])
      expect(() => hours(bad)).toThrow(/KAIJU_SKILL_RESCAN_INCOMPLETE_SUSPEND_HOURS/);
  });

  it("reads the internal listener settings for the MCP proxy (KOBE-58)", () => {
    expect(loadConfig(REQUIRED)).toMatchObject({
      internalPort: 8082,
      mcpProxyInternalKey: undefined,
    });
    expect(
      loadConfig({
        ...REQUIRED,
        KAIJU_INTERNAL_PORT: "9000",
        KAIJU_MCP_PROXY_INTERNAL_KEY: "k".repeat(32),
      }),
    ).toMatchObject({ internalPort: 9000, mcpProxyInternalKey: "k".repeat(32) });
    expect(() => loadConfig({ ...REQUIRED, KAIJU_MCP_PROXY_INTERNAL_KEY: "short" })).toThrow(
      /KAIJU_MCP_PROXY_INTERNAL_KEY/,
    );
  });

  it("keeps a separate key for the proxy's internal routes, falling back to one key (KOBE-693)", () => {
    const one = "k".repeat(32);
    const routes = "r".repeat(32);
    expect(loadConfig({ ...REQUIRED, KAIJU_MCP_PROXY_INTERNAL_KEY: one })).toMatchObject({
      mcpProxyInternalKey: one,
      mcpProxyRoutesKey: one,
    });
    expect(
      loadConfig({
        ...REQUIRED,
        KAIJU_MCP_PROXY_INTERNAL_KEY: one,
        KAIJU_MCP_PROXY_ROUTES_KEY: routes,
      }),
    ).toMatchObject({ mcpProxyInternalKey: one, mcpProxyRoutesKey: routes });
    expect(
      loadConfig({ ...REQUIRED, KAIJU_MCP_PROXY_INTERNAL_KEY: one, KAIJU_MCP_PROXY_ROUTES_KEY: "" })
        .mcpProxyRoutesKey,
    ).toBe(one);
    expect(() => loadConfig({ ...REQUIRED, KAIJU_MCP_PROXY_ROUTES_KEY: "short" })).toThrow(
      /KAIJU_MCP_PROXY_ROUTES_KEY/,
    );
  });

  it("reads the egress proxy's key for git decisions (KOBE-763)", () => {
    expect(loadConfig(REQUIRED).egressProxyInternalKey).toBeUndefined();
    expect(
      loadConfig({ ...REQUIRED, KAIJU_EGRESS_PROXY_INTERNAL_KEY: "" }).egressProxyInternalKey,
    ).toBeUndefined();
    const key = "e".repeat(32);
    expect(
      loadConfig({ ...REQUIRED, KAIJU_EGRESS_PROXY_INTERNAL_KEY: key }).egressProxyInternalKey,
    ).toBe(key);
    expect(() => loadConfig({ ...REQUIRED, KAIJU_EGRESS_PROXY_INTERNAL_KEY: "short" })).toThrow(
      /KAIJU_EGRESS_PROXY_INTERNAL_KEY/,
    );
  });

  it("reads the MCP proxy address for the pinning probe (KOBE-101)", () => {
    expect(loadConfig(REQUIRED).mcpProxyUrl).toBeUndefined();
    expect(
      loadConfig({ ...REQUIRED, KAIJU_MCP_PROXY_URL: "http://kaiju-mcp-proxy:80" }).mcpProxyUrl,
    ).toBe("http://kaiju-mcp-proxy:80");
    expect(() => loadConfig({ ...REQUIRED, KAIJU_MCP_PROXY_URL: "ftp://x" })).toThrow(
      /KAIJU_MCP_PROXY_URL/,
    );
  });

  it("reads the model gateway's address for the server's own calls (KOBE-219)", () => {
    expect(loadConfig(REQUIRED).modelGatewayUrl).toBeUndefined();
    expect(
      loadConfig({ ...REQUIRED, KAIJU_MODEL_GATEWAY_URL: "http://kaiju-model-gateway" })
        .modelGatewayUrl,
    ).toBe("http://kaiju-model-gateway");
    expect(() => loadConfig({ ...REQUIRED, KAIJU_MODEL_GATEWAY_URL: "ftp://x" })).toThrow(
      /KAIJU_MODEL_GATEWAY_URL/,
    );
    expect(() =>
      loadConfig({ ...REQUIRED, KAIJU_MODEL_GATEWAY_URL: "http://u:p@kaiju-model-gateway" }),
    ).toThrow(/KAIJU_MODEL_GATEWAY_URL/);
  });

  it("requires a postgres database URL", () => {
    const { KAIJU_DATABASE_URL: _, ...rest } = REQUIRED;
    expect(() => loadConfig(rest)).toThrow(/KAIJU_DATABASE_URL/);
    expect(() => loadConfig({ ...REQUIRED, KAIJU_DATABASE_URL: "mysql://x" })).toThrow(
      /KAIJU_DATABASE_URL/,
    );
  });

  it("requires an http(s) public URL without a path", () => {
    expect(loadConfig(REQUIRED).auth?.publicUrl).toBe("https://kaiju.example.com");
    expect(() => loadConfig({ ...REQUIRED, KAIJU_PUBLIC_URL: "kaiju.example.com" })).toThrow(
      /KAIJU_PUBLIC_URL/,
    );
    expect(() =>
      loadConfig({ ...REQUIRED, KAIJU_PUBLIC_URL: "https://kaiju.example.com/app" }),
    ).toThrow(/KAIJU_PUBLIC_URL/);
  });

  it("requires an auth secret of at least 32 characters", () => {
    expect(() => loadConfig({ ...REQUIRED, KAIJU_AUTH_SECRET: "short" })).toThrow(
      /KAIJU_AUTH_SECRET/,
    );
  });

  it("requires a setup token of at least 24 characters", () => {
    expect(() => loadConfig({ ...REQUIRED, KAIJU_SETUP_TOKEN: "short" })).toThrow(
      /KAIJU_SETUP_TOKEN/,
    );
  });

  it("reads HSTS includeSubDomains, off by default (KOBE-695)", () => {
    expect(loadConfig(REQUIRED).auth?.hstsIncludeSubDomains).toBe(false);
    expect(
      loadConfig({ ...REQUIRED, KAIJU_HSTS_INCLUDE_SUBDOMAINS: "true" }).auth
        ?.hstsIncludeSubDomains,
    ).toBe(true);
    expect(() => loadConfig({ ...REQUIRED, KAIJU_HSTS_INCLUDE_SUBDOMAINS: "yes" })).toThrow(
      /KAIJU_HSTS_INCLUDE_SUBDOMAINS must be true or false/,
    );
  });

  it("reads who limits requests at the ingress, unknown by default (KOBE-811)", () => {
    expect(loadConfig(REQUIRED).auth?.ingressRateLimit).toBe("unknown");
    for (const v of ["chart", "external", "none", "unknown"] as const) {
      expect(loadConfig({ ...REQUIRED, KAIJU_INGRESS_RATE_LIMIT: v }).auth?.ingressRateLimit).toBe(
        v,
      );
    }
    expect(() => loadConfig({ ...REQUIRED, KAIJU_INGRESS_RATE_LIMIT: "on" })).toThrow(
      /KAIJU_INGRESS_RATE_LIMIT must be chart, external, none or unknown/,
    );
  });

  it("reads an optional approval key of at least 32 characters (KOBE-37), never for the scheduler", () => {
    expect(loadConfig(REQUIRED).auth?.approvalKey).toBeUndefined();
    expect(loadConfig({ ...REQUIRED, KAIJU_APPROVAL_KEY: "" }).auth?.approvalKey).toBeUndefined();
    const key = "a".repeat(48);
    expect(loadConfig({ ...REQUIRED, KAIJU_APPROVAL_KEY: key }).auth?.approvalKey).toBe(key);
    expect(() => loadConfig({ ...REQUIRED, KAIJU_APPROVAL_KEY: "short" })).toThrow(
      /KAIJU_APPROVAL_KEY must be at least 32/,
    );
    expect(
      loadConfig({ ...REQUIRED, KAIJU_PROCESS: "scheduler", KAIJU_APPROVAL_KEY: key }).auth,
    ).toBeUndefined();
  });

  it("parses trusted proxy CIDRs", () => {
    expect(loadConfig(REQUIRED).auth?.trustedProxies).toEqual([]);
    expect(
      loadConfig({ ...REQUIRED, KAIJU_TRUSTED_PROXIES: "10.42.0.0/16, 10.43.0.0/16" }).auth
        ?.trustedProxies,
    ).toEqual(["10.42.0.0/16", "10.43.0.0/16"]);
    expect(() => loadConfig({ ...REQUIRED, KAIJU_TRUSTED_PROXIES: "not-a-cidr" })).toThrow(
      /KAIJU_TRUSTED_PROXIES/,
    );
  });

  it("does not give the scheduler auth secrets (least privilege)", () => {
    const scheduler = loadConfig({
      KAIJU_PROCESS: "scheduler",
      KAIJU_DATABASE_URL: REQUIRED.KAIJU_DATABASE_URL,
    });
    expect(scheduler.auth).toBeUndefined();
    expect(loadConfig(REQUIRED).auth).toMatchObject({ setupToken: "t".repeat(24) });
  });

  it("never echoes secret values in errors", () => {
    expect(() => loadConfig({ ...REQUIRED, KAIJU_AUTH_SECRET: "hunter2" })).not.toThrow(/hunter2/);
  });

  it("reads the sandbox RuntimeClass for both processes and rejects a malformed name", () => {
    expect(loadConfig({ ...REQUIRED, KAIJU_RUNTIME_CLASS: "gvisor" }).runtimeClassName).toBe(
      "gvisor",
    );
    expect(
      loadConfig({ ...REQUIRED, KAIJU_PROCESS: "scheduler", KAIJU_RUNTIME_CLASS: "kata-qemu" })
        .runtimeClassName,
    ).toBe("kata-qemu");
    expect(() => loadConfig({ ...REQUIRED, KAIJU_RUNTIME_CLASS: "Not A Name" })).toThrow(
      /KAIJU_RUNTIME_CLASS/,
    );
  });

  it("leaves the RuntimeClass unset when absent (the isolation gate then disables agents)", () => {
    expect(loadConfig(REQUIRED).runtimeClassName).toBeUndefined();
    expect(loadConfig({ ...REQUIRED, KAIJU_RUNTIME_CLASS: " " }).runtimeClassName).toBeUndefined();
  });

  describe("SMTP (KOBE-13)", () => {
    it("requires a host and a From address for the API server, with safe defaults", () => {
      expect(loadConfig(REQUIRED).smtp).toEqual({
        host: "smtp.example.com",
        port: 587,
        security: "starttls",
        from: { name: "Kaiju", address: "kaiju@example.com" },
      });
      const { KAIJU_SMTP_HOST: _h, ...noHost } = REQUIRED;
      expect(() => loadConfig(noHost)).toThrow(/KAIJU_SMTP_HOST/);
      const { KAIJU_SMTP_FROM: _f, ...noFrom } = REQUIRED;
      expect(() => loadConfig(noFrom)).toThrow(/KAIJU_SMTP_FROM/);
    });

    it("accepts a bare From address and rejects malformed ones (no header injection)", () => {
      expect(
        loadConfig({ ...REQUIRED, KAIJU_SMTP_FROM: "noreply@example.com" }).smtp?.from,
      ).toEqual({ address: "noreply@example.com" });
      for (const bad of [
        "not an address",
        "Kaiju <a@b.c>\r\nBcc: x@y.z",
        "Kaiju <>",
        "a@b.c, d@e.f",
      ]) {
        expect(() => loadConfig({ ...REQUIRED, KAIJU_SMTP_FROM: bad }), bad).toThrow(
          /KAIJU_SMTP_FROM/,
        );
      }
    });

    it("reads port, security and credentials", () => {
      const smtp = loadConfig({
        ...REQUIRED,
        KAIJU_SMTP_PORT: "465",
        KAIJU_SMTP_SECURITY: "tls",
        KAIJU_SMTP_USERNAME: "mailer",
        KAIJU_SMTP_PASSWORD: "s3cret",
      }).smtp;
      expect(smtp).toMatchObject({
        port: 465,
        security: "tls",
        auth: { user: "mailer", pass: "s3cret" },
      });
      expect(() => loadConfig({ ...REQUIRED, KAIJU_SMTP_SECURITY: "ssl3" })).toThrow(
        /KAIJU_SMTP_SECURITY/,
      );
      expect(() => loadConfig({ ...REQUIRED, KAIJU_SMTP_PORT: "0" })).toThrow(/KAIJU_SMTP_PORT/);
    });

    it("requires username and password together, and never sends them over plain SMTP", () => {
      expect(() => loadConfig({ ...REQUIRED, KAIJU_SMTP_USERNAME: "mailer" })).toThrow(
        /KAIJU_SMTP_PASSWORD/,
      );
      expect(() =>
        loadConfig({
          ...REQUIRED,
          KAIJU_SMTP_SECURITY: "none",
          KAIJU_SMTP_USERNAME: "mailer",
          KAIJU_SMTP_PASSWORD: "hunter2",
        }),
      ).toThrow(/KAIJU_SMTP_SECURITY/);
      expect(() =>
        loadConfig({
          ...REQUIRED,
          KAIJU_SMTP_SECURITY: "none",
          KAIJU_SMTP_USERNAME: "mailer",
          KAIJU_SMTP_PASSWORD: "hunter2",
        }),
      ).not.toThrow(/hunter2/);
      expect(loadConfig({ ...REQUIRED, KAIJU_SMTP_SECURITY: "none" }).smtp?.security).toBe("none");
    });

    it("is not needed by the scheduler", () => {
      expect(
        loadConfig({ KAIJU_PROCESS: "scheduler", KAIJU_DATABASE_URL: REQUIRED.KAIJU_DATABASE_URL })
          .smtp,
      ).toBeUndefined();
    });
  });

  describe("scheduler runner (KOBE-174)", () => {
    it("defaults to a 15 s tick and a 60 minute grace window", () => {
      expect(loadConfig(REQUIRED).scheduler).toEqual({ tickSeconds: 15, graceMinutes: 60 });
    });

    it("reads both settings and rejects values out of range", () => {
      expect(
        loadConfig({
          ...REQUIRED,
          KAIJU_SCHEDULER_TICK_SECONDS: "30",
          KAIJU_SCHEDULER_GRACE_MINUTES: "120",
        }).scheduler,
      ).toEqual({ tickSeconds: 30, graceMinutes: 120 });
      expect(() => loadConfig({ ...REQUIRED, KAIJU_SCHEDULER_TICK_SECONDS: "1" })).toThrow(
        /KAIJU_SCHEDULER_TICK_SECONDS/,
      );
      expect(() => loadConfig({ ...REQUIRED, KAIJU_SCHEDULER_GRACE_MINUTES: "0" })).toThrow(
        /KAIJU_SCHEDULER_GRACE_MINUTES/,
      );
    });
  });
  describe("chart-seeded branding defaults (KOBE-503)", () => {
    it("is empty when unset or blank", () => {
      expect(loadConfig(REQUIRED).branding).toEqual({});
      expect(
        loadConfig({
          ...REQUIRED,
          KAIJU_BRANDING_APP_NAME: "",
          KAIJU_BRANDING_PRESET: " ",
          KAIJU_BRANDING_SHOW_NAME: "",
        }).branding,
      ).toEqual({});
    });

    it("reads the name (trimmed), the preset and show-name", () => {
      expect(
        loadConfig({
          ...REQUIRED,
          KAIJU_BRANDING_APP_NAME: "  Acme Assist ",
          KAIJU_BRANDING_PRESET: "tokyo-nights",
          KAIJU_BRANDING_SHOW_NAME: "false",
        }).branding,
      ).toEqual({ appName: "Acme Assist", preset: "tokyo-nights", showName: false });
      expect(loadConfig({ ...REQUIRED, KAIJU_BRANDING_SHOW_NAME: "true" }).branding).toEqual({
        showName: true,
      });
    });

    it.each([
      ["KAIJU_BRANDING_APP_NAME", "x".repeat(41)],
      ["KAIJU_BRANDING_APP_NAME", "two\nlines"],
      ["KAIJU_BRANDING_PRESET", "custom"],
      ["KAIJU_BRANDING_PRESET", "Slate"],
      ["KAIJU_BRANDING_SHOW_NAME", "yes"],
    ])("fails fast on an invalid %s, naming the key", (key, value) => {
      expect(() => loadConfig({ ...REQUIRED, [key]: value })).toThrow(new RegExp(key));
    });

    it("is not read by the scheduler", () => {
      const config = loadConfig({
        ...REQUIRED,
        KAIJU_PROCESS: "scheduler",
        KAIJU_BRANDING_PRESET: "nope",
      });
      expect(config.branding).toBeUndefined();
    });
  });
});

describe("old KOBE_* names for one release (KOBE-748)", () => {
  it("starts with only the old names and warns once, naming them without values", () => {
    const warn = vi.fn();
    const config = loadConfig(toLegacyEnv(REQUIRED), warn);
    expect(config).toEqual(loadConfig(REQUIRED, vi.fn()));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toEqual({
      renamed: Object.keys(toLegacyEnv(REQUIRED)).sort(),
      conflicts: [],
    });
    const logged = JSON.stringify(warn.mock.calls);
    for (const value of Object.values(REQUIRED)) expect(logged).not.toContain(value);
  });

  it("the new name wins when both are set, and the warning names the conflict", () => {
    const warn = vi.fn();
    const config = loadConfig(
      { ...REQUIRED, KOBE_PUBLIC_URL: "https://old.example.com", KAIJU_DB_POOL_MAX: "20" },
      warn,
    );
    expect(config.auth?.publicUrl).toBe("https://kaiju.example.com");
    expect(config.dbPools.max).toBe(20);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toEqual({ renamed: [], conflicts: ["KOBE_PUBLIC_URL"] });
    expect(warn.mock.calls[0]?.[0]).toContain("KOBE_PUBLIC_URL (KAIJU_PUBLIC_URL is used)");
  });
});
