import { describe, expect, it, vi } from "vitest";
import { startServerJobs, type ServerJob } from "./jobs.js";

const job = (name: string, stop: () => unknown): ServerJob => ({
  name,
  start: () => stop,
  once: () => Promise.resolve(),
});

describe("startServerJobs (KOBE-705, review CODE-41)", () => {
  it("logs a job that fails to stop with its name and still stops the others", async () => {
    const warn = vi.fn();
    const stopped: string[] = [];
    const err = new Error("advisory lock held");
    const stopAll = startServerJobs(
      [
        job("audit-anchor", () => stopped.push("audit-anchor")),
        job("egress-blocked", () => Promise.reject(err)),
        job("budgets", () => {
          throw new Error("sync throw");
        }),
        job("retention", () => stopped.push("retention")),
      ],
      { warn },
    );
    await expect(stopAll()).resolves.toBeUndefined();
    expect(stopped).toEqual(["audit-anchor", "retention"]);
    expect(warn).toHaveBeenCalledWith({ err, job: "egress-blocked" }, "server job failed to stop");
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ job: "budgets" }),
      "server job failed to stop",
    );
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
