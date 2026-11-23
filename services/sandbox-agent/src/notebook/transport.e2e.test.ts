import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * KOBE-808 (review round 4), end to end through the real bridge and a real kernel: completion and
 * docs travel as complete_request / inspect_request answered by the bridge's resolver, so the
 * member's execution hooks (pre/post_execute, pre/post_run_cell), input transformers, `str`
 * formatter, warnings hook and autoreload record zero calls, and the execution count, history and
 * Out do not move. Needs a Python with ipykernel: set KOBE_TEST_KERNEL_PYTHON (the image runs the
 * same probe in images/sandbox/test-image.sh).
 */
const PYTHON = process.env.KOBE_TEST_KERNEL_PYTHON;
const BRIDGE = fileURLToPath(
  new URL("../../../../images/sandbox/kernel/kobe-kernel-bridge.py", import.meta.url),
);
const PROBE = fileURLToPath(
  new URL("../../../../images/sandbox/kernel-transport-probe.py", import.meta.url),
);

describe.skipIf(PYTHON === undefined)("completion transport (KOBE-808)", () => {
  it("fires no execution hook, formatter or transformer; count, history and Out unchanged", () => {
    const res = spawnSync(PYTHON ?? "python3", [PROBE, PYTHON ?? "python3", BRIDGE], {
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, KOBE_PROBE_CWD: process.cwd() },
    });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout.trim()).toBe(
      "ok 0 1 0 0 cell_hooks_fire my_value|method|alpha=,beta=|alpha= method(alpha, beta=1)",
    );
  });
});
