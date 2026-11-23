import { describe, expect, it } from "vitest";
import { accessRefusal, reachableBase } from "./transport.js";

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

  it("applies G12: write needs Read and write, Contributor+, and editor on a Repo", () => {
    const conn = { accessLevel: "read_write" as const, agentIds: null, displayName: "Acme" };
    const push = "git-receive-pack" as const;
    const fetch = "git-upload-pack" as const;
    const facts = { role: "contributor" as const, projectRole: undefined, isRepo: false };
    expect(accessRefusal(facts, conn, push)).toBeUndefined();
    expect(accessRefusal({ ...facts, role: "member" }, conn, fetch)).toBeUndefined();
    expect(accessRefusal({ ...facts, role: "member" }, conn, push)).toMatchObject({
      code: "role_reader",
    });
    expect(accessRefusal({ ...facts, role: null }, conn, fetch)).toMatchObject({
      code: "role_reader",
    });
    expect(accessRefusal(facts, { ...conn, accessLevel: "read" }, push)).toMatchObject({
      code: "read_only",
    });
    expect(accessRefusal(facts, { ...conn, accessLevel: "read" }, fetch)).toBeUndefined();
    expect(accessRefusal(facts, { ...conn, accessLevel: "off" }, fetch)).toMatchObject({
      code: "connection_off",
    });
    expect(accessRefusal({ ...facts, isRepo: true }, conn, push)).toMatchObject({
      code: "project_reader",
    });
    expect(
      accessRefusal({ ...facts, isRepo: true, projectRole: "editor" }, conn, push),
    ).toBeUndefined();
    expect(
      accessRefusal({ ...facts, role: "team_admin", isRepo: true }, conn, push),
    ).toBeUndefined();
    expect(accessRefusal(facts, { ...conn, agentIds: ["a"] }, fetch)).toMatchObject({
      code: "agents_restricted",
    });
  });
});
