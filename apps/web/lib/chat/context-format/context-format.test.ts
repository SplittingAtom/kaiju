import { describe, expect, it } from "vitest";
import { formatJson, formatYaml } from "./data";
import { FORMAT_MAX_CHARS, formatText, lineText, segmentText, wrapLine } from "./index";
import { formatMarkup, markupModeOf, parseMarkup } from "./markup";
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
