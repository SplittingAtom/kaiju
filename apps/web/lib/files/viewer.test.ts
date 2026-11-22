import { describe, expect, it } from "vitest";
import {
  canvasOutputScale,
  clampPage,
  findInItems,
  fitScale,
  parsePageInput,
  pdfErrorKind,
  safeLinkUrl,
  viewerKey,
  zoomIn,
  zoomOut,
  ZOOM_MAX,
  ZOOM_MIN,
} from "./viewer";

describe("zoom steps", () => {
  it("steps to the next preset in either direction, from any scale", () => {
    expect(zoomIn(1)).toBe(1.1);
    expect(zoomOut(1)).toBe(0.9);
    expect(zoomIn(1.03)).toBe(1.1);
    expect(zoomOut(1.03)).toBe(1);
    expect(zoomIn(ZOOM_MAX)).toBe(ZOOM_MAX);
    expect(zoomOut(ZOOM_MIN)).toBe(ZOOM_MIN);
    expect(zoomIn(0.01)).toBe(ZOOM_MIN);
  });
});

describe("fitScale", () => {
  const page = { width: 600, height: 800 };
  it("fit width uses the box width less the padding", () => {
    expect(fitScale("fit-width", page, { width: 1224, height: 500 }, 24)).toBe(2);
  });
  it("fit page uses the tighter of the two sides", () => {
    expect(fitScale("fit-page", page, { width: 1224, height: 424 }, 24)).toBe(0.5);
  });
  it("stays inside the zoom range and survives a zero-sized box", () => {
    expect(fitScale("fit-width", page, { width: 0, height: 0 }, 24)).toBe(ZOOM_MIN);
    expect(fitScale("fit-width", { width: 1, height: 1 }, { width: 9999, height: 9 }, 0)).toBe(
      ZOOM_MAX,
    );
  });
});

describe("pages", () => {
  it("clamps to the document", () => {
    expect(clampPage(0, 5)).toBe(1);
    expect(clampPage(9, 5)).toBe(5);
    expect(clampPage(3, 5)).toBe(3);
  });
  it("reads a typed page number; anything else is null", () => {
    expect(parsePageInput(" 3 ", 5)).toBe(3);
    expect(parsePageInput("12", 5)).toBe(5);
    expect(parsePageInput("0", 5)).toBe(1);
    expect(parsePageInput("two", 5)).toBeNull();
    expect(parsePageInput("", 5)).toBeNull();
    expect(parsePageInput("2.5", 5)).toBeNull();
  });
});

describe("findInItems", () => {
  it("finds matches across text items, ignoring case", () => {
    expect(findInItems(["Hello wor", "ld, hello"], "WORLD")).toEqual([
      { start: { item: 0, offset: 6 }, end: { item: 1, offset: 2 } },
    ]);
    expect(findInItems(["abcabc"], "bc")).toEqual([
      { start: { item: 0, offset: 1 }, end: { item: 0, offset: 3 } },
      { start: { item: 0, offset: 4 }, end: { item: 0, offset: 6 } },
    ]);
  });
  it("an empty or blank query finds nothing", () => {
    expect(findInItems(["abc"], "")).toEqual([]);
    expect(findInItems(["abc"], "   ")).toEqual([]);
  });
});

describe("safeLinkUrl (the chat's link rule)", () => {
  it("keeps absolute http, https and mailto links only", () => {
    expect(safeLinkUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(safeLinkUrl("mailto:a@b.c")).toBe("mailto:a@b.c");
    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "/relative", "data:x", "", 7]) {
      expect(safeLinkUrl(bad)).toBeNull();
    }
  });
});

describe("pdfErrorKind", () => {
  it("names a password, a broken file and anything else", () => {
    expect(pdfErrorKind({ name: "PasswordException" })).toBe("password");
    expect(pdfErrorKind({ name: "InvalidPDFException" })).toBe("invalid");
    expect(pdfErrorKind({ name: "FormatError" })).toBe("invalid");
    expect(pdfErrorKind(new Error("boom"))).toBe("other");
    expect(pdfErrorKind(null)).toBe("other");
  });
});

describe("canvasOutputScale", () => {
  it("follows the device pixel ratio, capped by the canvas area", () => {
    expect(canvasOutputScale(100, 100, 2)).toBe(2);
    expect(canvasOutputScale(100, 100, 0)).toBe(1);
    const s = canvasOutputScale(5000, 5000, 2);
    expect(5000 * s * 5000 * s).toBeLessThanOrEqual(16_777_216);
  });
});

describe("viewerKey", () => {
  const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }>) =>
    viewerKey({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods });
  it("reads Mod+F, Mod+=, Mod++, Mod+- and Mod+0 with Ctrl or Cmd", () => {
    expect(key("f", { ctrlKey: true })).toBe("find");
    expect(key("=", { metaKey: true })).toBe("zoom-in");
    expect(key("+", { ctrlKey: true })).toBe("zoom-in");
    expect(key("-", { ctrlKey: true })).toBe("zoom-out");
    expect(key("0", { metaKey: true })).toBe("fit");
  });
  it("ignores plain keys, Alt chords and other keys", () => {
    expect(key("f", {})).toBeNull();
    expect(key("f", { ctrlKey: true, altKey: true })).toBeNull();
    expect(key("k", { ctrlKey: true })).toBeNull();
  });
});
