import { workspaceCommitRequestSchema } from "@kobe/protocol/sandbox-wire";
import { describe, expect, it } from "vitest";
import { toWire } from "./push.js";
import type { PlannedChange } from "./state.js";

/** The commit body is exactly the contract (strict schema): planning fields never leak. */
describe("toWire", () => {
  it("drops the agent's own planning fields from puts and deletes", () => {
    const put: PlannedChange = {
      op: "put",
      path: "reports/q3.md",
      base_rev: null,
      sha256: "a".repeat(64),
      size: 7,
      mtime_ms: 1,
      executable: false,
      local: { size: 7, mtimeMs: 1, executable: false },
      verifiable: true,
    };
    const del: PlannedChange = { op: "delete", path: "old.md", base_rev: 3 };
    const body = { changes: [toWire(put), toWire(del)] };
    expect(workspaceCommitRequestSchema.safeParse(body).success).toBe(true);
    expect(Object.keys(body.changes[0] ?? {}).sort()).toEqual(
      ["base_rev", "executable", "mtime_ms", "op", "path", "sha256", "size"].sort(),
    );
    // What the bug sent: the strict schema refuses it.
    const { local: _l, ...leaky } = put;
    expect(workspaceCommitRequestSchema.safeParse({ changes: [leaky] }).success).toBe(false);
  });
});
