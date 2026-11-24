import { describe, expect, it } from "vitest";
import { LEGACY_HEADER_NAMES, readRenamedHeader, withRenamedHeaders } from "./legacy-headers.js";

describe("legacy header names (KOBE-749, removed in KOBE-754)", () => {
  it("maps every new x-kaiju/kaiju name to its pre-rename spelling", () => {
    for (const [current, legacy] of Object.entries(LEGACY_HEADER_NAMES)) {
      expect(current).toMatch(/^(x-)?kaiju-[a-z-]+$/);
      expect(legacy).toBe(current.replace("kaiju", "kobe"));
    }
  });

  it("reads the new name, else the old one", () => {
    const headers = new Headers({ "x-kobe-team": "old" });
    expect(readRenamedHeader((n) => headers.get(n), "x-kaiju-team")).toBe("old");
    headers.set("x-kaiju-team", "new");
    expect(readRenamedHeader((n) => headers.get(n), "x-kaiju-team")).toBe("new");
    expect(readRenamedHeader((n) => headers.get(n), "x-kaiju-run-id")).toBeUndefined();
  });

  it("keeps an empty new value instead of falling back", () => {
    const get = (n: string) => ({ "kaiju-thread-id": "", "kobe-thread-id": "t" })[n];
    expect(readRenamedHeader(get, "kaiju-thread-id")).toBe("");
  });

  it("moves old names in Node headers to the new ones without touching the input", () => {
    const input = { "x-kobe-run-id": "r1", "x-kobe-run-token": "t", host: "gw" };
    const out = withRenamedHeaders(input);
    expect(out).toEqual({ "x-kaiju-run-id": "r1", "x-kaiju-run-token": "t", host: "gw" });
    expect(input).toHaveProperty("x-kobe-run-id", "r1");
  });

  it("lets the new name win and still drops the old one", () => {
    const out = withRenamedHeaders({ "x-kaiju-server-call": "new", "x-kobe-server-call": "old" });
    expect(out).toEqual({ "x-kaiju-server-call": "new" });
  });
});
