import { describe, expect, it } from "vitest";
import { GIT_CONVERSION_STATUS_VALUES, GIT_CONVERSION_STEP_VALUES } from "@kaiju/db";
import {
  GIT_CONVERSION_FAILURES,
  GIT_CONVERSION_REFUSALS,
  GIT_CONVERSION_STATUSES,
  GIT_CONVERSION_STEPS,
} from "@kaiju/protocol";
import { GitHostError } from "../../git-hosts/adapter.js";
import { assertRepositoryEndpoint } from "../../git-hosts/git-wire.js";
import { conversionMessage } from "./notify.js";
import { ConversionStepError } from "./objects.js";
import { conversionIdentity, FORMER_MEMBER, gitMessage, parsePlan } from "./plan.js";
import { batchEnd, resumeIndex } from "./push.js";
import { FAILURE_MESSAGES, REFUSAL_STATUS, refusalMessage } from "./refusals.js";
import { failureOf } from "./runner.js";
import { defaultRepositoryName, hostRejectsPath } from "./start.js";

/** KOBE-765: the pure parts of Convert to repo. */
describe("value lists", () => {
  it("the protocol repeats the database's statuses and steps", () => {
    expect([...GIT_CONVERSION_STATUSES]).toEqual([...GIT_CONVERSION_STATUS_VALUES]);
    expect([...GIT_CONVERSION_STEPS]).toEqual([...GIT_CONVERSION_STEP_VALUES]);
  });
  it("every failure and refusal has its words and status", () => {
    for (const f of GIT_CONVERSION_FAILURES) expect(FAILURE_MESSAGES[f]).toMatch(/\.$/);
    for (const r of GIT_CONVERSION_REFUSALS) {
      expect(REFUSAL_STATUS[r]).toBeGreaterThanOrEqual(400);
      expect(refusalMessage({ code: r })).toMatch(/\.$/);
    }
  });
  it("refusals name the file, commit and counts", () => {
    expect(refusalMessage({ code: "file_rejected_by_host", path: "a/.git/x" })).toContain(
      "a/.git/x",
    );
    expect(
      refusalMessage({
        code: "file_too_large",
        paths: [{ path: "big.bin", seq: 3 }],
        limitBytes: 100 * 1024 * 1024,
      }),
    ).toContain("Git hosts refuse files over 100 MiB: big.bin (from commit #3). Remove it");
    expect(refusalMessage({ code: "unsaved_checkouts", checkouts: 2 })).toContain(
      "2 working copies",
    );
  });
});

describe("files the host would reject (G16)", () => {
  it.each([
    ".git/config",
    "a/.GIT/b",
    "x/.git",
    "a/.git./b",
    "a/.git /b",
    "GIT~1/x",
    "a/.g\u200cit/b",
  ])("refuses %s", (path) => expect(hostRejectsPath(path)).toBe(true));
  it.each([".gitignore", ".github/workflows/ci.yml", "a/git/b", "a/.gitkeep", "docs/.git-notes"])(
    "accepts %s",
    (path) => expect(hostRejectsPath(path)).toBe(false),
  );
  it("proposes the connection's prefix and the project's slug", () => {
    expect(defaultRepositoryName("kaiju-", "docs")).toBe("kaiju-docs");
    expect(defaultRepositoryName("", "docs")).toBe("docs");
  });
});

describe("authorship (G13, GQ10)", () => {
  const ada = {
    id: "8a1b0c2d-0000-4000-8000-000000000001",
    name: "Ada",
    email: "ada@x.test",
    left: false,
  };
  it("an active member: their Kaiju email, or the no-reply form when the Workspace says so", () => {
    expect(conversionIdentity(ada, ada.id, "member", "kaiju.test")).toEqual({
      author: { name: "Ada", email: "ada@x.test" },
      committer: { name: "Ada via Kaiju", email: "ada@x.test" },
    });
    const noreply = conversionIdentity(ada, ada.id, "noreply", "kaiju.test");
    expect(noreply.author.email).toMatch(/^[0-9a-f]{10}\+ada@users\.noreply\.kaiju\.test$/);
  });
  it("a member who left keeps the name, never the mailbox; an unknown one is a former member", () => {
    const left = conversionIdentity({ ...ada, left: true }, ada.id, "member", "kaiju.test");
    expect(left.author.name).toBe("Ada");
    expect(left.author.email).not.toContain("ada@x.test");
    expect(left.committer.name).toBe("Ada via Kaiju");
    const gone = conversionIdentity(undefined, ada.id, "member", "kaiju.test");
    expect(gone.author.name).toBe(FORMER_MEMBER);
    expect(gone.author.email).toMatch(/@users\.noreply\.kaiju\.test$/);
  });
  it("messages keep their text with one trailing newline", () => {
    expect(gitMessage("  Fix it\r\n\r\nBody  ")).toBe("Fix it\n\nBody\n");
    expect(gitMessage("   ")).toBe("Update\n");
  });
  it("a stored plan is read back strictly", () => {
    expect(() => parsePlan({ v: 2 })).toThrow();
    expect(() =>
      parsePlan({ v: 1, branch: "main", history: true, headCommitId: null, commits: [] }),
    ).toThrow();
  });
});

