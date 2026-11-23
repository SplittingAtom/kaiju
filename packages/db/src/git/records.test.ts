import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { gitConnections } from "../schema/git.js";
import {
  gitCapabilitiesForStorage,
  gitConnectionPublicColumns,
  toGitConnectionRecord,
} from "./records.js";

describe("git connection public shape (KOBE-757, review M2)", () => {
  it("is every column except the sealed credential and its key id", () => {
    const all = Object.keys(getTableColumns(gitConnections)).sort();
    const secret = ["credentialKeyId", "credentialSealed"];
    expect(Object.keys(gitConnectionPublicColumns).sort()).toEqual(
      all.filter((c) => !secret.includes(c)),
    );
    for (const s of secret) expect(Object.keys(gitConnectionPublicColumns)).not.toContain(s);
    const names = Object.values(gitConnectionPublicColumns).map((c) => c.name);
    expect(names).not.toContain("credential_sealed");
    expect(names).not.toContain("credential_key_id");
  });

  it("validates capabilities on write and on read", () => {
    const ok = { create: "yes", read: "yes", write: "unknown", admin: "no" };
    expect(gitCapabilitiesForStorage(ok)).toEqual(ok);
    expect(() => gitCapabilitiesForStorage({ ...ok, create: true })).toThrow();
    expect(() => gitCapabilitiesForStorage({ ...ok, extra: "yes" })).toThrow();
    const row = { capabilities: { createRepositories: true }, excessPermissions: [] };
    expect(() => toGitConnectionRecord(row as never)).toThrow(
      "a stored git connection has an invalid shape",
    );
  });
});
