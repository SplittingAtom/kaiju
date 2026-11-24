import { describe, expect, it, vi } from "vitest";
import {
  adoptLegacyEnv,
  legacyEnv,
  legacyEnvMessage,
  newEnvName,
  resolveLegacyEnv,
} from "./legacy-env.js";

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
});
