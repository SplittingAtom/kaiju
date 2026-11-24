import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { RetentionJob } from "./job.js";

/** KOBE-243: KAIJU_RETENTION_PAUSED stops the nightly pass before it touches the database. */
describe("paused retention", () => {
  it("does nothing, not even taking the lock, even when forced", async () => {
    const connect = vi.fn(() => Promise.reject(new Error("must not connect")));
    const warn = vi.fn();
    const job = new RetentionJob({
      db: {} as never,
      pool: { connect },
      hourUtc: 3,
      paused: true,
      logger: { warn, info: vi.fn(), error: vi.fn() } as never,
    });
    expect(await job.tick()).toBe("paused");
    expect(await job.tick(true)).toBe("paused");
    expect(connect).not.toHaveBeenCalled();
  });

  it("is read from KAIJU_RETENTION_PAUSED, off by default, strictly true/false", () => {
    const base = { KAIJU_DATABASE_URL: "postgres://u:p@h/db", KAIJU_PROCESS: "scheduler" };
    expect(loadConfig(base).retentionPaused).toBe(false);
    expect(loadConfig({ ...base, KAIJU_RETENTION_PAUSED: "true" }).retentionPaused).toBe(true);
    expect(loadConfig({ ...base, KAIJU_RETENTION_PAUSED: "false" }).retentionPaused).toBe(false);
    expect(() => loadConfig({ ...base, KAIJU_RETENTION_PAUSED: "yes" })).toThrow(
      /KAIJU_RETENTION_PAUSED/,
    );
  });
});
