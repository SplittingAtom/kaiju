import { describe, expect, it } from "vitest";
import { MEMORY_INDEX_MAX_LINES } from "@kaiju/protocol";
import { appendLearned, fitsIndex, indexHasRoom, learnedLine } from "./learned.js";

describe("Add to project notes: the ## Learned section (KOBE-398)", () => {
  it("makes one list line of the statement (no line breaks, no heading)", () => {
    expect(learnedLine("  We ship\non   Tuesdays.  ")).toBe("- We ship on Tuesdays.");
    expect(learnedLine("## Not a heading")).toBe("- ## Not a heading");
  });

  it("starts the section at the end of a file without one", () => {
    expect(appendLearned("", "- A.")).toBe("## Learned\n\n- A.\n");
    expect(appendLearned("# Project\n\nIntro.\n", "- A.")).toBe(
      "# Project\n\nIntro.\n\n## Learned\n\n- A.\n",
    );
    expect(appendLearned("# Project", "- A.")).toBe("# Project\n\n## Learned\n\n- A.\n");
  });

  it("appends at the end of an existing section, before the next heading", () => {
    const before = "# P\n\n## Learned\n\n- A.\n\n## Links\n\n- x\n";
    expect(appendLearned(before, "- B.")).toBe(
      "# P\n\n## Learned\n\n- A.\n- B.\n\n## Links\n\n- x\n",
    );
  });

  it("keeps sub-headings inside the section and matches the heading case-insensitively", () => {
    const before = "## learned\n- A.\n### Detail\n- d\n";
    expect(appendLearned(before, "- B.")).toBe("## learned\n- A.\n### Detail\n- d\n- B.\n");
  });

  it("uses the first Learned section when there are two", () => {
    const before = "## Learned\n- A.\n# Other\n## Learned\n- C.\n";
    expect(appendLearned(before, "- B.")).toBe(
      "## Learned\n- A.\n- B.\n# Other\n## Learned\n- C.\n",
    );
  });

  it("knows when the index has room for one more line", () => {
    const full = Array.from({ length: MEMORY_INDEX_MAX_LINES }, (_, i) => `l${i}`).join("\n");
    expect(indexHasRoom("")).toBe(true);
    expect(indexHasRoom(full)).toBe(false);
    expect(indexHasRoom(full.split("\n").slice(1).join("\n"))).toBe(true);
  });

  it("neutralises a leading < and backticks so a renderer can't hide later lines", () => {
    expect(learnedLine("<!-- hidden")).toBe("- \\<!-- hidden");
    expect(learnedLine("```js fence")).toBe("- \\`\\`\\`js fence");
    expect(learnedLine("a < b and `x`")).toBe("- a < b and \\`x\\`");
  });

  it("does not count the trailing newline as a line (the cap is the full 200)", () => {
    const lines = (n: number) => `${Array.from({ length: n }, (_, i) => `l${i}`).join("\n")}\n`;
    expect(fitsIndex(lines(MEMORY_INDEX_MAX_LINES))).toBe(true);
    expect(fitsIndex(lines(MEMORY_INDEX_MAX_LINES + 1))).toBe(false);
    expect(indexHasRoom(lines(MEMORY_INDEX_MAX_LINES - 1))).toBe(true);
  });
});
