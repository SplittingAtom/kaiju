import {
  parseMcpToolName,
  type JsonObject,
  type RiskClass,
  type ToolDescriptor,
} from "@kaiju/protocol";
import { GIT_BUILTIN_CONNECTOR_ID } from "@kaiju/db";
import { GIT_PROMPT_EXEMPT_TOOL } from "../git-tools/catalog.js";

/**
 * Site-level policy switches. Stored in `site_settings` (one row per key), so an install
 * Owner/Admin flips them through `PUT /v1/site/policy/settings` — no code change, no redeploy.
 */
export interface PolicySettings {
  /**
   * In `ask-on-write`, whether
   * sandbox-scoped write/destructive built-ins (bash, powershell, write, edit) are prompted for by
   * risk class. Default `false` — **user decision (Chris, 2026-10-03; KOBE-37 ledger): sandbox tools
   * ask for approval only when a policy rule says so; there is no default prompt for them** (D29:
   * "shell and file tools are bounded by the sandbox and egress policy"). An `ask` rule (install or
   * team) is how a team asks for them; `true` is a site admin's explicit opt-in to prompting
   * every sandbox write. Deny/ask rules and `ask-all` apply either way.
   */
  readonly promptSandboxWrites: boolean;
}

export const DEFAULT_POLICY_SETTINGS: PolicySettings = { promptSandboxWrites: false };

/** `site_settings.key` for {@link PolicySettings.promptSandboxWrites}. */
export const PROMPT_SANDBOX_WRITES_KEY = "policy.ask_on_write.prompt_sandbox_writes";

/** Kaiju tools that never prompt by risk class in `ask-on-write` (rules and `ask-all` still apply). */
export const PROMPT_EXEMPT_KAIJU_TOOLS: ReadonlySet<string> = new Set([
  "create_artifact",
  "update_artifact",
  "save_skill_draft",
]);

/**
 * Risk-class prompting in `ask-on-write` (D29), by where the tool's effects land and its risk.
 * `true` = prompt. `sandbox` rows follow {@link PolicySettings.promptSandboxWrites}. `kobe`-scoped
 * writes (shared files, memory) prompt — D23/D24 make project writes approval-gated — except:
 * - personal `remember` (D24: "personal writes via remember need no approval"), recognised by
 *   `scope: "user"` in its input (the memory contract, KOBE-153; anything else prompts);
 * - artifacts ({@link PROMPT_EXEMPT_KAIJU_TOOLS}; Chris, 2026-10-06): they only write versioned,
 *   Kaiju-owned content into the user's own thread, shown in a sandboxed frame with no network;
 * - `save_skill_draft` (KOBE-442; Chris, 2026-10-19): it only writes the member's own private
 *   Workbench draft; saving a version, review and evals stay the member's actions there.
 * - `git_create_branch` of the built-in git connector (KOBE-762, spec workspace-git G9): a branch is
 *   allowed by default, unlike the other git writes.
 * Site/team ask rules and `ask-all` still prompt for them (evaluate.ts runs those first).
 * Only interactive runs use this table; auto mode and scheduled runs don't (evaluate.ts).
 */
export function riskClassPrompts(
  tool: Pick<ToolDescriptor, "name" | "risk" | "scope" | "source"> &
    Partial<Pick<ToolDescriptor, "connector_id">>,
  input: JsonObject,
  settings: PolicySettings,
): boolean {
  // KOBE-762 (spec workspace-git G9): creating a branch on the git host is allowed by default;
  // the other git writes ask as external writes do. Rules and `ask-all` still apply.
  if (
    tool.source === "mcp" &&
    tool.connector_id === GIT_BUILTIN_CONNECTOR_ID &&
    parseMcpToolName(tool.name)?.tool_segment === GIT_PROMPT_EXEMPT_TOOL
  ) {
    return false;
  }
  if (tool.source === "kobe" && tool.name === "remember" && input.scope === "user") {
    return false;
  }
  if (tool.source === "kobe" && PROMPT_EXEMPT_KAIJU_TOOLS.has(tool.name)) return false;
  const table: Readonly<Record<ToolDescriptor["scope"], Readonly<Record<RiskClass, boolean>>>> = {
    sandbox: {
      read: false,
      write: settings.promptSandboxWrites,
      destructive: settings.promptSandboxWrites,
    },
    kobe: { read: false, write: true, destructive: true },
    external: { read: false, write: true, destructive: true },
  };
  return table[tool.scope][tool.risk];
}
