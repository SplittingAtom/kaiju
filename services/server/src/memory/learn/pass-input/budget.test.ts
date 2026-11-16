import { describe, expect, it } from "vitest";
import type { ExtractorTranscriptEntry } from "../prompt/input.js";
import { entryCost, fitTranscript, type BudgetCaps } from "./budget.js";
import type { TranscriptPiece } from "./transcript.js";

const turnOf = (id: string, chars: number, speaker: "person" | "assistant" = "person") =>
  ({
    kind: "turn",
    entry: { entry_id: id, speaker, text: "x".repeat(chars) },
  }) as const satisfies TranscriptPiece;
const compaction = (id: string, chars: number) =>
  ({
    kind: "compaction",
    entry: { entry_id: id, speaker: "summary", text: "s".repeat(chars) },
    firstKeptEntryId: null,
  }) as const satisfies TranscriptPiece;
const ids = (entries: readonly ExtractorTranscriptEntry[]) => entries.map((e) => e.entry_id);

/** Room for about four 400-char entries. */
const caps: BudgetCaps = { maxTokens: 4 * entryCost(turnOf("a", 400).entry).tokens, maxBytes: 1e9 };

describe("under the cap", () => {
  it("keeps every turn and leaves compaction summaries out", () => {
    const r = fitTranscript([turnOf("a", 100), compaction("c", 100), turnOf("b", 100)], caps);
    expect(ids(r.transcript)).toEqual(["a", "b"]);
    expect(r).toMatchObject({ truncated: false, summarised: false, omitted: 0 });
    expect(r.estimatedTokens).toBeGreaterThan(0);
  });
});

describe("over the cap (ac-2)", () => {
  it("uses the newest compaction summary and the newest turns, and flags it", () => {
    const pieces = [
      turnOf("a", 400),
      turnOf("b", 400),
      compaction("c1", 100),
      turnOf("d", 400),
      compaction("c2", 100),
      turnOf("e", 400),
      turnOf("f", 400),
      turnOf("g", 400),
    ];
    const r = fitTranscript(pieces, caps);
    expect(r.truncated).toBe(true);
    expect(r.summarised).toBe(true);
    // The summary first (oldest), then the tail that fits next to it, oldest first.
    expect(ids(r.transcript)).toEqual(["c2", "e", "f", "g"]);
    expect(r.omitted).toBe(3);
    expect(r.estimatedTokens).toBeLessThanOrEqual(caps.maxTokens);
  });

  it("keeps only the newest turns when there is no compaction", () => {
    const pieces = ["a", "b", "c", "d", "e", "f"].map((id) => turnOf(id, 400));
    const r = fitTranscript(pieces, caps);
    expect(ids(r.transcript)).toEqual(["c", "d", "e", "f"]);
    expect(r).toMatchObject({ truncated: true, summarised: false, omitted: 2 });
  });

  it("caps by bytes too", () => {
    const one = entryCost(turnOf("a", 400).entry).bytes;
    const r = fitTranscript(
      ["a", "b", "c"].map((id) => turnOf(id, 400)),
      { maxTokens: 1e9, maxBytes: 2 * one },
    );
    expect(ids(r.transcript)).toEqual(["b", "c"]);
    expect(r.truncated).toBe(true);
  });

  it("drops the summary when not even the newest turn fits beside it", () => {
    const r = fitTranscript([compaction("c", 1500), turnOf("a", 400), turnOf("b", 1500)], caps);
    expect(ids(r.transcript)).toEqual(["b"]);
    expect(r.summarised).toBe(false);
  });
});

describe("nothing to read", () => {
  it("answers an empty transcript", () => {
    expect(fitTranscript([], caps).transcript).toEqual([]);
  });
});
