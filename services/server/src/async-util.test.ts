import { describe, expect, it, vi } from "vitest";
import { fireAndLog } from "./async-util.js";

const flush = () => new Promise((r) => setImmediate(r));

describe("fireAndLog", () => {
  it("logs a rejection at warn with the error and what failed, and never throws", async () => {
    const warn = vi.fn();
    const err = new Error("boom");
    expect(() => fireAndLog({ warn }, "budget evaluation", Promise.reject(err))).not.toThrow();
    await flush();
    expect(warn).toHaveBeenCalledWith({ err }, "budget evaluation failed");
  });

  it("adds context fields to the log line", async () => {
    const warn = vi.fn();
    const err = new Error("nope");
    fireAndLog({ warn }, "project mount reconcile", Promise.reject(err), { teamId: "t" });
    await flush();
    expect(warn).toHaveBeenCalledWith({ err, teamId: "t" }, "project mount reconcile failed");
  });

  it("says nothing when the work succeeds, and accepts undefined (optional work)", async () => {
    const warn = vi.fn();
    fireAndLog({ warn }, "x", Promise.resolve(1));
    fireAndLog({ warn }, "y", undefined);
    await flush();
    expect(warn).not.toHaveBeenCalled();
  });

  it("survives a logger that throws", async () => {
    const warn = vi.fn(() => {
      throw new Error("logger down");
    });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      fireAndLog({ warn }, "x", Promise.reject(new Error("boom")));
      await flush();
      await flush();
      expect(warn).toHaveBeenCalled();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
