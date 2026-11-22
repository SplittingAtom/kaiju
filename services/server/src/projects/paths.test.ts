import { describe, expect, it } from "vitest";
import { clashesInTree, fitsMount, isConflictCopy, mountPathOf } from "./paths.js";

/** KOBE-780: the path rules every project write shares (P2-8 mount length, P2-9, P2-43). */
describe("project path rules", () => {
  // Four 240-byte folders and a 60-byte name: 1024 bytes, a valid workspace path on its own.
  const longPath = [...Array.from({ length: 4 }, () => "a".repeat(240)), "b".repeat(60)].join("/");

  it("checks the mounted path projects/<slug>/<path>, not the relative path alone", () => {
    expect(Buffer.byteLength(longPath)).toBe(1024);
    expect(mountPathOf("my-project-slug", "docs/a.md")).toBe("projects/my-project-slug/docs/a.md");
    expect(fitsMount("my-project-slug", "docs/a.md")).toBe(true);
    expect(fitsMount("my-project-slug", longPath)).toBe(false);
    // Exactly 1024 bytes once mounted fits; one more byte does not.
    const room = 1024 - "projects/p/".length;
    const dirs = Array.from({ length: 4 }, () => "x".repeat(200)).join("/");
    expect(fitsMount("p", `${dirs}/${"y".repeat(room - dirs.length - 1)}`)).toBe(true);
    expect(fitsMount("p", `${dirs}/${"y".repeat(room - dirs.length)}`)).toBe(false);
    // The relative path's own rules still apply.
    expect(fitsMount("p", "../escape")).toBe(false);
    expect(fitsMount("p", "/abs")).toBe(false);
    expect(fitsMount("p", "")).toBe(false);
  });

  it("names only real sync conflict copies as conflict copies", () => {
    expect(isConflictCopy("notes.conflict-20261101T120000Z.md")).toBe(true);
    expect(isConflictCopy("docs/notes.conflict-20261101T120000Z-2.md")).toBe(true);
    expect(isConflictCopy("docs/README.conflict-20261101T120000Z")).toBe(true);
    // Ordinary names that merely contain ".conflict-" (P2-43).
    expect(isConflictCopy("notes.conflict-resolution.md")).toBe(false);
    expect(isConflictCopy("logs/merge.conflict-log.txt")).toBe(false);
    // Only the file name counts, not a folder.
    expect(isConflictCopy("a.conflict-20261101T120000Z/b.md")).toBe(false);
  });

  it("finds a file inside a file and a file where a folder is", () => {
    const tree = new Set(["docs", "src/app/main.ts"]);
    expect(clashesInTree(tree, "docs/a.md")).toBe(true);
    expect(clashesInTree(tree, "src/app")).toBe(true);
    expect(clashesInTree(tree, "src")).toBe(true);
    expect(clashesInTree(tree, "src/app/other.ts")).toBe(false);
    expect(clashesInTree(tree, "docs.md")).toBe(false);
    expect(clashesInTree(tree, "src/application")).toBe(false);
    // The exact path is a replace or `already_exists`, not a clash.
    expect(clashesInTree(tree, "docs")).toBe(false);
    expect(clashesInTree(new Map([["a/b", 1]]), "a")).toBe(true);
  });
});
