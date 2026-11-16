"use client";

import { visible } from "../../../lib/security/visible";

export type DiffPart = { readonly kind: "same" | "removed" | "added"; readonly text: string };

/** Word diff (longest common subsequence over words and spaces). Pure; short statements only. */
export function diffWords(before: string, after: string): DiffPart[] {
  const a = before.split(/(\s+)/).filter((w) => w !== "");
  const b = after.split(/(\s+)/).filter((w) => w !== "");
  const width = b.length + 1;
  const table = new Array<number>((a.length + 1) * width).fill(0);
  const lcs = (i: number, j: number) => table[i * width + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i -= 1)
    for (let j = b.length - 1; j >= 0; j -= 1)
      table[i * width + j] =
        a[i] === b[j] ? lcs(i + 1, j + 1) + 1 : Math.max(lcs(i + 1, j), lcs(i, j + 1));
  const out: DiffPart[] = [];
  const push = (kind: DiffPart["kind"], text: string | undefined) => {
    if (text === undefined) return;
    const last = out.at(-1);
    if (last?.kind === kind) out[out.length - 1] = { kind, text: last.text + text };
    else out.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push("same", a[i]);
      i += 1;
      j += 1;
    } else if (lcs(i + 1, j) >= lcs(i, j + 1)) {
      push("removed", a[i]);
      i += 1;
    } else {
      push("added", b[j]);
      j += 1;
    }
  }
  for (; i < a.length; i += 1) push("removed", a[i]);
  for (; j < b.length; j += 1) push("added", b[j]);
  return out;
}

/**
 * The inline diff of an update, supersede or conflict: the saved memory against the candidate.
 * Removed and added words are marked with `<del>`/`<ins>` (read out by screen readers) and with
 * a line, never by colour alone.
 */
export function StatementDiff({
  before,
  after,
}: {
  readonly before: string;
  readonly after: string;
}) {
  return (
    <p className="m-0 [overflow-wrap:anywhere] whitespace-pre-wrap" aria-label="Changes">
      {diffWords(visible(before), visible(after)).map((p, k) =>
        p.kind === "same" ? (
          <span key={k}>{p.text}</span>
        ) : p.kind === "removed" ? (
          <del key={k} className="text-status-failed">
            {p.text}
          </del>
        ) : (
          <ins key={k} className="text-status-done underline">
            {p.text}
          </ins>
        ),
      )}
    </p>
  );
}
