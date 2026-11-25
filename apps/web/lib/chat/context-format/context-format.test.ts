import { describe, expect, it } from "vitest";
import { YAML_MAX_CHARS, formatJson, formatYaml, jsonDepth } from "./data";
import { FORMAT_MAX_CHARS, formatText, lineText, parseFence, segmentText, wrapLine } from "./index";
import { MAX_NODES, formatMarkup, markupModeOf, parseMarkup } from "./markup";
import type { FormattedLine } from "./tokens";

/** KOBE-841: the context viewer's readable formatting; untrusted text only ever becomes tokens. */
const texts = (lines: readonly FormattedLine[]) => lines.map(lineText);
const kinds = (lines: readonly FormattedLine[], kind: string) =>
  lines.flatMap((l) => l.filter((t) => t.kind === kind).map((t) => t.text));

describe("segmentText", () => {
  it("finds a whole JSON, XML, HTML or YAML text", () => {
    expect(segmentText('{"a": 1}').map((s) => s.kind)).toEqual(["json"]);
    expect(segmentText("<note><to>Tove</to></note>").map((s) => s.kind)).toEqual(["xml"]);
    expect(segmentText("<div><p>Hi</p></div>").map((s) => s.kind)).toEqual(["html"]);
    expect(segmentText("name: read\nversion: 2\n").map((s) => s.kind)).toEqual(["yaml"]);
  });

  it("finds front matter, fenced blocks and tagged blocks inside prose", () => {
    const text = [
      "---",
      "name: skill",
      "---",
      "Some prose.",
      "```yaml",
      "a: 1",
      "```",
      "<rules>",
      "Be brief.",
      "</rules>",
      "The end",
    ].join("\n");
    expect(segmentText(text).map((s) => s.kind)).toEqual(["yaml", "text", "yaml", "xml", "text"]);
  });

  it("leaves prose with inline tags as text (a chat message is not markup)", () => {
    expect(segmentText("<b>not bold</b> Hello there").map((s) => s.kind)).toEqual(["text"]);
    expect(segmentText("Use a < b and c > d").map((s) => s.kind)).toEqual(["text"]);
    expect(segmentText("Note: this is prose.").map((s) => s.kind)).toEqual(["text"]);
  });
});

describe("formatText", () => {
  it("pretty-prints XML as an indented tree", () => {
    expect(texts(formatText('<a x="1"><b>hi</b><c/></a>'))).toEqual([
      '<a x="1">',
      "  <b>hi</b>",
      "  <c />",
      "</a>",
    ]);
  });

  it("indents and colours YAML", () => {
    const lines = formatText("server:\n    port: 8080\n    name: 'kaiju'\n    on: true\n");
    expect(texts(lines)).toEqual(["server:", "  port: 8080", "  name: 'kaiju'", "  on: true"]);
    expect(kinds(lines, "key")).toEqual(["server", "port", "name", "on"]);
    expect(kinds(lines, "number")).toEqual(["8080"]);
    expect(kinds(lines, "string")).toEqual(["'kaiju'"]);
    expect(kinds(lines, "literal")).toEqual(["true"]);
  });

  it("pretty-prints JSON", () => {
    const lines = formatText('{"path":"a.txt","n":2,"ok":null}');
    expect(texts(lines)).toEqual(["{", '  "path": "a.txt",', '  "n": 2,', '  "ok": null', "}"]);
    expect(kinds(lines, "key")).toEqual(['"path"', '"n"', '"ok"']);
  });

  it("keeps a system prompt section's tags and formats its body", () => {
    const lines = formatText("<rules>\n    - Be brief.\n    - Cite sources.\n</rules>");
    expect(texts(lines)).toEqual(["<rules>", "  - Be brief.", "  - Cite sources.", "</rules>"]);
    expect(kinds(lines, "tag")).toEqual(["rules", "rules"]);
  });

  it("shows fences around a formatted block", () => {
    expect(texts(formatText('Intro\n```json\n{"a":1}\n```'))).toEqual([
      "Intro",
      "```json",
      "{",
      '  "a": 1',
      "}",
      "```",
    ]);
  });

  it("falls back to the exact text when a block does not parse", () => {
    expect(texts(formatText('{"a": 1,}'))).toEqual(['{"a": 1,}']);
    expect(texts(formatText("<a><b></a>"))).toEqual(["<a>", "  <b></b>", "</a>"]); // HTML: lenient
    expect(texts(formatText("key: [unclosed\nother: 1"))).toEqual(["key: [unclosed", "other: 1"]);
    expect(texts(formatText("<x:y>\n<!-- open\n</x:y>"))).toEqual(["<x:y>", "<!-- open", "</x:y>"]);
  });

  it("returns a very long text plain, line for line", () => {
    const long = `{"a": "${"x".repeat(FORMAT_MAX_CHARS)}"}`;
    expect(texts(formatText(long))).toEqual([long]);
  });
});

