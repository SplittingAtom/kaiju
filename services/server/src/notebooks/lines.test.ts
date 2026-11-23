import { describe, expect, it } from "vitest";
import { selectLines } from "./lines.js";

/** KOBE-805: Run selection runs a range of the saved `.py` file's lines. */
describe("selectLines", () => {
  const file = "import os\n\ndef f():\n    x = 1\n    return x\n\nprint(f())\n";

  it("keeps the range, inclusive, 1-based", () => {
    expect(selectLines(file, { start: 1, end: 1 })).toBe("import os");
    expect(selectLines(file, { start: 3, end: 5 })).toBe("def f():\n    x = 1\n    return x");
  });

  it("removes the lines' common indentation, so a block from inside a function runs", () => {
    expect(selectLines(file, { start: 4, end: 5 })).toBe("x = 1\nreturn x");
    expect(selectLines("\tif a:\n\t\tb()\n", { start: 1, end: 2 })).toBe("if a:\n\tb()");
  });

  it("ignores blank lines when finding the indentation", () => {
    expect(selectLines("    a = 1\n\n    b = 2\n", { start: 1, end: 3 })).toBe("a = 1\n\nb = 2");
  });

  it("stops at the file's end; a range starting past it, or only blank lines, gives null", () => {
    expect(selectLines(file, { start: 7, end: 99 })).toBe("print(f())\n");
    expect(selectLines(file, { start: 9, end: 12 })).toBeNull();
    expect(selectLines(file, { start: 2, end: 2 })).toBeNull();
  });

  it("handles Windows line ends", () => {
    expect(selectLines("a = 1\r\n  b = 2\r\n", { start: 2, end: 2 })).toBe("b = 2");
  });
});
