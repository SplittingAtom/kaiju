import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PARTNER_UID_OFFSET, PI_UID_MIN, PiIdentities } from "../pi/identities.js";
import { TIMEOUT_BIN, toolCommandRunner } from "./tool-command.js";

/**
 * KOBE-767: a program run as a Pi process's tools goes through the identities helper as the tools'
 * uid (the partner uid with the executor, the Pi uid without), wrapped in `timeout`, with the
 * tools' environment; never as the agent's own uid when the tools are another one (review L5).
 * The helper here is a stand-in that records the uid it was asked for and runs the rest.
 */
const root = mkdtempSync(path.join(tmpdir(), "kobe-tool-command-"));
const log = path.join(root, "helper.log");
const helper = path.join(root, "kobe-runas");
writeFileSync(helper, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nshift\nexec "$@"\n`);
chmodSync(helper, 0o755);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const identities = new PiIdentities(helper, [PI_UID_MIN], async () => ({ code: 0, stderr: "" }));
const identity = { uid: PI_UID_MIN, gid: PI_UID_MIN };
const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", KOBE_PROBE: "tools-env" };

describe("running a program as the tools (KOBE-767)", () => {
  it("goes through the helper as the partner uid, in timeout, with the tools' environment", async () => {
    const run = toolCommandRunner({
      env,
      cwd: root,
      runAs: { identities, identity, partner: true },
    });
    const out = await run("/bin/sh", ["-c", 'printf "%s %s" "$KOBE_PROBE" "$(pwd)"'], {
      timeoutMs: 10_000,
      maxOutput: 1024,
    });
    expect(out).toEqual({ stdout: `tools-env ${root}` });
    const line = readFileSync(log, "utf8").trim().split("\n").at(-1) ?? "";
    expect(
      line.startsWith(`${PI_UID_MIN + PARTNER_UID_OFFSET} ${TIMEOUT_BIN} -k 5 10 /bin/sh`),
    ).toBe(true);
  });

  it("uses the Pi uid itself without the executor", async () => {
    const run = toolCommandRunner({
      env,
      cwd: root,
      runAs: { identities, identity, partner: false },
    });
    await run("/bin/true", [], { timeoutMs: 5_000, maxOutput: 16 });
    const line = readFileSync(log, "utf8").trim().split("\n").at(-1) ?? "";
    expect(line.startsWith(`${PI_UID_MIN} ${TIMEOUT_BIN}`)).toBe(true);
  });

  it("stops a program at its time limit and cuts long output", async () => {
    const run = toolCommandRunner({
      env,
      cwd: root,
      runAs: { identities, identity, partner: true },
    });
    expect(await run("/bin/sleep", ["30"], { timeoutMs: 1_000, maxOutput: 16 })).toEqual({
      failed: "timed out",
    });
    const long = await run("/bin/sh", ["-c", "yes x | head -c 5000"], {
      timeoutMs: 5_000,
      maxOutput: 100,
    });
    // Cut one past the cap (so the caller sees it was cut), never more.
    expect("stdout" in long ? long.stdout.length : 0).toBe(101);
  });

  it("runs nothing without a tools identity unless the tools are the agent's own uid", async () => {
    const lines = readFileSync(log, "utf8").split("\n").length;
    const refused = toolCommandRunner({ env, cwd: root });
    expect(await refused("/bin/true", [], { timeoutMs: 1_000, maxOutput: 16 })).toEqual({
      failed: "no tools identity",
    });
    expect(readFileSync(log, "utf8").split("\n").length).toBe(lines);
    const same = toolCommandRunner({ env, cwd: root, sameUid: true });
    expect(await same("/bin/sh", ["-c", "printf ok"], { timeoutMs: 5_000, maxOutput: 16 })).toEqual(
      { stdout: "ok" },
    );
  });
});
