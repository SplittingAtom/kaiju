import { describe, expect, it } from "vitest";
import { matchGitRequest, upstreamPath } from "./grammar.js";

const H = "http://git.example.test";

describe("git smart-HTTP grammar (KOBE-763)", () => {
  it("accepts the three endpoints, with and without .git and a base path", () => {
    expect(matchGitRequest("GET", `${H}/acme/app.git/info/refs?service=git-upload-pack`)).toEqual({
      kind: "git",
      request: {
        prefix: "",
        owner: "acme",
        repository: "app",
        service: "git-upload-pack",
        endpoint: "refs",
      },
    });
    expect(matchGitRequest("POST", `${H}/acme/app/git-receive-pack`)).toMatchObject({
      kind: "git",
      request: { repository: "app", service: "git-receive-pack", endpoint: "rpc" },
    });
    expect(
      matchGitRequest("GET", `${H}/forgejo/acme/app.git/info/refs?service=git-receive-pack`),
    ).toMatchObject({ kind: "git", request: { prefix: "/forgejo", owner: "acme" } });
    expect(matchGitRequest("POST", `${H}/a/b/acme/x.y-z_1.git/git-upload-pack`)).toMatchObject({
      kind: "git",
      request: { prefix: "/a/b", repository: "x.y-z_1" },
    });
  });

  it("leaves ordinary paths alone (no credential, ordinary egress)", () => {
    for (const url of [
      `${H}/`,
      `${H}/acme/app`,
      `${H}/api/v3/repos/acme/app`,
      `${H}/api/v1/repos/acme/app/contents/README.md`,
      `${H}/acme/app.git/HEAD`,
      `${H}/acme/app.git/objects/info/packs`,
    ]) {
      expect(matchGitRequest("GET", url)).toEqual({ kind: "not_git" });
    }
  });

  it("refuses non-canonical look-alikes instead of normalising them", () => {
    const refused = [
      ["GET", `${H}/acme/app.git/info/refs`], // dumb protocol
      ["GET", `${H}/acme/app.git/info/refs?service=git-upload-pack&x=1`],
      ["GET", `${H}/acme/app.git/info/refs?service=git-upload-archive`],
      ["POST", `${H}/acme/app.git/info/refs?service=git-upload-pack`],
      ["GET", `${H}/acme/app.git/git-upload-pack`],
      ["POST", `${H}/acme/app.git/git-receive-pack?service=x`],
      ["POST", `${H}/acme/../other/app.git/git-receive-pack`],
      ["POST", `${H}/acme/./app.git/git-receive-pack`],
      ["POST", `${H}/acme//app.git/git-receive-pack`],
      ["POST", `${H}/acme/app.git/git-receive-pack/`],
      ["POST", `${H}/acme/%61pp.git/git-receive-pack`],
      ["POST", `${H}/acme%2F..%2Fother/app.git/git-receive-pack`],
      ["POST", `${H}/acme/app.git/git-receive%2Dpack`],
      ["POST", `${H}/acme\\..\\other/app.git/git-receive-pack`],
      ["POST", `${H}/acme/app.git.git/git-receive-pack`],
      ["POST", `${H}/acme/..git/git-receive-pack`],
      ["POST", `${H}/-acme/app.git/git-receive-pack`],
      ["POST", `${H}/app.git/git-receive-pack`],
      ["POST", `${H}/a/b/c/d/e/f/g/h/i/acme/app.git/git-receive-pack`],
      ["GET", `${H}/acme/app.git/INFO/REFS?service=git-upload-pack`],
      ["POST", `${H}/acme/app.git/GIT-RECEIVE-PACK`],
      ["GET", `${H}/api?service=git-upload-pack`],
    ] as const;
    for (const [method, url] of refused) {
      expect(matchGitRequest(method, url), `${method} ${url}`).toMatchObject({ kind: "invalid" });
    }
  });

  it("builds the upstream path from canonical parts only", () => {
    expect(
      upstreamPath("/gitea", "Acme", "app", { service: "git-upload-pack", endpoint: "refs" }),
    ).toBe("/gitea/Acme/app.git/info/refs?service=git-upload-pack");
    expect(upstreamPath("", "acme", "app", { service: "git-receive-pack", endpoint: "rpc" })).toBe(
      "/acme/app.git/git-receive-pack",
    );
  });
});
