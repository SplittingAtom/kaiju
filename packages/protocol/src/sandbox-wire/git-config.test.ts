import { describe, expect, it } from "vitest";
import {
  CAPABILITY_GIT,
  runGitContextSchema,
  runStartFrameSchema,
  SANDBOX_WIRE_VERSION,
} from "../sandbox-wire/index.js";

const ID = "11111111-1111-4111-8111-111111111111";
const context = {
  author: { name: "Ada Lovelace", email: "ada@acme.test" },
  committer: { name: "Ada Lovelace via Kaiju", email: "ada@acme.test" },
  remotes: [
    { base_url: "https://github.com", organization: "acme" },
    { base_url: "https://git.acme.test/forgejo", organization: "Data-Team" },
  ],
};

describe("run.start git (KOBE-764)", () => {
  it("names the capability", () => {
    expect(CAPABILITY_GIT).toBe("git");
  });

  it("accepts authorship and the connected organizations' base URLs", () => {
    expect(runGitContextSchema.safeParse(context).success).toBe(true);
    expect(runGitContextSchema.safeParse({ ...context, remotes: [] }).success).toBe(true);
  });

  it("refuses identities git or a config file would misread", () => {
    for (const name of ["", "A <b@c>", "line\nbreak", "tab\there", " padded"]) {
      const bad = { ...context, author: { ...context.author, name } };
      expect(runGitContextSchema.safeParse(bad).success, JSON.stringify(name)).toBe(false);
    }
    for (const email of ["", "no-at", "a b@c.test", "<a@c.test>", "a@b@c.test", 'a"@c.test']) {
      const bad = { ...context, committer: { ...context.committer, email } };
      expect(runGitContextSchema.safeParse(bad).success, email).toBe(false);
    }
  });

  it("carries base URLs only in the canonical https form, without credentials or ports", () => {
    for (const base_url of [
      "http://github.com",
      "https://user:pw@github.com",
      "https://github.com:8443",
      "https://github.com/",
      "https://GitHub.com",
      "https://github.com/a/../b",
      "https://github.com?x=1",
      'https://github.com/"x',
    ]) {
      const bad = { ...context, remotes: [{ base_url, organization: "acme" }] };
      expect(runGitContextSchema.safeParse(bad).success, base_url).toBe(false);
    }
    for (const organization of ["", "-acme", "ac/me", "ac me", "a".repeat(101)]) {
      const bad = { ...context, remotes: [{ base_url: "https://github.com", organization }] };
      expect(runGitContextSchema.safeParse(bad).success, organization).toBe(false);
    }
  });

  it("caps the remotes at the connection limit", () => {
    const remotes = Array.from({ length: 6 }, (_, i) => ({
      base_url: "https://github.com",
      organization: `org${i}`,
    }));
    expect(runGitContextSchema.safeParse({ ...context, remotes }).success).toBe(false);
  });

  it("ignores unknown keys from a newer server and carries no credential", () => {
    const parsed = runGitContextSchema.parse({ ...context, token: "t" });
    expect(parsed).not.toHaveProperty("token");
  });

  it("is an optional run.start field (older servers omit it)", () => {
    const base = {
      v: SANDBOX_WIRE_VERSION,
      type: "run.start",
      command_id: ID,
      run_id: ID,
      thread_id: ID,
      message: "hi",
    };
    expect(runStartFrameSchema.safeParse(base).success).toBe(true);
    expect(runStartFrameSchema.safeParse({ ...base, git: context }).success).toBe(true);
  });
});