describe("push batches and resume", () => {
  it("groups commits by new content, at least one per batch", () => {
    expect(batchEnd([5, 5, 5], 0, 10)).toBe(2);
    expect(batchEnd([50, 1, 1], 0, 10)).toBe(1);
    expect(batchEnd([1, 1, 1], 1, 100)).toBe(3);
  });
  const built = { commits: ["a", "b", "c"], newBytes: [1, 1, 1], introduced: [[], [], []] };
  it("continues after the host's head, or from the start on an empty repository", () => {
    expect(resumeIndex(built, { head: null, refs: 0 })).toBe(0);
    expect(resumeIndex(built, { head: "b", refs: 1 })).toBe(2);
    expect(resumeIndex(built, { head: "c", refs: 1 })).toBe(3);
  });
  it("stops on a branch with other commits, or a repository with other refs", () => {
    expect(() => resumeIndex(built, { head: "z", refs: 1 })).toThrow(
      expect.objectContaining({ code: "repository_changed" }),
    );
    expect(() => resumeIndex(built, { head: null, refs: 2 })).toThrow(
      expect.objectContaining({ code: "repository_not_empty" }),
    );
  });
});

describe("failures as stored", () => {
  it("maps host errors to codes, never the host's text", () => {
    expect(
      failureOf(new GitHostError("auth_failed", "x", { reason: "credential_rejected" })),
    ).toEqual({
      code: "credential_rejected",
      detail: "credential_rejected",
    });
    expect(failureOf(new GitHostError("host_refused", "x", { reason: "site_git_off" })).code).toBe(
      "connection_unavailable",
    );
    expect(failureOf(new GitHostError("rate_limited", "x")).code).toBe("host_rate_limited");
    expect(failureOf(new ConversionStepError("content_missing", "a.txt"))).toEqual({
      code: "content_missing",
      detail: "a.txt",
    });
    expect(failureOf(new Error("boom")).code).toBe("internal_error");
  });
});

describe("the smart-HTTP endpoint rule", () => {
  const repo = new URL("https://git.example.test/sub/acme/app.git");
  it.each([
    "https://git.example.test/sub/acme/app.git/info/refs?service=git-receive-pack",
    "https://git.example.test/sub/acme/app.git/info/refs?service=git-upload-pack",
    "https://git.example.test/sub/acme/app.git/git-receive-pack",
  ])("allows %s", (u) => expect(() => assertRepositoryEndpoint(repo, new URL(u))).not.toThrow());
  it.each([
    "https://git.example.test/sub/acme/other.git/git-receive-pack",
    "https://git.example.test/sub/acme/app.git/objects/info/packs",
    "https://git.example.test/sub/acme/app.git/info/refs?service=git-receive-pack&x=1",
    "https://git.example.test/sub/acme/app.git/info/refs",
    "https://evil.example.test/sub/acme/app.git/git-receive-pack",
    "https://u:p@git.example.test/sub/acme/app.git/git-receive-pack",
    "https://git.example.test/sub/acme/app.git/git-receive-pack?x=1",
  ])("refuses %s", (u) =>
    expect(() => assertRepositoryEndpoint(repo, new URL(u))).toThrow(GitHostError),
  );
});

