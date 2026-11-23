import { describe, expect, it } from "vitest";
import type { projectPermissions } from "@kobe/protocol";
import { accessRefusal, reachableBase, repoReadable, repoRefusal } from "./transport.js";

describe("git transport rules (KOBE-763)", () => {
  it("matches only base URLs the proxy can reach: https on 443", () => {
    expect(reachableBase("https://github.com")).toEqual({ host: "github.com", path: "" });
    expect(reachableBase("https://Git.Example.test:443/forgejo/")).toEqual({
      host: "git.example.test",
      path: "/forgejo",
    });
    expect(reachableBase("https://git.example.test:8443")).toBeUndefined();
    expect(reachableBase("http://git.example.test")).toBeUndefined();
    expect(reachableBase("not a url")).toBeUndefined();
  });

  it("applies G12: write needs Read and write and Contributor+; a Repo needs editor too", () => {
    const conn = { accessLevel: "read_write" as const, agentIds: null, displayName: "Acme" };
    const push = "git-receive-pack" as const;
    const fetch = "git-upload-pack" as const;
    expect(accessRefusal({ role: "contributor" }, conn, push)).toBeUndefined();
    expect(accessRefusal({ role: "member" }, conn, fetch)).toBeUndefined();
    expect(accessRefusal({ role: "member" }, conn, push)).toMatchObject({ code: "role_reader" });
    expect(accessRefusal({ role: null }, conn, fetch)).toMatchObject({ code: "role_reader" });
    expect(
      accessRefusal({ role: "contributor" }, { ...conn, accessLevel: "read" }, push),
    ).toMatchObject({
      code: "read_only",
    });
    expect(
      accessRefusal({ role: "contributor" }, { ...conn, accessLevel: "read" }, fetch),
    ).toBeUndefined();
    expect(
      accessRefusal({ role: "contributor" }, { ...conn, accessLevel: "off" }, fetch),
    ).toMatchObject({
      code: "connection_off",
    });
    expect(
      accessRefusal({ role: "contributor" }, { ...conn, agentIds: ["a"] }, fetch),
    ).toMatchObject({
      code: "agents_restricted",
    });
    // Not a Repo: nothing more. A Repo (one or several matching rows): editor on every one.
    expect(repoRefusal("contributor", [])).toBeUndefined();
    expect(repoRefusal("contributor", [{ projectRole: undefined }])).toMatchObject({
      code: "project_reader",
    });
    expect(repoRefusal("contributor", [{ projectRole: "editor" }])).toBeUndefined();
    expect(
      repoRefusal("contributor", [{ projectRole: "editor" }, { projectRole: undefined }]),
    ).toMatchObject({ code: "project_reader" });
    expect(repoRefusal("team_admin", [{ projectRole: undefined }])).toBeUndefined();
  });
});

describe("repoReadable (M4, owner decision 2026-11-22)", () => {
  const rules = [
    { hostRepoId: "42", fullName: "acme/docs", projectRole: undefined },
    { hostRepoId: "77", fullName: "acme/legacy", projectRole: "editor" as const },
  ];
  const noView = () => ({ view: false }) as ReturnType<typeof projectPermissions>;

  it("lets a role on the project read, matched by id and by name", () => {
    expect(repoReadable("member", rules, { id: "42", fullName: "acme/renamed" })).toBe(true);
    expect(repoReadable("member", rules, { id: "9", fullName: "ACME/legacy" })).toBe(true);
  });

  it("refuses without a role on the project, by id (rename) and by name (stale id)", () => {
    expect(repoReadable("member", rules, { id: "42", fullName: "acme/renamed" }, noView)).toBe(
      false,
    );
    expect(repoReadable("member", rules, { id: "9", fullName: "acme/docs" }, noView)).toBe(false);
  });

  it("leaves repositories that are no Repo alone", () => {
    expect(repoReadable("member", rules, { id: "5", fullName: "acme/app" }, noView)).toBe(true);
  });
});
