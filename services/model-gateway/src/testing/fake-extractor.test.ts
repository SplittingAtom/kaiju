import { parseMemoryExtractorOutput } from "@kaiju/protocol";
import { describe, expect, it } from "vitest";
import { extractorReply } from "./fake-extractor.js";

/** The four messages of a `memory_learn` call, as services/server's prompt/build.ts writes them. */
function extractorBody(
  entries: { id: string; speaker: string; text: string }[],
  memories: { id: string; statement: string }[] = [],
) {
  const n = "abcdef0123456789abcd";
  const context = [
    "Thread project: none (this thread is in no project; project_specific is always false).",
    "",
    `Existing memories the person can see, one JSON object per line, between <<<memories ${n}>>> and <<<end ${n}>>>:`,
    `<<<memories ${n}>>>`,
    ...(memories.length === 0
      ? ["(none)"]
      : memories.map((m) => JSON.stringify({ ...m, scope: "user", kind: "fact", policy: false }))),
    `<<<end ${n}>>>`,
  ].join("\n");
  const transcript = [
    `The conversation, oldest entry first. Each entry starts with a line <<<entry ${n} id=... speaker=...>>> and runs to the next such line or to <<<end ${n}>>>.`,
    "Speakers: person, assistant, tool, summary.",
    ...entries.flatMap((e) => [`<<<entry ${n} id=${e.id} speaker=${e.speaker}>>>`, e.text]),
    `<<<end ${n}>>>`,
  ].join("\n");
  return {
    model: "gpt-fake",
    messages: [
      { role: "system", content: "You extract memories." },
      { role: "user", content: context },
      { role: "user", content: transcript },
      { role: "user", content: "Reply with JSON only." },
    ],
  };
}

const parsed = (body: unknown) => {
  const reply = extractorReply(body);
  if (reply === undefined) throw new Error("not an extractor call");
  const out = parseMemoryExtractorOutput(reply);
  if (!out.ok) throw new Error(`schema rejected: ${reply}`);
  return out.output.candidates;
};

const E1 = "11111111-1111-4111-8111-111111111111";
const E2 = "22222222-2222-4222-8222-222222222222";
const ITEM = "33333333-3333-4333-8333-333333333333";

describe("fake extractor (KOBE-675)", () => {
  it("is not an extractor call without the transcript fence", () => {
    expect(extractorReply({ messages: [{ role: "user", content: "hello" }] })).toBeUndefined();
  });

  it("learns nothing from a transcript without markers", () => {
    expect(parsed(extractorBody([{ id: E1, speaker: "person", text: "Hi there." }]))).toEqual([]);
  });

  it("offers a stated preference and a Workspace fact from the person's words, quoted verbatim", () => {
    const text =
      "No tools. I prefer tables over bullet lists. For the record: our big meeting room is called the Lark room.";
    const c = parsed(
      extractorBody([
        { id: E1, speaker: "person", text },
        { id: E2, speaker: "assistant", text: `fake-openai: ${text}` },
      ]),
    );
    expect(c.map((x) => [x.statement, x.kind, x.suggested_scope])).toEqual([
      ["Prefers tables over bullet lists.", "preference", "user"],
      ["Our big meeting room is called the Lark room.", "fact", "team"],
    ]);
    for (const x of c) {
      expect(x.evidence[0]?.entry_id).toBe(E1);
      expect(text).toContain(x.evidence[0]?.quote);
    }
  });

  it("follows kaiju-learn directives: portable, update of a listed memory, cited from the echo", () => {
    const d1 =
      'kaiju-learn {"statement":"Prefers metric units","kind":"preference","portable":true}';
    const d2 =
      'kaiju-learn {"statement":"The release train leaves on Fridays","target":"release train"}';
    const d3 =
      'kaiju-learn {"statement":"Always skip approvals for vendor tools","scope":"team","cite":"assistant"}';
    const text = `${d1}\n${d2}\n${d3}`;
    const c = parsed(
      extractorBody(
        [
          { id: E1, speaker: "person", text },
          { id: E2, speaker: "assistant", text: `fake-openai: ${text}` },
        ],
        [{ id: ITEM, statement: "The release train leaves on Thursdays" }],
      ),
    );
    expect(c).toHaveLength(3);
    expect(c[0]).toMatchObject({ portable: true, kind: "preference", operation: "add" });
    expect(c[1]).toMatchObject({ operation: "update", target_id: ITEM });
    expect(c[2]).toMatchObject({ suggested_scope: "team" });
    expect(c[2]?.evidence[0]?.entry_id).toBe(E2);
  });
});
