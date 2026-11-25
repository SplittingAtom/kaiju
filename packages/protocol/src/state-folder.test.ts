import { describe, expect, it } from "vitest";
import { appCardEntrySchema, appCardEntryId } from "./app-cards.js";
import { helloFrameSchema, parseKaijuModelError } from "./sandbox-wire/index.js";
import { isEntryType, swapStateFolderName } from "./state-folder.js";

/** KOBE-827: names stored before the rename stay readable; the folder's two names. */
describe("state folder and pre-rename names (KOBE-827)", () => {
  it("swaps the folder's name only where it is a whole path segment", () => {
    expect(swapStateFolderName("/workspace/.kaiju/repos/app")).toBe("/workspace/.kobe/repos/app");
    expect(swapStateFolderName("/workspace/.kobe/repos/**")).toBe("/workspace/.kaiju/repos/**");
    expect(swapStateFolderName(".kaiju")).toBe(".kobe");
    expect(swapStateFolderName("cd .kobe/repos && git push")).toBe("cd .kaiju/repos && git push");
    expect(swapStateFolderName("'/workspace/.kaiju'")).toBe("'/workspace/.kobe'");
    for (const other of [
      "notes.kobe",
      ".kobe-sync-x",
      ".kobex/a",
      "kaiju-moved/a",
      "x/a.kaiju.md",
    ]) {
      expect(swapStateFolderName(other)).toBeUndefined();
    }
    expect(swapStateFolderName("/workspace/report.md")).toBeUndefined();
  });

  it("reads entry types under their current and their pre-rename names, nothing else", () => {
    expect(isEntryType("kaiju.branch", "kaiju.branch")).toBe(true);
    expect(isEntryType("kobe.branch", "kaiju.branch")).toBe(true);
    expect(isEntryType("kobe.app_card", "kaiju.app_card")).toBe(true);
    expect(isEntryType("kobe.skipped_actions", "kaiju.skipped_actions")).toBe(true);
    expect(isEntryType("kobe.branch", "kaiju.app_card")).toBe(false);
    expect(isEntryType("evil.branch", "kaiju.branch")).toBe(false);
    expect(isEntryType(undefined, "kaiju.branch")).toBe(false);
  });

  it("accepts a stored app card of either type, and no other", () => {
    const card = {
      type: "custom_message",
      id: appCardEntryId("0123456789abcdef0123456789abcdef"),
      parentId: null,
      timestamp: "2026-11-24T10:00:00.000Z",
      content: "x",
      display: true,
      details: {
        connector_id: "6b6f6265-0000-4000-8000-000000000002",
        tool: "open",
        result_id: "7b6f6265-0000-4000-8000-000000000003",
      },
    };
    const parse = (customType: string) => appCardEntrySchema.safeParse({ ...card, customType });
    // Details shape aside, only the type is under test here.
    const typeIssue = (customType: string) =>
      parse(customType).error?.issues.some((i) => i.path[0] === "customType") ?? false;
    expect(typeIssue("kaiju.app_card")).toBe(false);
    expect(typeIssue("kobe.app_card")).toBe(false);
    expect(typeIssue("kaiju.branch")).toBe(true);
  });

  it("reads a model error code under the pre-rename prefix (sandboxes on the old image)", () => {
    expect(parseKaijuModelError("kaiju.model_error:model_throttled: x")).toBe("model_throttled");
    expect(parseKaijuModelError("kobe.model_error:model_throttled: x")).toBe("model_throttled");
    expect(parseKaijuModelError("kobex.model_error:model_throttled: x")).toBeUndefined();
  });

  it("hello carries the move's outcome strictly: an errno code, never a file name", () => {
    const hello = {
      v: 1,
      type: "hello",
      sandbox_id: "0b5e1f3a-1c2d-4e5f-8a9b-0c1d2e3f4a5b",
      agent_version: "1",
      pi_version: "1.4.0",
      runs: [],
    };
    expect(helloFrameSchema.safeParse(hello).success).toBe(true);
    expect(
      helloFrameSchema.safeParse({ ...hello, state_folder: { outcome: "moved" } }).success,
    ).toBe(true);
    expect(
      helloFrameSchema.safeParse({ ...hello, state_folder: { outcome: "failed", code: "EACCES" } })
        .success,
    ).toBe(true);
    for (const bad of [
      { outcome: "merged" },
      { outcome: "failed", code: "/workspace/.kobe/repos" },
      { outcome: "moved", path: "x" },
    ]) {
      expect(helloFrameSchema.safeParse({ ...hello, state_folder: bad }).success).toBe(false);
    }
  });
});
