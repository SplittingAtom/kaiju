import type { NotebookExecError, NotebookExecStatus, NotebookOutput } from "@kaiju/protocol";

/**
 * The run log's error (KOBE-803, on `notebook.finished`): the exception's class name from the
 * execution's error output, and the line in the code that ran where it was raised when the
 * traceback says so. Read from the stored outputs, so it works for every agent version.
 *
 * IPython names the code an execution ran after its execution count: `Cell In[7], line 12`
 * (IPython 8+, also for a SyntaxError) or `"<ipython-input-7-…>", line 12` (older). Only frames of this execution's own count are this code
 * (a function defined by an earlier cell shows that cell's count); the innermost one wins. A
 * `.py` file runs as one execution, so its line is the file's line.
 */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const CELL = /Cell In\[(\d+)\], line (\d+)/g;
const OLD_INPUT = /<ipython-input-(\d+)-[0-9a-f]+>"?, line (\d+)/g;
const MAX_TRACEBACK_CHARS = 200_000;

export function execErrorOf(
  status: NotebookExecStatus,
  outputs: readonly NotebookOutput[],
  executionCount: number | null,
): NotebookExecError | undefined {
  if (status !== "error") return undefined;
  const error = outputs.findLast((o) => o.output_type === "error");
  if (error?.output_type !== "error") return undefined;
  const name = error.ename.trim().slice(0, 256);
  if (name === "") return undefined;
  const line = executionCount === null ? undefined : lineOf(error.traceback, executionCount);
  return line === undefined ? { name } : { name, line };
}

function lineOf(traceback: readonly string[], count: number): number | undefined {
  const text = traceback.join("\n").slice(0, MAX_TRACEBACK_CHARS).replace(ANSI, "");
  let line: number | undefined;
  for (const pattern of [CELL, OLD_INPUT]) {
    for (const m of text.matchAll(pattern)) {
      const at = Number(m[2]);
      if (Number(m[1]) === count && Number.isSafeInteger(at) && at > 0) line = at;
    }
    if (line !== undefined) return line;
  }
  return undefined;
}
