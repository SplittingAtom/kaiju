import { pino } from "pino";
import { describe, expect, it } from "vitest";
import type { EgressDecision } from "./allowlist.js";
import { TunnelRegistry } from "./tunnel-registry.js";

describe("TunnelRegistry git relays (KOBE-763)", () => {
  it("re-checks a git relay against membership and the site ceiling, not the team's enablement", async () => {
    let ceiling: EgressDecision = { allowed: true, pattern: "git.example.test" };
    let member = true;
    const registry = new TunnelRegistry(
      {
        decide: async () => ({ allowed: false, reason: "not_enabled" }),
        decideSite: async () => ceiling,
        isActiveMember: async () => member,
      },
      pino({ level: "silent" }),
    );
    const closed: string[] = [];
    const unregister = registry.register(
      {
        teamId: "t",
        userId: "u",
        host: "git.example.test",
        git: true,
        close: (reason) => void closed.push(reason),
      },
      Date.now() + 60_000,
    );
    expect(await registry.recheck({ kind: "team", teamId: "t" })).toBe(0);
    member = false;
    expect(await registry.recheck({ kind: "user", userId: "u" })).toBe(1);
    member = true;
    ceiling = { allowed: false, reason: "not_in_ceiling" };
    expect(await registry.recheck({ kind: "ceiling" })).toBe(1);
    expect(closed).toEqual(["inactive_member", "revoked"]);
    unregister();
  });
});
