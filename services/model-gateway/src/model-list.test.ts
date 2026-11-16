import { describe, expect, it } from "vitest";
import { filterModelList } from "./model-list.js";

describe("model list filter (KOBE-409 L4)", () => {
  it("keeps enabled entries and the rest of the document", () => {
    const out = filterModelList(
      Buffer.from(JSON.stringify({ object: "list", data: [{ id: "a/x" }, { id: "b/y" }, 3] })),
      new Set(["a/x"]),
    );
    expect(JSON.parse(String(out))).toEqual({ object: "list", data: [{ id: "a/x" }] });
  });

  it("refuses anything that is not a model list", () => {
    for (const text of ["nope", "[]", "null", JSON.stringify({ data: {} })]) {
      expect(filterModelList(Buffer.from(text), new Set())).toBeUndefined();
    }
  });
});
