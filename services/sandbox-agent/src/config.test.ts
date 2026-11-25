import { toLegacyEnv } from "@kaiju/protocol/testing";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";

const SANDBOX = "af1a2b3c-4d5e-4f60-9182-93a4b5c6d7e8";
const base = { KAIJU_SANDBOX_ID: SANDBOX };

describe("sandbox-agent loadConfig", () => {
  it("requires a wss:// server URL and appends the contract path", () => {
    const config = loadConfig({ ...base, KAIJU_SERVER_URL: "wss://kaiju-server.kaiju-system.svc" });
    expect(config.serverUrl).toBe("wss://kaiju-server.kaiju-system.svc");
    expect(config.connectUrl).toBe("wss://kaiju-server.kaiju-system.svc/v1/sandbox/connect");
  });

  it("replaces any path on the server URL with the contract path", () => {
    expect(
      loadConfig({ ...base, KAIJU_SERVER_URL: "wss://kaiju-server/sandbox?x=1" }).connectUrl,
    ).toBe("wss://kaiju-server/v1/sandbox/connect");
  });

  it("allows ws:// only for in-cluster plaintext during development", () => {
    expect(loadConfig({ ...base, KAIJU_SERVER_URL: "ws://kaiju-server:8080" }).connectUrl).toBe(
      "ws://kaiju-server:8080/v1/sandbox/connect",
    );
  });

  it("takes the kaiju-tools extension (KOBE-128) from KAIJU_TOOLS_EXTENSION, absolute, unset = none", () => {
    const env = { ...base, KAIJU_SERVER_URL: "wss://kaiju" };
    expect(loadConfig(env).toolsExtension).toBeUndefined();
    expect(
      loadConfig({ ...env, KAIJU_TOOLS_EXTENSION: "/opt/kaiju/pi-extensions/kaiju-tools/index.js" })
        .toolsExtension,
    ).toBe("/opt/kaiju/pi-extensions/kaiju-tools/index.js");
    expect(() => loadConfig({ ...env, KAIJU_TOOLS_EXTENSION: "relative.js" })).toThrow();
  });

  it("takes the kaiju-exec extension (KOBE-167) from KAIJU_EXEC_EXTENSION, absolute, unset = none", () => {
    const env = { ...base, KAIJU_SERVER_URL: "wss://kaiju" };
    expect(loadConfig(env).execExtension).toBeUndefined();
    expect(
      loadConfig({ ...env, KAIJU_EXEC_EXTENSION: "/opt/kaiju/pi-extensions/kaiju-exec/index.js" })
        .execExtension,
    ).toBe("/opt/kaiju/pi-extensions/kaiju-exec/index.js");
    expect(() => loadConfig({ ...env, KAIJU_EXEC_EXTENSION: "relative.js" })).toThrow();
  });

  it("switches the tool executor with KAIJU_TOOL_EXECUTOR: on unless told otherwise, off in Kaiju's pods unless asked", () => {
    const env = { ...base, KAIJU_SERVER_URL: "wss://kaiju" };
    expect(loadConfig(env).toolExecutor).toBe(true);
    const pod = { KAIJU_SERVER_URL: "wss://kaiju", KAIJU_BOOTSTRAP_TOKEN_FILE: "/run/t" };
    expect(loadConfig(pod).toolExecutor).toBe(false);
    expect(loadConfig({ ...pod, KAIJU_TOOL_EXECUTOR: "true" }).toolExecutor).toBe(true);
    for (const on of ["true", "1"]) {
      expect(loadConfig({ ...env, KAIJU_TOOL_EXECUTOR: on }).toolExecutor).toBe(true);
    }
    for (const off of ["false", "0"]) {
      expect(loadConfig({ ...env, KAIJU_TOOL_EXECUTOR: off }).toolExecutor).toBe(false);
    }
    // Anything else is a typo that must not silently leave the tools unrouted (or routed).
    expect(() => loadConfig({ ...env, KAIJU_TOOL_EXECUTOR: "yes" })).toThrow(/KAIJU_TOOL_EXECUTOR/);
  });

  it("takes the skills directory (KOBE-82) from KAIJU_SKILLS_DIR, absolute, unset = unsupported", () => {
    const env = { ...base, KAIJU_SERVER_URL: "wss://kaiju" };
    expect(loadConfig(env).skillsDir).toBeUndefined();
    expect(loadConfig({ ...env, KAIJU_SKILLS_DIR: "/run/kaiju-skills" }).skillsDir).toBe(
      "/run/kaiju-skills",
    );
    expect(() => loadConfig({ ...env, KAIJU_SKILLS_DIR: "skills" })).toThrow(/KAIJU_SKILLS_DIR/);
  });

  it("rejects a missing or non-WebSocket server URL", () => {
    expect(() => loadConfig({})).toThrow(/KAIJU_SERVER_URL must be a ws/);
    expect(() => loadConfig({ ...base, KAIJU_SERVER_URL: "https://kaiju" })).toThrow(
      /KAIJU_SERVER_URL/,
    );
  });

  it("rejects credentials in the server URL (the token goes in a header, never a URL)", () => {
    expect(() => loadConfig({ ...base, KAIJU_SERVER_URL: "wss://u:p@kaiju-server" })).toThrow(
      /KAIJU_SERVER_URL/,
    );
  });

  it("in bootstrap mode (Kaiju's pods) takes the sandbox id from the server instead", () => {
    const config = loadConfig({
      KAIJU_SERVER_URL: "ws://server.kaiju.internal:8081",
      KAIJU_BOOTSTRAP_TOKEN_FILE: "/var/run/secrets/kaiju/bootstrap-token",
    });
    expect(config.bootstrapTokenFile).toBe("/var/run/secrets/kaiju/bootstrap-token");
    expect(() =>
      loadConfig({ KAIJU_SERVER_URL: "ws://kaiju", KAIJU_BOOTSTRAP_TOKEN_FILE: "relative/path" }),
    ).toThrow(/KAIJU_BOOTSTRAP_TOKEN_FILE/);
  });

  it("requires a lowercase uuid sandbox id", () => {
    expect(() => loadConfig({ KAIJU_SERVER_URL: "wss://kaiju" })).toThrow(/KAIJU_SANDBOX_ID/);
    expect(() =>
      loadConfig({ KAIJU_SERVER_URL: "wss://kaiju", KAIJU_SANDBOX_ID: SANDBOX.toUpperCase() }),
    ).toThrow(/KAIJU_SANDBOX_ID/);
  });

  it("defaults to the image layout", () => {
    const config = loadConfig({ ...base, KAIJU_SERVER_URL: "wss://kaiju" });
    expect(config).toMatchObject({
      tokenFile: "/var/run/kaiju/sandbox-wire/token",
      workspaceDir: "/workspace",
      sessionDir: "/workspace/.kaiju/sessions",
      piBin: "pi",
      maxPiProcesses: 8,
    });
  });

  it("takes the kernel bridge (KOBE-464) as an absolute path, off by default", () => {
    const url = { ...base, KAIJU_SERVER_URL: "ws://kaiju-server:8080" };
    expect(loadConfig(url)).toMatchObject({
      kernelPython: "/usr/local/bin/python3",
      maxKernels: 4,
      kernelIdleMs: 30 * 60_000,
    });
    expect(loadConfig(url).kernelBridge).toBeUndefined();
    const bridge = "/opt/kaiju/kernel/kaiju-kernel-bridge.py";
    expect(loadConfig({ ...url, KAIJU_KERNEL_BRIDGE: bridge }).kernelBridge).toBe(bridge);
    expect(() => loadConfig({ ...url, KAIJU_KERNEL_BRIDGE: "bridge.py" })).toThrow(
      /KAIJU_KERNEL_BRIDGE/,
    );
  });

  it("rejects relative directories", () => {
    expect(() =>
      loadConfig({ ...base, KAIJU_SERVER_URL: "wss://kaiju", KAIJU_SESSION_DIR: "sessions" }),
    ).toThrow(/KAIJU_SESSION_DIR/);
  });

  it("takes the Pi identity helper (KOBE-71) as an absolute path, off by default", () => {
    const url = { ...base, KAIJU_SERVER_URL: "ws://kaiju-server:8080" };
    expect(loadConfig(url).piRunAs).toBeUndefined();
    expect(loadConfig({ ...url, KAIJU_PI_RUNAS: "/opt/kaiju/bin/kaiju-runas" }).piRunAs).toBe(
      "/opt/kaiju/bin/kaiju-runas",
    );
    expect(() => loadConfig({ ...url, KAIJU_PI_RUNAS: "kaiju-runas" })).toThrow(/KAIJU_PI_RUNAS/);
  });

  it("reads the egress proxy for tools (KOBE-39): port always written, no credentials", () => {
    const url = { ...base, KAIJU_SERVER_URL: "ws://kaiju-server:8080" };
    expect(loadConfig(url).egressProxyUrl).toBeUndefined();
    expect(loadConfig(url).egressEnvScript).toBe("/opt/kaiju/egress-env.sh");
    expect(
      loadConfig({ ...url, KAIJU_EGRESS_PROXY_URL: "http://egress-proxy.kaiju.internal" })
        .egressProxyUrl,
    ).toBe("http://egress-proxy.kaiju.internal:80");
    expect(
      loadConfig({ ...url, KAIJU_EGRESS_PROXY_URL: "http://egress-proxy.kaiju.internal:8080/" })
        .egressProxyUrl,
    ).toBe("http://egress-proxy.kaiju.internal:8080");
    for (const bad of ["http://u:p@egress-proxy:80", "https://egress-proxy", "http://e/x"]) {
      expect(() => loadConfig({ ...url, KAIJU_EGRESS_PROXY_URL: bad }), bad).toThrow(
        /KAIJU_EGRESS_PROXY_URL/,
      );
    }
    expect(() => loadConfig({ ...url, NO_PROXY: "a;rm -rf /" })).toThrow(/NO_PROXY/);
  });
});

describe("old KOBE_* names for one release (KOBE-748)", () => {
  // A SandboxTemplate written by an older server sets the old names; this image reads both.
  it("starts with only the old names and warns once, naming them", () => {
    const warn = vi.fn();
    const config = loadConfig(
      toLegacyEnv({ ...base, KAIJU_SERVER_URL: "wss://kaiju-server.kaiju-system.svc" }),
      warn,
    );
    expect(config.connectUrl).toBe("wss://kaiju-server.kaiju-system.svc/v1/sandbox/connect");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toEqual({
      renamed: ["KOBE_SANDBOX_ID", "KOBE_SERVER_URL"],
      conflicts: [],
    });
  });

  it("the new name wins when both are set, and the warning names the conflict", () => {
    const warn = vi.fn();
    const config = loadConfig(
      { ...base, KAIJU_SERVER_URL: "wss://new-server", KOBE_SERVER_URL: "wss://old-server" },
      warn,
    );
    expect(config.serverUrl).toBe("wss://new-server");
    expect(warn.mock.calls[0]?.[1]).toEqual({ renamed: [], conflicts: ["KOBE_SERVER_URL"] });
  });
});
