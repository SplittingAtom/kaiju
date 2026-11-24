import { describe, expect, it } from "vitest";
import {
  aheadBehindText,
  conversionEndText,
  conversionProgressText,
  hostLink,
  mirrorStateText,
  proposedRepoName,
  readOnlyText,
  refusalText,
  repoBranch,
  repoNameProblem,
  repoSubtitle,
} from "./repo";
import type { RepoConversion, RepoMirror, RepoView, RepoWorkingCopy } from "./repo-api";

const mirror = (over: Partial<RepoMirror> = {}): RepoMirror => ({
  headSha: "a".repeat(40),
  refreshedAt: "2026-11-23T10:00:00.000Z",
  attemptedAt: "2026-11-23T10:00:00.000Z",
  refreshing: false,
  nextAttemptAt: null,
  failures: 0,
  error: null,
  tooLarge: false,
  ...over,
});

const repo = (over: Partial<RepoView> = {}): RepoView => ({
  projectId: "p1",
  repositoryId: "r1",
  connectionId: "c1",
  provider: "github",
  baseUrl: "https://github.com",
  fullName: "acme/q4-launch",
  webUrl: "https://github.com/acme/q4-launch",
  defaultBranch: "main",
  hostState: "active",
  readOnly: false,
  readOnlyReason: null,
  canManage: false,
  mirror: mirror(),
  commits: [],
  ...over,
});

const copy = (over: Partial<RepoWorkingCopy> = {}): RepoWorkingCopy => ({
  branch: "feature",
  headSha: "b".repeat(40),
  upstream: "origin/feature",
  ahead: 2,
  behind: 1,
  dirty: false,
  fetched: true,
  problem: null,
  reportedAt: "2026-11-23T10:00:00.000Z",
  ...over,
});

const conversion = (over: Partial<RepoConversion> = {}): RepoConversion => ({
  id: "x1",
  projectId: "p1",
  status: "running",
  step: "create",
  connectionId: "c1",
  provider: "github",
  baseUrl: "https://github.com",
  organization: "acme",
  repositoryName: "kaiju-q4",
  fullName: "acme/kaiju-q4",
  visibility: "private",
  carryHistory: true,
  useExisting: false,
  defaultBranch: "main",
  repositoryCreated: false,
  commitsTotal: 3,
  commitsPushed: 0,
  headSha: null,
  error: null,
  attempts: 1,
  requestedBy: "u1",
  createdAt: "2026-11-23T10:00:00.000Z",
  updatedAt: "2026-11-23T10:00:00.000Z",
  finishedAt: null,
  ...over,
});

describe("hostLink: only to the connection's own host (host strings are untrusted)", () => {
  it("keeps an https link on the connection's host", () => {
    expect(hostLink(repo())).toBe("https://github.com/acme/q4-launch");
    expect(
      hostLink(
        repo({
          baseUrl: "https://git.example.com:8443",
          webUrl: "https://git.example.com:8443/a/b",
        }),
      ),
    ).toBe("https://git.example.com:8443/a/b");
  });
  it("refuses another host, another scheme, credentials in the URL and junk", () => {
    for (const webUrl of [
      "https://evil.example/acme/q4",
      "javascript:alert(1)",
      "http://github.com/acme/q4",
      "https://user:pw@github.com/acme/q4",
      "https://github.com.evil.example/acme",
      "not a url",
      "",
    ]) {
      expect(hostLink(repo({ webUrl })), webUrl).toBeNull();
    }
  });
  it("normalises before comparing: backslash, default port, case, IDN; fails closed otherwise", () => {
    // A backslash is a slash for https: the host stays github.com.
    expect(hostLink(repo({ webUrl: "https://github.com\\@evil.example/x" }))).toBe(
      "https://github.com/@evil.example/x",
    );
    expect(hostLink(repo({ webUrl: "https://GitHub.com:443/acme/q4" }))).toBe(
      "https://github.com/acme/q4",
    );
    // Protocol-relative needs a base: refused.
    expect(hostLink(repo({ webUrl: "//github.com/acme/q4" }))).toBeNull();
    // A trailing dot is another host string: no link.
    expect(hostLink(repo({ webUrl: "https://github.com./acme/q4" }))).toBeNull();
    // IDN: both sides become punycode.
    const idn = { baseUrl: "https://gït.example" };
    expect(hostLink(repo({ ...idn, webUrl: "https://xn--gt-tja.example/a/b" }))).toBe(
      "https://xn--gt-tja.example/a/b",
    );
    expect(hostLink(repo({ ...idn, webUrl: "https://git.example/a/b" }))).toBeNull();
  });
  it("a plain-http connection may link over http to itself only", () => {
    const local = { baseUrl: "http://forgejo.local:3000" };
    expect(hostLink(repo({ ...local, webUrl: "http://forgejo.local:3000/a/b" }))).toBe(
      "http://forgejo.local:3000/a/b",
    );
    expect(hostLink(repo({ ...local, webUrl: "http://forgejo.local:3001/a/b" }))).toBeNull();
  });
});

