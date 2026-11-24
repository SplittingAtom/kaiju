import type { GitConnectionRecord } from "@kobe/db";
import { runGitContextSchema } from "@kobe/protocol/sandbox-wire";
import { describe, expect, it } from "vitest";
import {
  buildRunGitContext,
  gitAuthorName,
  gitCommitEmailMode,
  gitNoReplyEmail,
  gitNoReplyShortId,
  gitNoReplySlug,
  gitRemotesOf,
  type RunGitInput,
} from "./sandbox-git.js";

const USER = "6f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a0b";

const connection = (over: Partial<GitConnectionRecord>): GitConnectionRecord =>
  ({
    baseUrl: "https://github.com",
    organization: "acme",
    accessLevel: "read_write",
    agentIds: null,
    ...over,
  }) as GitConnectionRecord;

const input = (over: Partial<RunGitInput> = {}): RunGitInput => ({
  user: { id: USER, name: "Ada Lovelace", email: "ada@acme.test" },
  mode: "member",
  siteHost: "kobe.acme.test",
  connections: [connection({})],
  ...over,
});

describe("run.start.git (KOBE-764)", () => {
  it("makes the member the author with their Kaiju email and 'via Kaiju' the committer (G13)", () => {
    const git = buildRunGitContext(input());
    expect(git).toEqual({
      author: { name: "Ada Lovelace", email: "ada@acme.test" },
      committer: { name: "Ada Lovelace via Kaiju", email: "ada@acme.test" },
      remotes: [{ base_url: "https://github.com", organization: "acme" }],
    });
    expect(runGitContextSchema.safeParse(git).success).toBe(true);
  });

  it("switches to the no-reply form under the Site's host when the Workspace says so (GQ10)", () => {
    const git = buildRunGitContext(input({ mode: "noreply" }));
    const noReply = `${gitNoReplyShortId(USER)}+ada-lovelace@users.noreply.kobe.acme.test`;
    expect(git.author).toEqual({ name: "Ada Lovelace", email: noReply });
    expect(git.committer).toEqual({ name: "Ada Lovelace via Kaiju", email: noReply });
    expect(JSON.stringify(git)).not.toContain("ada@acme.test");
  });

  it("builds the no-reply address as GitHub's: short non-reversible id, name slug, valid", () => {
    const id = gitNoReplyShortId(USER);
    expect(id).toMatch(/^[0-9a-f]{10}$/);
    expect(USER.replace(/-/g, "")).not.toContain(id);
    expect(gitNoReplyShortId(USER.toUpperCase())).toBe(id);
    expect(gitNoReplySlug("Zoë  O'Brien-Şahin")).toBe("zoe-o-brien-sahin");
    expect(gitNoReplySlug("李雷")).toBe("member");
    expect(gitNoReplySlug("--")).toBe("member");
    const long = gitNoReplySlug(`${"a".repeat(38)} bcd`);
    expect(long).toBe("a".repeat(38));
    expect(gitNoReplySlug("x".repeat(80))).toHaveLength(39);
    const email = gitNoReplyEmail({ id: USER, name: "x".repeat(80) }, "Kaiju.Acme.Test");
    expect(email).toBe(`${id}+${"x".repeat(39)}@users.noreply.kobe.acme.test`);
    expect((email.split("@")[0] ?? "").length).toBeLessThanOrEqual(64);
    expect(runGitContextSchema.shape.author.shape.email.safeParse(email).success).toBe(true);
  });

  it("reads the setting from teams.settings; anything else is the member's email", () => {
    expect(gitCommitEmailMode({ git_commit_email: "noreply" })).toBe("noreply");
    expect(gitCommitEmailMode({ git_commit_email: "member" })).toBe("member");
    expect(gitCommitEmailMode({ git_commit_email: true })).toBe("member");
    expect(gitCommitEmailMode({})).toBe("member");
    expect(gitCommitEmailMode(null)).toBe("member");
    expect(gitCommitEmailMode("noreply")).toBe("member");
  });

  it("falls back to the no-reply form for an address git would misread", () => {
    const git = buildRunGitContext(input({ user: { id: USER, name: "A", email: "a <b>@c.test" } }));
    expect(git.author.email).toBe(gitNoReplyEmail({ id: USER, name: "A" }, "kobe.acme.test"));
  });

  it("cleans names git would misread and keeps room for the suffix", () => {
    expect(gitAuthorName('Ada "<x>"\nLovelace\\')).toBe("Ada x Lovelace");
    expect(gitAuthorName(" \n\t")).toBe("Kaiju member");
    const git = buildRunGitContext(
      input({ user: { id: USER, name: "n".repeat(500), email: "a@b.test" } }),
    );
    expect(runGitContextSchema.safeParse(git).success).toBe(true);
    expect(git.committer.name.endsWith(" via Kaiju")).toBe(true);
  });

  it("lists connections the sandbox's git may use: on, open to every agent, https on 443", () => {
    expect(
      gitRemotesOf([
        connection({}),
        connection({ organization: "ACME" }),
        connection({
          baseUrl: "https://git.acme.test/forgejo",
          organization: "data",
          accessLevel: "read",
        }),
        connection({ baseUrl: "https://off.acme.test", accessLevel: "off" }),
        connection({ baseUrl: "https://agents.acme.test", agentIds: ["a"] }),
        connection({ baseUrl: "https://ported.acme.test:8443" }),
        connection({ baseUrl: "https://listed.acme.test", agentIds: [] }),
        connection({ baseUrl: "https://explicit.acme.test:443" }),
      ]),
    ).toEqual([
      { base_url: "https://github.com", organization: "acme" },
      { base_url: "https://git.acme.test/forgejo", organization: "data" },
      { base_url: "https://explicit.acme.test", organization: "acme" },
    ]);
  });
});
