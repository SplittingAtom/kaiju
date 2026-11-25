import { describe, expect, it } from "vitest";
import { renamedNote, renamedNotes, renamedSince } from "./renamed-names";

describe("names recorded before the rename (KOBE-826)", () => {
  const segments = { kobe: "kaiju", kobe_git: "kaiju_git" };

  it("maps the built-in tools by the segments the upgrade recorded", () => {
    expect(renamedSince("mcp__kobe__docs_index", segments)).toBe("mcp__kaiju__docs_index");
    expect(renamedSince("mcp__kobe_git__git_comment", segments)).toBe(
      "mcp__kaiju_git__git_comment",
    );
    // A registered connector named `kobe` on a site whose built-in was `kobe-builtin`: no entry.
    expect(renamedSince("mcp__kobe__x", { kobe_builtin: "kaiju" })).toBeUndefined();
    expect(renamedSince("mcp__kobe__x", undefined)).toBeUndefined();
    expect(renamedSince("mcp__jira__x", segments)).toBeUndefined();
    expect(renamedSince(42, segments)).toBeUndefined();
  });

  it("maps the settings and deny codes whatever the segments", () => {
    expect(renamedSince("kobe_mcp_mode", undefined)).toBe("kaiju_mcp_mode");
    expect(renamedSince("kobe_admin_write", {})).toBe("kaiju_admin_write");
    expect(renamedSince("kaiju_mcp_mode", {})).toBeUndefined();
    expect(renamedSince("toString", {})).toBeUndefined();
  });

  it("words the note and lists every renamed value of an event", () => {
    expect(renamedNote("mcp__kobe__docs_page", segments)).toBe(
      "(before the rename; now mcp__kaiju__docs_page)",
    );
    expect(renamedNotes({ tool: "mcp__kobe__docs_page", value: "admin", n: 3 }, segments)).toEqual([
      {
        key: "tool",
        value: "mcp__kobe__docs_page",
        note: "(before the rename; now mcp__kaiju__docs_page)",
      },
    ]);
  });
});

describe("values recorded before the rename, known by their field (KOBE-831)", () => {
  it("maps Kaiju's publisher and the gallery agent's slug and key, nothing else", () => {
    const note = "(before the rename; now kaiju)";
    expect(renamedNotes({ publisher: "site", previousPublisher: "kobe" }, undefined)).toEqual([
      { key: "previousPublisher", value: "kobe", note },
    ]);
    expect(renamedNotes({ scope: "gallery", slug: "kobe", agentId: "a" }, {})).toEqual([
      { key: "slug", value: "kobe", note },
    ]);
    // A member's own agent may be called kobe: not renamed.
    expect(renamedNotes({ scope: "personal", slug: "kobe" }, {})).toEqual([]);
    expect(renamedNotes({ name: "kobe", value: "kobe" }, {})).toEqual([]);
    expect(renamedNote("kobe", undefined)).toBeUndefined();
  });
});
