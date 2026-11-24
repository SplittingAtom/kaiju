import { mkdir, mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GIT_MIRROR_FAILURES, GIT_REPO_HOST_STATES } from "@kaiju/protocol";
import { GIT_REPOSITORY_HOST_STATE_VALUES } from "@kaiju/db";
import { GitHostError } from "../../git-hosts/adapter.js";
import { REFUSAL_STATUS, refusalMessage } from "../conversion/refusals.js";
import {
  GIT_REPO_MAX_CONTENT_BYTES,
  GIT_REPO_MAX_FILE_BYTES,
  GIT_REPO_MAX_FILES,
  mirrorFetchLimits,
  repoContentRefusal,
} from "../repo-limits.js";
import { MirrorHeld } from "./apply.js";
import { removeStaleWorkDirs } from "./job.js";
import { MirrorError } from "./fetch.js";
import {
  GIT_MIRROR_BACKOFF_MAX_MS,
  GIT_MIRROR_MAX_BYTES,
  GIT_MIRROR_MAX_FILE_BYTES,
  GIT_MIRROR_MAX_FILES,
  GIT_MIRROR_MAX_PACK_BYTES,
  mirrorBackoffMs,
} from "./limits.js";
import { failureOf } from "./refresh.js";
import { failureView, MIRROR_FAILURE_MESSAGES, readOnlyReason } from "./store.js";

/** KOBE-766: the mirror's back-off, failure codes, read-only reasons and pack header sizes. */
describe("back-off (ac-2)", () => {
  it("doubles from 5 minutes to 6 hours", () => {
    expect(mirrorBackoffMs(1)).toBe(5 * 60_000);
    expect(mirrorBackoffMs(2)).toBe(10 * 60_000);
    expect(mirrorBackoffMs(3)).toBe(20 * 60_000);
    expect(mirrorBackoffMs(50)).toBe(GIT_MIRROR_BACKOFF_MAX_MS);
  });

  it("maps failures to codes; a rate limit waits for the host's reset; the budget is no failure", () => {
    const now = 1_000_000;
    expect(failureOf(new GitHostError("host_unreachable", "x"), 0, now)).toEqual({
      code: "host_unreachable",
      counts: true,
      nextAt: new Date(now + 5 * 60_000),
    });
    const reset = new Date(now + 60 * 60_000);
    expect(
      failureOf(new GitHostError("rate_limited", "x", { resetAt: reset }), 0, now).nextAt,
    ).toEqual(reset);
    expect(failureOf(new GitHostError("auth_failed", "x"), 2, now)).toMatchObject({
      code: "credential_rejected",
      nextAt: new Date(now + 20 * 60_000),
    });
    expect(failureOf(new GitHostError("forbidden", "x"), 0).code).toBe("credential_forbidden");
    expect(failureOf(new GitHostError("host_refused", "x"), 0).code).toBe("host_not_allowed");
    expect(failureOf(new MirrorError("too_many_files"), 0).code).toBe("too_many_files");
    expect(failureOf(new MirrorHeld(), 0).code).toBe("legal_hold");
    expect(failureOf(new Error("boom"), 0).code).toBe("internal_error");
  });

  it("has a message for every failure and maps unknown codes to internal_error", () => {
    for (const code of GIT_MIRROR_FAILURES) expect(MIRROR_FAILURE_MESSAGES[code]).toBeTruthy();
    expect(failureView(null)).toBeNull();
    expect(failureView("whatever")?.code).toBe("internal_error");
  });
});

describe("read-only reasons (ac-3)", () => {
  it("follows the host state and the connection", () => {
    expect(readOnlyReason("active", "c")).toBeNull();
    expect(readOnlyReason("archived", "c")).toBe("archived");
    expect(readOnlyReason("deleted", "c")).toBe("deleted");
    expect(readOnlyReason("unreachable", "c")).toBe("connection_removed");
    expect(readOnlyReason("active", null)).toBe("connection_removed");
  });

  it("the protocol's host states repeat the table's", () => {
    expect([...GIT_REPO_HOST_STATES]).toEqual([...GIT_REPOSITORY_HOST_STATE_VALUES]);
  });
});

