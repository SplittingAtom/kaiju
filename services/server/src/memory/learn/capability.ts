import { lintInstructions } from "../checks/lint.js";
import { lintViews } from "../checks/text.js";

/**
 * Capability requests (KOBE-660): memory cannot change what the agent may do, so a learning pass
 * never offers a candidate about changing it, at any scope, however it is worded. The instruction
 * lint (`checks/lint.ts`) catches the imperative ("enable internet access to ..."); a model often
 * reports the same request as a fact ("The person wants internet access to X enabled for
 * everyone"), which this rule catches: a governed capability named within a short span of a word
 * that changes it, in either order, inside one sentence.
 *
 * Governed capabilities: internet, egress and network access and their allow lists, approvals,
 * tool, connector and MCP permissions, and sandbox settings (runtime class, gVisor, Kata).
 * A capability named without a change word ("Expense approvals go to Anna", "Approvals are needed
 * for payments over 10k") is not a request. All patterns are linear (bounded gaps).
 */

const CAPABILITY = String.raw`(?:(?:internet|network|outbound|web|egress)\s+(?:access|traffic|calls?|connections?)|egress|internet|allow[\s-]?lists?|white[\s-]?lists?|approvals?|approval (?:steps?|prompts?|checks?)|permissions?|tool (?:access|use|calls?)|connectors?|mcp(?: servers?)?|sandbox(?:es)?(?: settings?)?|runtime ?class(?:es)?|gvisor|kata)`;

const CHANGE = String.raw`(?:enabl\w*|disabl\w*|allow(?:s|ed|ing)?|open(?:s|ed|ing)?|unblock\w*|whitelist\w*|allowlist\w*|grant\w*|widen\w*|expand\w*|broaden\w*|turn(?:s|ed|ing)? (?:on|off)|switch(?:es|ed|ing)? (?:on|off)|skip\w*|bypass\w*|remov\w*|lift\w*|relax\w*|loosen\w*|waiv\w*|auto-?approv\w*)`;

/** Characters between the capability and the change word: no sentence end ("pastebin.com" is not one). */
const GAP = String.raw`(?:[^.!?\n]|[.!?](?=\S)){0,40}?`;

const REQUEST = [
  new RegExp(String.raw`\b${CAPABILITY}\b${GAP}\b${CHANGE}\b`, "u"),
  new RegExp(String.raw`\b${CHANGE}\b${GAP}\b${CAPABILITY}\b`, "u"),
];

/** Instruction-lint codes that are capability requests when they appear in quoted evidence. */
const QUOTE_CODES: ReadonlySet<string> = new Set(["instruction_egress", "instruction_tools"]);

/** True when `text` asks for, or reports a wish for, a change to a governed capability. */
export function mentionsCapabilityChange(text: string): boolean {
  return lintViews(text).some((view) => REQUEST.some((re) => re.test(view)));
}

/**
 * True when quoted evidence asks to change a capability: the instruction lint's egress or tools
 * rule, or {@link mentionsCapabilityChange}.
 */
export function quoteAsksCapabilityChange(quote: string): boolean {
  return (
    lintInstructions(quote).some((code) => QUOTE_CODES.has(code)) || mentionsCapabilityChange(quote)
  );
}