describe("the row's words", () => {
  it("subtitle: host and organization/repository", () => {
    expect(repoSubtitle(repo())).toBe("github.com · acme/q4-launch");
  });
  it("branch: the working copy's when there is one, else the default branch", () => {
    expect(repoBranch(repo(), null)).toBe("main");
    expect(repoBranch(repo(), copy())).toBe("feature");
    expect(repoBranch(repo(), copy({ branch: null }))).toBe("detached");
  });
  it("ahead/behind", () => {
    expect(aheadBehindText(copy())).toEqual({ short: "↑2 ↓1", long: "2 ahead, 1 behind" });
    expect(aheadBehindText(copy({ ahead: 0, behind: 0 }))).toEqual({
      short: "✓",
      long: "up to date with the host",
    });
    expect(aheadBehindText(copy({ ahead: 1, behind: 0, dirty: true })).long).toBe(
      "1 ahead, uncommitted changes",
    );
    expect(aheadBehindText(copy({ fetched: false })).long).toContain("may be out of date");
  });
  it("read-only reasons in plain words", () => {
    expect(readOnlyText("archived")).toMatch(/archived on the host/);
    expect(readOnlyText("deleted")).toMatch(/no longer on the host/);
    expect(readOnlyText("connection_removed")).toMatch(/connection was removed/);
  });
});

describe("mirror state", () => {
  const now = Date.parse("2026-11-23T10:05:00.000Z");
  it("last refreshed, refreshing, never", () => {
    expect(mirrorStateText(mirror(), now)).toMatch(/^Last refreshed /);
    expect(mirrorStateText(mirror({ refreshing: true }), now)).toBe("Refreshing from the host…");
    expect(mirrorStateText(mirror({ refreshedAt: null }), now)).toBe("Not refreshed yet.");
  });
  it("too large and failures say what the server said", () => {
    expect(
      mirrorStateText(
        mirror({ tooLarge: true, error: { code: "too_many_files", message: "Too large: 500." } }),
        now,
      ),
    ).toContain("Too large: 500.");
    expect(
      mirrorStateText(
        mirror({
          error: { code: "credential_forbidden", message: "The credential may not read it." },
          nextAttemptAt: "2026-11-23T10:15:00.000Z",
        }),
        now,
      ),
    ).toMatch(/The credential may not read it\. Kaiju tries again /);
  });
});

describe("Convert to repo", () => {
  it("proposes the prefix and the slug", () => {
    expect(proposedRepoName("kaiju-", "q4-launch")).toBe("kaiju-q4-launch");
    expect(proposedRepoName(undefined, "q4-launch")).toBe("q4-launch");
  });
  it("checks the name like the server", () => {
    expect(repoNameProblem("kaiju-q4")).toBeNull();
    expect(repoNameProblem("")).toMatch(/Enter/);
    expect(repoNameProblem("a b")).toMatch(/letters, digits/);
    expect(repoNameProblem("a".repeat(101))).toMatch(/100/);
    expect(repoNameProblem("x.git")).toMatch(/\.git/);
  });
  it("progress and end states", () => {
    expect(conversionProgressText(conversion())).toBe("Creating the repository on the host…");
    expect(
      conversionProgressText(conversion({ step: "push", commitsPushed: 1, commitsTotal: 3 })),
    ).toBe("Pushing commits: 1 of 3…");
    expect(conversionProgressText(conversion({ step: "finish" }))).toBe("Finishing…");
    expect(conversionEndText(conversion({ status: "completed", step: "done" }))).toMatch(
      /is now a Repo/,
    );
    expect(
      conversionEndText(
        conversion({
          status: "failed",
          error: { code: "push_rejected", message: "The host refused.", detail: "too big" },
        }),
      ),
    ).toBe("The host refused. (too big)");
    expect(conversionEndText(conversion({ status: "abandoned" }))).toMatch(/abandoned/);
  });
  it("refusals: the server's words, the files it names, and the limits", () => {
    expect(
      refusalText({
        status: 422,
        code: "too_large_to_mirror",
        message: "The project's current files (300 MiB) are more than a Repo's mirror can show.",
      }),
    ).toMatch(/mirror can show/);
    expect(
      refusalText({
        status: 422,
        code: "file_rejected_by_host",
        message: "The git host would reject this file.",
        details: { paths: [{ path: ".gitmodules", seq: 2 }] },
      }),
    ).toBe("The git host would reject this file. Files: .gitmodules (commit #2).");
    // A generic fallback (no server words) still says what to do.
    expect(refusalText({ status: 503, code: "git_unavailable", message: "x" })).toBe("x");
    expect(
      refusalText({ status: 502, code: "server_error", message: "Kaiju had a problem." }),
    ).toBe("Kaiju had a problem.");
  });
});