describe("malicious markup stays text", () => {
  it("shows a script's body as text, never as an element to run", () => {
    const lines = formatText('<div><script>alert("x")</script><p onclick="steal()">Hi</p></div>');
    expect(texts(lines)).toEqual([
      "<div>",
      '  <script>alert("x")</script>',
      '  <p onclick="steal()">Hi</p>',
      "</div>",
    ]);
    // The handler is an attribute token with a string value: text, never wired up.
    expect(kinds(lines, "attr")).toEqual(["onclick"]);
    expect(kinds(lines, "string")).toEqual(['"steal()"']);
  });

  it("keeps a javascript: URL and an image source as quoted text", () => {
    const lines = formatText(
      '<p><a href="javascript:alert(1)">x</a><img src="https://e.test/t.png"></p>',
    );
    expect(kinds(lines, "string")).toEqual(['"javascript:alert(1)"', '"https://e.test/t.png"']);
  });

  it("never resolves an external entity: the DOCTYPE is shown, the reference stays as written", () => {
    const xxe = [
      '<?xml version="1.0"?>',
      '<!DOCTYPE foo [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>',
      "<foo>&xxe;</foo>",
    ].join("\n");
    const lines = formatText(xxe);
    expect(texts(lines)).toEqual([
      '<?xml version="1.0"?>',
      '<!DOCTYPE foo [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>',
      "<foo>&xxe;</foo>",
    ]);
    expect(kinds(lines, "meta")).toHaveLength(2);
  });

  it("does not decode character references", () => {
    expect(texts(formatText("<a>&lt;script&gt;</a>"))).toEqual(["<a>&lt;script&gt;</a>"]);
  });

  it("refuses a tree deeper than the cap (plain text instead)", () => {
    const deep = `${"<a>".repeat(80)}x${"</a>".repeat(80)}`;
    expect(parseMarkup(deep, "xml")).toBeNull();
    expect(texts(formatText(deep))).toEqual([deep]);
  });

  it("YAML: custom tags and aliases are printed, never run or expanded", () => {
    const lines = formatYaml("a: &x [1, 2]\nb: *x\nc: !!js/function 'f'\n");
    expect(lines).not.toBeNull();
    const out = texts(lines ?? []).join("\n");
    expect(out).toContain("*x");
    expect(out).toContain("!!js/function");
  });
});

describe("helpers", () => {
  it("formatMarkup refuses unbalanced XML", () => {
    expect(formatMarkup("<a><b></a>", "xml")).toBeNull();
    expect(formatMarkup("just text", "xml")).toBeNull();
  });

  it("markupModeOf reads the doctype or the first element", () => {
    expect(markupModeOf("<!DOCTYPE html><html></html>")).toBe("html");
    expect(markupModeOf("<rules>x</rules>")).toBe("xml");
    expect(markupModeOf("<span>x</span>")).toBe("html");
  });

  it("formatJson refuses a scalar and bad JSON", () => {
    expect(formatJson("42")).toBeNull();
    expect(formatJson("{nope}")).toBeNull();
  });

  it("formatYaml refuses a lone scalar", () => {
    expect(formatYaml("just words")).toBeNull();
  });

  it("wrapLine cuts tokens at the column", () => {
    const wrapped = wrapLine(
      [
        { kind: "key", text: "abcd" },
        { kind: "string", text: "efgh" },
      ],
      3,
    );
    expect(texts(wrapped)).toEqual(["abc", "def", "gh"]);
    expect(wrapped[1]?.map((t) => t.kind)).toEqual(["key", "string"]);
  });
});

/** Elapsed milliseconds of `fn`. */
function timed(fn: () => unknown): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