describe("the requester's email", () => {
  const base = {
    organization: "acme",
    repositoryName: "docs",
    baseUrl: "https://git.example.test",
    lastError: null,
    lastErrorDetail: null,
  };
  it("says where the history went, or why it stopped, without host text", () => {
    const done = conversionMessage({
      to: "a@x.test",
      appName: "Kaiju",
      projectName: "Docs",
      row: { ...base, status: "completed" },
      appUrl: "https://kaiju.test/",
    });
    expect(done.subject).toBe("Docs is now a Repo (Kaiju)");
    expect(done.text).toContain("acme/docs on git.example.test");
    const failed = conversionMessage({
      to: "a@x.test",
      appName: "Kaiju",
      projectName: "Docs",
      row: { ...base, status: "failed", lastError: "content_missing", lastErrorDetail: "a.txt" },
      appUrl: "https://kaiju.test/",
    });
    expect(failed.subject).toBe("Converting Docs to a Repo failed (Kaiju)");
    expect(failed.text).toContain(FAILURE_MESSAGES.content_missing);
    expect(failed.text).toContain("a.txt");
  });
});

describe("stale work directories", () => {
  it("removes only old conversion directories", async () => {
    const { mkdtemp, mkdir, utimes, readdir, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { removeStaleWorkDirs } = await import("./job.js");
    const root = await mkdtemp(path.join(tmpdir(), "kaiju-stale-test-"));
    try {
      await mkdir(path.join(root, "run-old"));
      await mkdir(path.join(root, "run-new"));
      await mkdir(path.join(root, "other-old"));
      const old = new Date(Date.now() - 7 * 3600_000);
      await utimes(path.join(root, "run-old"), old, old);
      await utimes(path.join(root, "other-old"), old, old);
      expect(await removeStaleWorkDirs(Date.now() - 6 * 3600_000, root)).toBe(1);
      expect((await readdir(root)).sort()).toEqual(["other-old", "run-new"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("visibility before every push (review H1)", () => {
  it("private always; internal only when asked and still allowed; public never", async () => {
    const { assertVisibility } = await import("./runner.js");
    const repo = (visibility: "private" | "internal" | "public") => ({
      visibility,
      fullName: "a/b",
    });
    expect(() => assertVisibility(repo("private"), "private", "private")).not.toThrow();
    expect(() => assertVisibility(repo("internal"), "internal", "internal")).not.toThrow();
    for (const [v, asked, allows] of [
      ["public", "private", "private"],
      ["public", "internal", "internal"],
      ["internal", "private", "internal"],
      ["internal", "internal", "private"],
    ] as const) {
      expect(() => assertVisibility(repo(v), asked, allows)).toThrow(
        expect.objectContaining({ code: "repository_public" }),
      );
    }
  });
  it("keeps a host's push refusal as one short line", async () => {
    const { hostReason } = await import("./push.js");
    expect(hostReason("unpack error\n  hasDotgit: contains '.git'\u0007")).toBe(
      "unpack error hasDotgit: contains '.git'",
    );
    expect(hostReason("x".repeat(500))?.length).toBe(200);
    expect(hostReason(undefined)).toBeNull();
  });
});

describe("receive-pack requests (round 2: streamed from disk)", () => {
  it("encodes entry sizes as git does and reads the host's report", async () => {
    const { entryHeader, parseReportStatus, pktLine } = await import("./pack.js");
    expect([...entryHeader(3, 10)]).toEqual([0x3a]);
    expect([...entryHeader(3, 100)]).toEqual([0xb4, 0x06]);
    expect([...entryHeader(1, 1 << 20)]).toEqual([0x90, 0x80, 0x80, 0x04]);
    expect(pktLine("ok\n").toString()).toBe("0007ok\n");
    const ref = "refs/heads/main";
    const report = (...lines: string[]) =>
      Buffer.concat([...lines.map((l) => pktLine(`${l}\n`)), Buffer.from("0000")]);
    expect(parseReportStatus(report("unpack ok", `ok ${ref}`), ref)).toEqual({ ok: true });
    expect(
      parseReportStatus(report("unpack ok", `ng ${ref} pre-receive hook declined`), ref),
    ).toEqual({
      ok: false,
      reason: "pre-receive hook declined",
      stale: false,
    });
    expect(parseReportStatus(report("unpack ok", `ng ${ref} stale info`), ref)).toMatchObject({
      stale: true,
    });
    expect(parseReportStatus(report("unpack index-pack abnormal exit"), ref)).toMatchObject({
      ok: false,
      stale: false,
    });
    expect(parseReportStatus(Buffer.from(""), ref).ok).toBe(false);
  });
});