describe("Repo content limits shared with Convert to repo (review R3-M1)", () => {
  it("names the limit a project's current files break", () => {
    const ok = { files: 500, bytes: GIT_REPO_MAX_CONTENT_BYTES, largest: GIT_REPO_MAX_FILE_BYTES };
    expect(repoContentRefusal(ok)).toBeUndefined();
    expect(repoContentRefusal({ ...ok, files: 501 })?.limit).toBe("files");
    expect(repoContentRefusal({ ...ok, largest: GIT_REPO_MAX_FILE_BYTES + 1 })?.limit).toBe(
      "file_bytes",
    );
    expect(repoContentRefusal({ ...ok, bytes: GIT_REPO_MAX_CONTENT_BYTES + 1 })).toEqual({
      limit: "bytes",
      limitValue: GIT_REPO_MAX_CONTENT_BYTES,
    });
  });

  it("derives the pack, inflation and disk caps from the content cap (R4-M1)", () => {
    const l = mirrorFetchLimits();
    expect(l.maxPackBytes).toBeGreaterThan(l.maxContentBytes);
    expect(l.maxInflatedBytes).toBeGreaterThan(l.maxContentBytes);
    expect(l.maxDiskBytes).toBeGreaterThanOrEqual(l.maxPackBytes + l.maxInflatedBytes);
    // Two refreshes (each up to one 50 MiB object past its budget) and a 4 GiB conversion fit
    // the chart's default 8Gi /tmp with room for other files.
    const two = 2 * (l.maxDiskBytes + l.maxFileBytes);
    expect(two + 4 * 1024 ** 3).toBeLessThan(6 * 1024 ** 3);
    expect(GIT_MIRROR_MAX_PACK_BYTES).toBe(l.maxPackBytes);
  });

  it("too large to mirror is checked again slowly, not as a transient failure (R4-M1)", () => {
    const now = 1_000_000;
    for (const code of ["too_many_files", "file_too_large", "repository_too_large"] as const) {
      expect(failureOf(new MirrorError(code), 0, now).nextAt.getTime() - now).toBe(6 * 60 * 60_000);
    }
  });

  it("the mirror uses the same numbers and the conversion refusal says why", () => {
    expect(GIT_MIRROR_MAX_BYTES).toBe(GIT_REPO_MAX_CONTENT_BYTES);
    expect(GIT_MIRROR_MAX_FILE_BYTES).toBe(GIT_REPO_MAX_FILE_BYTES);
    expect(GIT_MIRROR_MAX_FILES).toBe(GIT_REPO_MAX_FILES);
    expect(REFUSAL_STATUS.too_large_to_mirror).toBe(422);
    expect(
      refusalMessage({
        code: "too_large_to_mirror",
        mirrorLimit: "bytes",
        limitBytes: GIT_REPO_MAX_CONTENT_BYTES,
        sizeBytes: 300 * 1024 * 1024,
      }),
    ).toContain("300 MiB");
    expect(MIRROR_FAILURE_MESSAGES.repository_too_large).toContain("too large to mirror");
  });
});

describe("stale work folders (review R3-L2)", () => {
  it("removes only run folders older than the cutoff", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kaiju-mirror-stale-"));
    await mkdir(path.join(dir, "run-old"));
    await mkdir(path.join(dir, "run-new"));
    await mkdir(path.join(dir, "other"));
    const past = new Date(Date.now() - 60 * 60_000);
    await utimes(path.join(dir, "run-old"), past, past);
    await utimes(path.join(dir, "other"), past, past);
    expect(await removeStaleWorkDirs(Date.now() - 30 * 60_000, dir)).toBe(1);
    expect((await readdir(dir)).sort()).toEqual(["other", "run-new"]);
    await rm(dir, { recursive: true, force: true });
  });
});