describe("hostile input never breaks or stalls the panel", () => {
  it("deeply nested JSON falls back to plain text instead of overflowing the stack", () => {
    const deep = `${"[".repeat(10_000)}${"]".repeat(10_000)}`;
    expect(jsonDepth(deep)).toBe(10_000);
    expect(formatJson(deep)).toBeNull();
    expect(texts(formatText(deep))).toEqual([deep]);
    const fenced = `Look:\n\`\`\`json\n${'{"a":'.repeat(5_000)}1${"}".repeat(5_000)}\n\`\`\``;
    expect(() => formatText(fenced)).not.toThrow();
    expect(jsonDepth('{"a": "[[[[", "b": [1]}')).toBe(2); // brackets in strings do not count
  });

  it("caps the node count", () => {
    const many = `<r>${"<a/>".repeat(MAX_NODES + 1)}</r>`;
    expect(parseMarkup(many, "xml")).toBeNull();
    expect(parseMarkup(`<r>${"<a/>".repeat(100)}</r>`, "xml")).not.toBeNull();
  });

  it("prints a billion-laughs YAML as references, quickly", () => {
    const lines = ['a: &a ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]'];
    for (const [k, prev] of [
      ["b", "a"],
      ["c", "b"],
      ["d", "c"],
      ["e", "d"],
      ["f", "e"],
      ["g", "f"],
      ["h", "g"],
      ["i", "h"],
    ]) {
      lines.push(`${k}: &${k} [${Array(9).fill(`*${prev}`).join(",")}]`);
    }
    let out: FormattedLine[] | null = null;
    expect(timed(() => (out = formatYaml(lines.join("\n"))))).toBeLessThan(200);
    const printed = texts(out ?? []).join("\n");
    expect(printed).toContain("*h");
    expect(printed.length).toBeLessThan(5_000);
  });

  it("reads hostile fence lines in linear time (no regex backtracking)", () => {
    for (const line of [
      `\`\`\`${" ".repeat(65_000)}!`,
      `\`\`\`${"\t".repeat(65_000)}-!`,
      `~~~${" ".repeat(30_000)}a${" ".repeat(30_000)}!`,
    ]) {
      expect(parseFence(line)).toBeNull();
      expect(timed(() => segmentText(`intro\n${line}\nend`))).toBeLessThan(50);
    }
    expect(parseFence("  ```yaml  ")).toEqual({ marker: "```", lang: "yaml" });
  });

  it("finds blocks in linear time when openers never close", () => {
    const tags = Array(16_000).fill("<a>").join("\n");
    expect(timed(() => segmentText(tags))).toBeLessThan(100);
    const fences = Array(8_000).fill("```yaml").join("\n");
    expect(timed(() => segmentText(fences))).toBeLessThan(100);
  });

  it("lexes unclosed quotes, close tags and many raw-text elements quickly", () => {
    const cap = FORMAT_MAX_CHARS - 16;
    for (const body of [
      '<a b="'.repeat(cap / 6),
      "</a ".repeat(cap / 4),
      "<script></script>".repeat(cap / 17),
      "<".repeat(cap),
    ]) {
      expect(timed(() => formatText(`<p>${body}</p>`))).toBeLessThan(100);
    }
  });

  it("never throws and stays fast on random markup-ish input", () => {
    const parts = [
      "<",
      ">",
      "</",
      "/>",
      "[",
      "]",
      "{",
      "}",
      '"',
      "'",
      "```",
      "~~~",
      "---",
      "\n",
      " ",
      "\t",
      "a",
      "x:",
      "- ",
      "&",
      "<!--",
      "-->",
      "<![CDATA[",
      "<!DOCTYPE",
      "<?",
      "?>",
      "=",
      "*a",
      "&a ",
    ];
    let seed = 841;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed;
    };
    for (let n = 0; n < 300; n++) {
      const text = Array.from(
        { length: 1 + (next() % 400) },
        () => parts[next() % parts.length],
      ).join("");
      let ms = 0;
      expect(() => (ms = timed(() => formatText(text)))).not.toThrow();
      expect(ms).toBeLessThan(100);
    }
  });

  it("formats a full 64 KiB section well within a frame budget; long YAML stays plain", () => {
    const xml = `<root>${'<item id="1"><name>kaiju</name><v>2</v></item>\n'.repeat(1_200)}</root>`;
    expect(xml.length).toBeLessThan(FORMAT_MAX_CHARS);
    expect(timed(() => formatText(xml))).toBeLessThan(100);
    const yaml = "key: value\nlist:\n  - 1\n  - two\n".repeat(1_400);
    const small = yaml.slice(0, YAML_MAX_CHARS - 1);
    expect(timed(() => formatText(small))).toBeLessThan(100);
    const big = yaml.slice(0, FORMAT_MAX_CHARS - 1);
    expect(formatYaml(big)).toBeNull();
    expect(timed(() => formatText(big))).toBeLessThan(50);
  });
});
