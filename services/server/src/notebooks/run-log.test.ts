import type { NotebookOutput } from "@kobe/protocol";
import { describe, expect, it } from "vitest";
import { execErrorOf } from "./run-log.js";

const error = (ename: string, traceback: string[]): NotebookOutput => ({
  output_type: "error",
  ename,
  evalue: "x",
  traceback,
});
const stdout: NotebookOutput = { output_type: "stream", name: "stdout", text: "hi\n" };

// As IPython 8+ renders them, ANSI colours included.
const IPY = [
  "\u001b[31m---------------------------------------------------------------------------\u001b[39m",
  "\u001b[31mZeroDivisionError\u001b[39m                         Traceback (most recent call last)",
  "\u001b[36mCell\u001b[39m\u001b[36m \u001b[39m\u001b[32mIn[4]\u001b[39m\u001b[32m, line 9\u001b[39m",
  "Cell In[4], line 9\n      7 x = 1\n----> 9 f()\n",
  "Cell In[2], line 3, in f()\n      1 def f():\n----> 3     return 1 / 0\n",
  "Cell In[4], line 5, in g()\n----> 5     f()\n",
  "\u001b[31mZeroDivisionError\u001b[39m: division by zero",
];

describe("the run log's error (KOBE-803)", () => {
  it("names the exception and the innermost line of this execution's own code", () => {
    expect(execErrorOf("error", [stdout, error("ZeroDivisionError", IPY)], 4)).toEqual({
      name: "ZeroDivisionError",
      line: 5,
    });
  });

  it("ignores frames of other cells; no line when none is this execution's", () => {
    expect(execErrorOf("error", [error("ZeroDivisionError", IPY)], 7)).toEqual({
      name: "ZeroDivisionError",
    });
    expect(execErrorOf("error", [error("ValueError", ["tb"])], 1)).toEqual({ name: "ValueError" });
    expect(execErrorOf("error", [error("ValueError", IPY)], null)).toEqual({ name: "ValueError" });
  });

  it("reads a SyntaxError's line and the older ipython-input form", () => {
    const syntax = [
      "  Cell In[12], line 3\n    x = (\n        ^\n",
      "SyntaxError: incomplete input",
    ];
    expect(execErrorOf("error", [error("SyntaxError", syntax)], 12)).toEqual({
      name: "SyntaxError",
      line: 3,
    });
    const old = ['  File "<ipython-input-3-0a1b2c3d4e5f>", line 2\n    1/\n      ^'];
    expect(execErrorOf("error", [error("SyntaxError", old)], 3)).toEqual({
      name: "SyntaxError",
      line: 2,
    });
  });

  it("is absent unless the execution ended in error with an error output", () => {
    expect(execErrorOf("ok", [stdout], 1)).toBeUndefined();
    expect(execErrorOf("interrupted", [error("KeyboardInterrupt", [])], 1)).toBeUndefined();
    expect(execErrorOf("error", [stdout], 1)).toBeUndefined();
    expect(execErrorOf("error", [error("  ", [])], 1)).toBeUndefined();
  });
});
