import { describe, expect, it, vi } from "vitest";
import { parseMigrateEnv, parseWaitEnv } from "./env.js";

const MIGRATE_URL = "postgres://owner:pw@db/kaiju";
const APP_URL = "postgres://app:pw@db/kaiju";

describe("migration Job and wait initContainer env (KOBE-748)", () => {
  it("reads the new names without a warning", () => {
    const warn = vi.fn();
    expect(
      parseMigrateEnv({ KAIJU_DB_MIGRATE_URL: MIGRATE_URL, KAIJU_DB_APP_ROLE: "app" }, warn),
    ).toEqual({
      KAIJU_DB_MIGRATE_URL: MIGRATE_URL,
      KAIJU_DB_APP_ROLE: "app",
      KAIJU_DB_CONNECT_TIMEOUT_S: 300,
    });
    expect(parseWaitEnv({ KAIJU_DATABASE_URL: APP_URL }, warn).KAIJU_DB_WAIT_TIMEOUT_S).toBe(600);
    expect(warn).not.toHaveBeenCalled();
  });

  it("starts with only the old names and warns once, naming them without values", () => {
    const warn = vi.fn();
    const env = parseMigrateEnv(
      { KOBE_DB_MIGRATE_URL: MIGRATE_URL, KOBE_DB_APP_ROLE: "app" },
      warn,
    );
    expect(env.KAIJU_DB_MIGRATE_URL).toBe(MIGRATE_URL);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toEqual({
      renamed: ["KOBE_DB_APP_ROLE", "KOBE_DB_MIGRATE_URL"],
      conflicts: [],
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("pw@");

    const waitWarn = vi.fn();
    expect(parseWaitEnv({ KOBE_DATABASE_URL: APP_URL }, waitWarn).KAIJU_DATABASE_URL).toBe(APP_URL);
    expect(waitWarn).toHaveBeenCalledTimes(1);
  });

  it("the new name wins when both are set, and the warning names the conflict", () => {
    const warn = vi.fn();
    const env = parseWaitEnv(
      { KAIJU_DATABASE_URL: APP_URL, KOBE_DATABASE_URL: "postgres://old@db/kaiju" },
      warn,
    );
    expect(env.KAIJU_DATABASE_URL).toBe(APP_URL);
    expect(warn.mock.calls[0]?.[1]).toEqual({ renamed: [], conflicts: ["KOBE_DATABASE_URL"] });
  });

  it("fails naming the variable, never its value", () => {
    expect(() => parseWaitEnv({ KAIJU_DATABASE_URL: "mysql://u:secretpw@h/d" }, vi.fn())).toThrow(
      /^KAIJU_DATABASE_URL: KAIJU_DATABASE_URL must be a postgres:\/\/ URL$/,
    );
  });
});
