import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logger.js";
import { adoptCliLegacyEnv } from "./legacy-env.js";

afterEach(() => vi.restoreAllMocks());

describe("server CLIs: old KOBE_* names for one release (KOBE-748)", () => {
  it("moves the old names to the new ones and warns once, without values", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const env: Record<string, string | undefined> = {
      KOBE_DATABASE_URL: "postgres://app:pw@db/kaiju",
      KOBE_RUNTIME_CLASS: "old",
      KAIJU_RUNTIME_CLASS: "gvisor",
    };
    adoptCliLegacyEnv(env);
    expect(env).toEqual({
      KAIJU_DATABASE_URL: "postgres://app:pw@db/kaiju",
      KAIJU_RUNTIME_CLASS: "gvisor",
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toEqual({
      renamed: ["KOBE_DATABASE_URL"],
      conflicts: ["KOBE_RUNTIME_CLASS"],
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("pw@");
  });

  it("says nothing with the new names only", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    adoptCliLegacyEnv({ KAIJU_DATABASE_URL: "postgres://app@db/kaiju" });
    expect(warn).not.toHaveBeenCalled();
  });
});
