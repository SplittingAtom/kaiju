import { z } from "zod";

/**
 * Memory use for the cache replay (KOBE-658, e2e/fixtures/memory-cache/expect.json): did each
 * answer use the seeded memories it should have? A placement that saves cache by leaving memories
 * out (tool_only) shows here, not in the cache share.
 */
const patternSchema = z.string().refine((p) => {
  try {
    new RegExp(p, "i");
    return true;
  } catch {
    return false;
  }
}, "not a regular expression");

export const expectationsSchema = z.object({
  expect: z.array(z.array(patternSchema).min(1).nullable()),
});

export type Expectations = readonly (readonly RegExp[] | null)[];

export function parseExpectations(doc: unknown): Expectations {
  return expectationsSchema
    .parse(doc)
    .expect.map((ps) => (ps === null ? null : ps.map((p) => new RegExp(p, "i"))));
}

export interface MemoryUse {
  readonly scored: number;
  readonly used: number;
  readonly share: number;
  /** 1-based turns whose answer matched none of its patterns. */
  readonly missed: readonly number[];
}

export function memoryUse(expectations: Expectations, answers: readonly string[]): MemoryUse {
  const missed: number[] = [];
  let scored = 0;
  expectations.forEach((patterns, i) => {
    if (patterns === null) return;
    scored += 1;
    const answer = answers[i] ?? "";
    if (!patterns.some((p) => p.test(answer))) missed.push(i + 1);
  });
  const used = scored - missed.length;
  return { scored, used, share: scored === 0 ? 0 : used / scored, missed };
}

export function formatMemoryUse(u: MemoryUse): string {
  const missed = u.missed.length === 0 ? "" : `; missed turns: ${u.missed.join(", ")}`;
  return `memory use: ${u.used} of ${u.scored} scored turns (${(u.share * 100).toFixed(1)}%)${missed}`;
}
