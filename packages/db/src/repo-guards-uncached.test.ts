import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * KOBE-823: `team-setters.test.ts`, `run-usage-retention-setting.test.ts` and
 * `audit/events.test.ts` read files outside this package (every tracked source, docs/), but Turbo
 * keys `@kaiju/db#test` on this package's own inputs. Cached, a violation planted elsewhere (say in
 * services/server) replays this package's last pass. So the task is never cached, in `pnpm verify`
 * and in CI alike; this keeps it that way.
 */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

describe("repo-wide guards are never replayed from Turbo's cache (KOBE-823)", () => {
  it("turbo.json runs @kaiju/db#test uncached, after its dependencies' builds", () => {
    const turbo = JSON.parse(readFileSync(`${ROOT}turbo.json`, "utf8")) as {
      tasks: Record<string, { cache?: boolean; dependsOn?: string[] }>;
    };
    const task = turbo.tasks["@kaiju/db#test"];
    expect(task?.cache).toBe(false);
    expect(task?.dependsOn).toEqual(turbo.tasks.test?.dependsOn);
  });
});
