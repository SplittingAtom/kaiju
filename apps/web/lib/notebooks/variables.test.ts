import { describe, expect, it } from "vitest";
import {
  clip,
  isSensitive,
  reprText,
  shownVariables,
  summaryOf,
  typeLabel,
  visibleText,
  type Variable,
} from "./variables";

const v = (name: string, extra: Partial<Variable> = {}): Variable => ({
  name,
  type: "int",
  repr: "1",
  ...extra,
});

describe("variables (KOBE-804)", () => {
  it("summarises DataFrames, arrays and containers", () => {
    expect(summaryOf(v("df", { shape: [3, 2], columnsTotal: 2 }))).toBe("3 rows × 2 columns");
    expect(summaryOf(v("a", { shape: [2, 2], dtype: "float64" }))).toBe("shape (2, 2) · float64");
    expect(summaryOf(v("s", { shape: [5], dtype: "int64", len: 5 }))).toBe("shape (5,) · int64");
    expect(summaryOf(v("l", { len: 4 }))).toBe("len 4");
    expect(summaryOf(v("x"))).toBe("");
  });

  it("names the type with its package when it adds something", () => {
    expect(typeLabel({ type: "ndarray", module: "numpy" })).toBe("numpy.ndarray");
    expect(typeLabel({ type: "Foo", module: "__main__" })).toBe("Foo");
    expect(typeLabel({ type: "int" })).toBe("int");
  });

  it("shows reprs as visible text: controls and bidi overrides escaped, cut with an ellipsis", () => {
    expect(visibleText("a‮b\u0007c\nd")).toBe("a\\u202eb\\u0007c\nd");
    expect(clip("abcdef", 4)).toBe("abc…");
    expect(clip("abc", 4)).toBe("abc");
    expect(reprText(v("x", { repr: "<b>x</b>" }), 80)).toBe("<b>x</b>");
    expect(reprText(v("x", { repr: "", reprError: "raised" }), 80)).toMatch(/raised/u);
    expect(reprText(v("x", { repr: "", reprError: "timeout" }), 80)).toMatch(/too long/u);
    expect(reprText(v("x", { repr: "", reprError: "not_read" }), 80)).toBe(
      "(value not shown for this type)",
    );
  });

  it("hides credential-like names and environment mappings until shown", () => {
    for (const name of ["API_KEY", "db_password", "token", "client_secret", "aws_credentials"]) {
      expect(isSensitive({ name, type: "str" }), name).toBe(true);
    }
    expect(isSensitive({ name: "env", type: "_Environ" })).toBe(true);
    expect(isSensitive({ name: "df", type: "DataFrame" })).toBe(false);
    for (const name of ["access_key", "key", "aws_key", "pwd", "dsn", "conn_str", "auth_header"]) {
      expect(isSensitive({ name, type: "str" }), name).toBe(true);
    }
    for (const name of ["author", "keyboard", "monkey"]) {
      expect(isSensitive({ name, type: "str" }), name).toBe(false);
    }
  });

  it("filters by name (any case) and sorts both ways", () => {
    const all = [v("beta"), v("Alpha"), v("gamma"), v("alphabet")];
    expect(shownVariables(all, "", "ascending").map((x) => x.name)).toEqual([
      "Alpha",
      "alphabet",
      "beta",
      "gamma",
    ]);
    expect(shownVariables(all, " ALPHA ", "descending").map((x) => x.name)).toEqual([
      "alphabet",
      "Alpha",
    ]);
  });
});
