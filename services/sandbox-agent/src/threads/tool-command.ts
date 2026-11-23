import { spawn } from "node:child_process";
import type { ToolCommandRunner } from "../git/working-copy.js";
import type { ToolCommand } from "./thread-env.js";

/** coreutils `timeout`: it runs as the tools' uid and stops its own child (no cross-uid kill). */
export const TIMEOUT_BIN = "/usr/bin/timeout";
/** Seconds `timeout` waits after TERM before KILL. */
const KILL_AFTER_S = 5;

/**
 * Runs one program as a Pi process's tools (KOBE-767): their uid (through the identities helper)
 * and environment, cwd the workspace, stdin closed, stdout cut at `maxOutput`, stderr dropped.
 * The program is wrapped in `timeout`, which ends it as its own uid; the agent stops waiting a
 * little after that whatever happens. Never throws.
 */
export function toolCommandRunner(tools: ToolCommand): ToolCommandRunner {
  return (file, args, options) =>
    new Promise((resolve) => {
      const seconds = Math.max(1, Math.ceil(options.timeoutMs / 1000));
      let bin = TIMEOUT_BIN;
      let argv: readonly string[] = ["-k", String(KILL_AFTER_S), String(seconds), file, ...args];
      const runAs = tools.runAs;
      if (runAs !== undefined) {
        argv = runAs.partner
          ? runAs.identities.partnerCommand(runAs.identity, bin, argv, tools.env)
          : runAs.identities.command(runAs.identity, bin, argv, tools.env);
        bin = runAs.identities.helper;
      }
      let settled = false;
      const done = (value: { stdout: string } | { failed: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(backstop);
        resolve(value);
      };
      const backstop = setTimeout(
        () => done({ failed: "timed out" }),
        options.timeoutMs + (KILL_AFTER_S + 5) * 1000,
      );
      backstop.unref();
      let child;
      try {
        child = spawn(bin, [...argv], {
          cwd: tools.cwd,
          env: { ...tools.env },
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        });
      } catch {
        done({ failed: "could not start" });
        return;
      }
      let out = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (out.length <= options.maxOutput) out += chunk;
      });
      child.on("error", () => done({ failed: "could not start" }));
      child.on("close", (code) => {
        // `timeout` exits 124 when it had to stop the program.
        if (code === 124 || code === 137) done({ failed: "timed out" });
        else done({ stdout: out.slice(0, options.maxOutput + 1) });
      });
    });
}
