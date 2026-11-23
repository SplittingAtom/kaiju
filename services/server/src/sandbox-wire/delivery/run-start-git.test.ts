import { randomUUID } from "node:crypto";
import {
  CAPABILITY_GIT,
  type RunGitContext,
  type RunStartFrame,
  type ServerToSandboxFrame,
} from "@kobe/protocol/sandbox-wire";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandRow } from "../commands.js";
import type { DeliveryEnv } from "./env.js";

const load = vi.hoisted(() => vi.fn());
vi.mock("../../git/sandbox-git.js", () => ({ loadRunGitContext: load }));
const { prepareRunStart } = await import("./run-start.js");

/**
 * KOBE-764 at delivery: `run.start.git` reaches only agents that announced `git`, never an eval
 * sandbox, and only when the server knows the Site's host; a failed read sends the start without
 * it (the agent keeps git's safe defaults) instead of failing the run.
 */
const THREAD = randomUUID();
const RUN = randomUUID();
const GIT: RunGitContext = {
  author: { name: "Ada", email: "ada@acme.test" },
  committer: { name: "Ada via Kobe", email: "ada@acme.test" },
  remotes: [{ base_url: "https://github.com", organization: "acme" }],
};
const warnings: unknown[] = [];

function env(
  capabilities: readonly string[],
  opts: { evalThreadId?: string; siteHost?: string | null } = {},
): DeliveryEnv {
  return {
    ctx: {
      db: {},
      ...(opts.siteHost === null ? {} : { gitSiteHost: opts.siteHost ?? "kobe.acme.test" }),
    },
    host: {
      target: { teamId: randomUUID(), userId: randomUUID(), evalThreadId: opts.evalThreadId },
      hasCapability: (name: string) => capabilities.includes(name),
      log: { warn: (...args: unknown[]) => warnings.push(args) },
    },
  } as unknown as DeliveryEnv;
}

const row = { id: randomUUID(), kind: "run.start", threadId: THREAD, runId: RUN } as CommandRow;
const start = {
  v: 1,
  type: "run.start",
  command_id: "c1",
  run_id: RUN,
  thread_id: THREAD,
  message: "hi",
} as unknown as ServerToSandboxFrame;
const hooks = { recordMemory: () => undefined, conflictsCarried: () => undefined };
const prepare = (e: DeliveryEnv) =>
  prepareRunStart(e, row, start as RunStartFrame, start, hooks) as Promise<RunStartFrame>;

beforeEach(() => {
  load.mockReset();
  warnings.length = 0;
});

describe("run.start.git delivery (KOBE-764)", () => {
  it("adds the member's git context for an agent with `git`", async () => {
    load.mockResolvedValue(GIT);
    const e = env([CAPABILITY_GIT]);
    expect((await prepare(e)).git).toEqual(GIT);
    expect(load).toHaveBeenCalledWith(e.ctx.db, e.host.target, "kobe.acme.test");
  });

  it("leaves it out for an older agent, an eval sandbox, or without the Site's host", async () => {
    load.mockResolvedValue(GIT);
    expect(await prepare(env([]))).not.toHaveProperty("git");
    expect(await prepare(env([CAPABILITY_GIT], { evalThreadId: THREAD }))).not.toHaveProperty(
      "git",
    );
    expect(await prepare(env([CAPABILITY_GIT], { siteHost: null }))).not.toHaveProperty("git");
    expect(load).not.toHaveBeenCalled();
  });

  it("sends the start without it when the read fails", async () => {
    load.mockRejectedValue(new Error("db down"));
    expect(await prepare(env([CAPABILITY_GIT]))).not.toHaveProperty("git");
    expect(warnings).toHaveLength(1);
  });
});
