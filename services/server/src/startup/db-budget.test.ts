import { describe, expect, it, vi } from "vitest";
import { checkConnectionBudget, connectionBudget } from "./db-budget.js";

const pool = (max: string) => ({
  query: vi.fn(() => Promise.resolve({ rows: [{ max_connections: max }] })),
});

describe("connection budget (KOBE-736)", () => {
  it("adds replicas x (pool + stream pool + listener) to the other components' connections", () => {
    // Chart defaults: 2 x (10 + 4 + 1) + scheduler 11 + gateway 22 + egress 11
    expect(
      connectionBudget({ serverReplicas: 2, poolMax: 10, streamPoolMax: 4, peerConnections: 44 }),
    ).toBe(74);
    expect(
      connectionBudget({ serverReplicas: 1, poolMax: 5, streamPoolMax: 2, peerConnections: 0 }),
    ).toBe(8);
  });

  it("warns when the budget exceeds max_connections minus 10", async () => {
    const warn = vi.fn();
    const result = await checkConnectionBudget(
      pool("80"),
      { serverReplicas: 2, poolMax: 10, streamPoolMax: 4, peerConnections: 44 },
      { warn, info: vi.fn() },
    );
    expect(result).toEqual({ budget: 74, maxConnections: 80, exceeded: true });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ budget: 74, maxConnections: 80, headroom: 10 }),
      "postgres connection budget exceeds max_connections",
    );
  });

  it("stays quiet within the limit", async () => {
    const warn = vi.fn();
    const result = await checkConnectionBudget(
      pool("100"),
      { serverReplicas: 2, poolMax: 10, streamPoolMax: 4, peerConnections: 44 },
      { warn, info: vi.fn() },
    );
    expect(result?.exceeded).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns nothing for an unreadable max_connections", async () => {
    const warn = vi.fn();
    const result = await checkConnectionBudget(
      pool("lots"),
      { serverReplicas: 1, poolMax: 10, streamPoolMax: 4, peerConnections: 0 },
      { warn, info: vi.fn() },
    );
    expect(result).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
