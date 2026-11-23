import { existsSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RUN_2, runStart, startHarness, until, type Harness } from "./testing/harness.js";

/**
 * Git in the sandbox through the agent (KOBE-764) with the scripted Pi: each Pi's tools get a git
 * config file of their own (`GIT_CONFIG_GLOBAL`, prompts off), written with safe defaults at
 * spawn and with the run's identity and remotes before each prompt; it goes with the process and
 * a rewrite by anyone else trips the runtime check.
 */
const git = {
  author: { name: "Ada Lovelace", email: "ada@acme.test" },
  committer: { name: "Ada Lovelace via Kobe", email: "ada@acme.test" },
  remotes: [{ base_url: "https://github.com", organization: "acme" }],
};

interface Launch {
  readonly env: string[];
  readonly agentDir: string;
  readonly gitConfigGlobal: string | null;
  readonly gitTerminalPrompt: string | null;
}

let h: Harness;
afterEach(async () => {
  expect(h.server.violations).toEqual([]);
  await h.close();
});

async function start(extra: Record<string, unknown>, message = "say:hi"): Promise<Launch> {
  h = await startHarness();
  expect(await h.server.command(runStart(message, extra))).toMatchObject({ ok: true });
  const [launch] = await h.commandsLog();
  return launch as unknown as Launch;
}

describe("git config for Pi's tools (KOBE-764)", () => {
  it("names a private config file and turns prompts off; no askpass, no secret", async () => {
    const launch = await start({ git });
    const file = launch.gitConfigGlobal ?? "";
    expect(path.dirname(file)).toBe(path.dirname(launch.agentDir));
    expect(path.basename(file)).toBe("gitconfig");
    expect(launch.gitTerminalPrompt).toBe("0");
    expect(launch.env).not.toContain("GIT_ASKPASS");
    expect(launch.env).not.toContain("SSH_ASKPASS");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const text = await readFile(file, "utf8");
    expect(text).toContain('[author]\n\tname = "Ada Lovelace"\n\temail = "ada@acme.test"');
    expect(text).toContain('[committer]\n\tname = "Ada Lovelace via Kobe"');
    expect(text).toContain('[url "http://github.com/acme/"]');
    expect(text).toContain("[credential]\n\thelper =\n");
  });

  it("rewrites the file for the next run (a run without git context gets the defaults)", async () => {
    const launch = await start({ git });
    await h.server.waitFor((f) => f.type === "pi.event" && f.event.type === "agent_settled");
    const file = launch.gitConfigGlobal ?? "";
    expect(await h.server.command(runStart("say:again", { run_id: RUN_2 }))).toMatchObject({
      ok: true,
    });
    await until(async () => !(await readFile(file, "utf8")).includes("[author]"));
    expect(await readFile(file, "utf8")).toContain("useConfigOnly = true");
  });

  it("stops a Pi whose git config was rewritten (tripwire) and removes it with the process", async () => {
    const launch = await start({ git });
    await h.server.waitFor((f) => f.type === "pi.event" && f.event.type === "agent_settled");
    const file = launch.gitConfigGlobal ?? "";
    await writeFile(file, "[credential]\n\thelper = store\n");
    const result = await h.server.command(runStart("say:hi", { run_id: RUN_2, git }));
    expect(result).toMatchObject({ ok: false, error: { code: "runtime_tampered" } });
    await until(() => !existsSync(file));
  });
});
