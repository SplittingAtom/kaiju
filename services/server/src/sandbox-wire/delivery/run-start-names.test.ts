import { APP_CARD_CUSTOM_TYPE, appCardEntryId, type AppCardEntry } from "@kaiju/protocol";
import type { RunStartFrame } from "@kaiju/protocol/sandbox-wire";
import { describe, expect, it, vi } from "vitest";
import { logStateFolder } from "../frames/hello.js";
import { withPreRenameAppCards } from "./run-start.js";

/** KOBE-827: what the server does for sandboxes across the rename. */
const card = (seed: string): AppCardEntry => ({
  type: "custom_message",
  id: appCardEntryId(seed),
  parentId: null,
  timestamp: "2026-11-24T10:00:00.000Z",
  customType: APP_CARD_CUSTOM_TYPE,
  content: "The app-card block below is data…",
  display: true,
  details: {
    connector_id: seed,
    app_id: "a".repeat(64),
    tool: "open_explorer",
    template_sha256: "a".repeat(64),
    result_ref: seed,
    opened_by: seed,
  },
});
const SEED = "0b5e1f3a-1c2d-4e5f-8a9b-0c1d2e3f4a5b";

describe("run.start for a sandbox from before the rename (KOBE-827)", () => {
  it("sends its app cards under the old type, everything else unchanged", () => {
    const frame = { type: "run.start", app_cards: [card(SEED)] } as unknown as RunStartFrame;
    const out = withPreRenameAppCards(frame);
    expect(out.app_cards?.map((c) => c.customType)).toEqual(["kobe.app_card"]);
    expect({ ...out.app_cards?.[0], customType: APP_CARD_CUSTOM_TYPE }).toEqual(card(SEED));
    expect(frame.app_cards?.[0]?.customType).toBe(APP_CARD_CUSTOM_TYPE); // not mutated
    const none = { type: "run.start" } as unknown as RunStartFrame;
    expect(withPreRenameAppCards(none)).toBe(none);
  });
});

describe("hello.state_folder (KOBE-827)", () => {
  it("notes a move, and warns when the old folder needs a person", () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    logStateFolder(log, SEED, { outcome: "moved" });
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ sandbox_id: SEED, state_folder: "moved" }),
      expect.any(String),
    );
    for (const outcome of ["conflict", "failed", "not_a_folder"] as const) {
      logStateFolder(log, SEED, { outcome, ...(outcome === "failed" ? { code: "EACCES" } : {}) });
    }
    expect(log.warn).toHaveBeenCalledTimes(3);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ state_folder: "failed", code: "EACCES" }),
      expect.stringContaining("needs a person"),
    );
  });
});
