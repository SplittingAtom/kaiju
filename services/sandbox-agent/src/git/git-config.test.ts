import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunGitContext } from "@kobe/protocol/sandbox-wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GIT_CONFIG_FILE_NAME,
  GitConfigFile,
  gitConfigText,
  gitEnv,
  isGitConfigTemp,
  remoteRewrites,
} from "./git-config.js";

const context: RunGitContext = {
  author: { name: "Ada Lovelace", email: "ada@acme.test" },
  committer: { name: "Ada Lovelace via Kaiju", email: "ada@acme.test" },
  remotes: [
    { base_url: "https://github.com", organization: "acme" },
    { base_url: "https://git.acme.test/forgejo", organization: "data" },
  ],
};

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "kobe-gitconfig-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("gitEnv (KOBE-764)", () => {
  it("points git at the agent's config file and turns prompts off, with no secret", () => {
    const env = gitEnv("/run/kobe/pi-x/gitconfig");
    expect(env).toEqual({
      GIT_CONFIG_GLOBAL: "/run/kobe/pi-x/gitconfig",
      GIT_TERMINAL_PROMPT: "0",
    });
    expect(Object.keys(env)).not.toContain("GIT_ASKPASS");
  });
});

describe("remoteRewrites", () => {
  it("maps each organization's https remotes to the plain-HTTP form the egress proxy takes", () => {
    expect(remoteRewrites(context.remotes)).toEqual([
      {
        to: "http://github.com/acme/",
        from: ["https://github.com/acme/", "git@github.com:acme/", "ssh://git@github.com/acme/"],
      },
      {
        to: "http://git.acme.test/forgejo/data/",
        from: ["https://git.acme.test/forgejo/data/"],
      },
    ]);
  });

  it("drops anything that is not a canonical base URL or organization (defence in depth)", () => {
    expect(
      remoteRewrites([
        { base_url: "https://github.com:8443", organization: "acme" },
        { base_url: "http://github.com", organization: "acme" },
        { base_url: "https://github.com", organization: "ac]me" },
        { base_url: "https://github.com", organization: "ok" },
        { base_url: "https://github.com", organization: "ok" },
      ]),
    ).toEqual([
      {
        to: "http://github.com/ok/",
        from: ["https://github.com/ok/", "git@github.com:ok/", "ssh://git@github.com/ok/"],
      },
    ]);
  });
});

describe("gitConfigText", () => {
  it("without a context: credential helpers and askpass off, git never guesses an identity", () => {
    const text = gitConfigText(undefined);
    expect(text).toContain("[credential]\n\thelper =\n");
    expect(text).toContain("[core]\n\taskPass =\n");
    expect(text).toContain("[http]\n\tproxyAuthMethod = basic\n");
    expect(text).toContain("\tsshCommand = \"echo 'kobe: SSH is not available");
    expect(text).toContain("[user]\n\tuseConfigOnly = true\n");
    expect(text).not.toContain("[url ");
    expect(text).not.toMatch(/extraHeader|proxy\s*=|password|token/i);
  });

  it("writes the member as author, 'via Kaiju' as committer and one rewrite per organization", () => {
    const text = gitConfigText(context);
    expect(text).toContain('[author]\n\tname = "Ada Lovelace"\n\temail = "ada@acme.test"\n');
    expect(text).toContain(
      '[committer]\n\tname = "Ada Lovelace via Kaiju"\n\temail = "ada@acme.test"\n',
    );
    expect(text).toContain('\tname = "Ada Lovelace"\n\temail = "ada@acme.test"\n');
    expect(text).toContain(
      '[url "http://github.com/acme/"]\n' +
        '\tinsteadOf = "https://github.com/acme/"\n' +
        '\tinsteadOf = "git@github.com:acme/"\n' +
        '\tinsteadOf = "ssh://git@github.com/acme/"\n',
    );
    expect(text).toContain(
      '[url "http://git.acme.test/forgejo/data/"]\n\tinsteadOf = "https://git.acme.test/forgejo/data/"\n',
    );
    expect(text).not.toMatch(/extraHeader|password|token/i);
  });

  it("leaves out an identity that would break the file (the wire schema refuses it too)", () => {
    const text = gitConfigText({
      ...context,
      author: { name: 'x"\n[credential]\n\thelper = store', email: "a@b.test" },
    });
    expect(text).not.toContain("helper = store");
    expect(text).not.toContain("[author]");
    expect(text).toContain("useConfigOnly = true");
  });
});

describe("GitConfigFile", () => {
  it("writes atomically with the mode asked for and verifies what it wrote", async () => {
    const file = new GitConfigFile(path.join(dir, GIT_CONFIG_FILE_NAME), 0o640);
    await file.write(gitConfigText(context));
    expect(await readFile(file.path, "utf8")).toBe(gitConfigText(context));
    expect((await stat(file.path)).mode & 0o777).toBe(0o640);
    expect(await file.verify()).toBe(true);
  });

  it("is not verified before its first write, after a rewrite by someone else, or as a symlink", async () => {
    const file = new GitConfigFile(path.join(dir, GIT_CONFIG_FILE_NAME));
    expect(await file.verify()).toBe(false);
    await file.write(gitConfigText(undefined));
    await writeFile(file.path, "[credential]\n\thelper = store\n");
    expect(await file.verify()).toBe(false);
    // The next write restores it (rewritten before every run).
    await file.write(gitConfigText(undefined));
    expect(await file.verify()).toBe(true);
    await chmod(file.path, 0o666);
    expect(await file.verify()).toBe(false);
    await rm(file.path);
    await writeFile(path.join(dir, "elsewhere"), gitConfigText(undefined));
    await symlink(path.join(dir, "elsewhere"), file.path);
    expect(await file.verify()).toBe(false);
  });

  it("names its temp files so the tripwire can expect them", () => {
    expect(isGitConfigTemp("gitconfig.0123456789abcdef.tmp")).toBe(true);
    expect(isGitConfigTemp("gitconfig.tmp")).toBe(false);
    expect(isGitConfigTemp("gitconfig")).toBe(false);
  });
});
