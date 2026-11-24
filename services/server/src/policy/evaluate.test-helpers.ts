// Shared setup for the evaluate.*.test.ts files (split from evaluate.test.ts, KOBE-725).
import { expect } from "vitest";
import {
  policyDecisionSchema,
  type JsonObject,
  type PolicyDecision,
  type ToolDescriptor,
} from "@kaiju/protocol";
import {
  builtin,
  ENABLED_ALL,
  mcpTool,
  NOW,
  policyInput,
  ruleSet,
  sampleInput,
  type InputOptions,
} from "../testing/policy-fixtures.js";
import { evaluatePolicy } from "./evaluate.js";
import type { ConnectorPolicyState } from "./gates.js";
import type { PolicyRule } from "./rules.js";
import { DEFAULT_POLICY_SETTINGS, type PolicySettings } from "./settings.js";

export interface Case {
  readonly name: string;
  readonly tool: ToolDescriptor;
  readonly input?: JsonObject;
  readonly options?: InputOptions;
  readonly rules?: readonly PolicyRule[];
  readonly connector?: ConnectorPolicyState;
  readonly settings?: PolicySettings;
  readonly effect: PolicyDecision["effect"];
  /** Reason codes, in order. */
  readonly codes: readonly string[];
}

export function run(c: Omit<Case, "name" | "effect" | "codes">): PolicyDecision {
  const decision = evaluatePolicy({
    input: policyInput(c.tool, c.input ?? sampleInput(c.tool), c.options ?? {}),
    tool: c.tool,
    rules: ruleSet(c.rules ?? []),
    connector: c.connector ?? (c.tool.source === "mcp" ? ENABLED_ALL : undefined),
    settings: c.settings ?? DEFAULT_POLICY_SETTINGS,
    now: NOW,
  });
  // Every decision satisfies the published contract.
  expect(policyDecisionSchema.parse(decision)).toEqual(decision);
  return decision;
}

export const bash = builtin("bash");
export const read = builtin("read");
export const write = builtin("write");
/** A Kaiju-scoped write that prompts in ask-on-write (artifacts are exempt; see settings.ts). */
export const kaijuWrite = builtin("share_file");
export const jiraCreate = mcpTool("mcp__jira__create_issue", "write");
export const jiraSearch = mcpTool("mcp__jira__search", "read");
export const PROMPT_SANDBOX: PolicySettings = { promptSandboxWrites: true };
