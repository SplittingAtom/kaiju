import {
  EDITOR_READ_TOOL,
  EDITOR_RUN_TOOL,
  workspaceToolPath,
  type PolicyDecision,
  type PolicyReason,
  type ToolDescriptor,
} from "@kaiju/protocol";
import { canonicalPath } from "./tool-inputs.js";

/**
 * The editor-file guard (KOBE-848): `editor_run` and `editor_read` work only on the `.py` file the
 * member had open in the code editor when they sent the message (the run's viewed file,
 * `runs.viewing.path`, set at send, Retry and regenerate). Decided by the server after the engine
 * on every `policy.check`, in every approval mode (Dangerous and remembered approvals included),
 * like the viewed-file guard: any other path, a non-`.py` viewed file or a run without a viewed
 * file is a **deny** with a tool error the model can act on. An engine deny stands as it is.
 *
 * Paths are compared as normalised strings (the tool's path resolved against `/workspace`, then
 * made workspace-relative; case-sensitive; symlinks not followed). Reason code `editor_file`
 * (stage `site_deny`); the wire keeps reason codes open.
 */
export const EDITOR_FILE_REASON = "editor_file";

export const EDITOR_TOOLS: ReadonlySet<string> = new Set([EDITOR_RUN_TOOL, EDITOR_READ_TOOL]);

export interface EditorFileGuard {
  /** The server's own descriptor of the called tool. */
  readonly tool: ToolDescriptor;
  /** The call's input as the sandbox sent it. */
  readonly input: unknown;
  /** The run's viewed file (workspace-relative), if any. */
  readonly viewedPath: string | undefined;
}

/** The workspace-relative file an editor tool names; undefined when it names none we accept. */
export function editorToolTarget(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const raw = (input as { path?: unknown }).path;
  if (typeof raw !== "string") return undefined;
  const absolute = canonicalPath(raw);
  return absolute === undefined ? undefined : workspaceToolPath(absolute);
}

function refusal(message: string): PolicyReason {
  return { code: EDITOR_FILE_REASON, stage: "site_deny", message };
}

/** Why the call is refused, or undefined when it names the viewed `.py` file. */
export function editorFileProblem(g: EditorFileGuard): string | undefined {
  const name = g.tool.name;
  if (g.viewedPath === undefined) {
    return `${name} works only on the Python file the user has open in the editor, and they had no file open when they sent this message. Ask them to open it and send again, or use run_python.`;
  }
  if (!g.viewedPath.endsWith(".py")) {
    return `${name} works only on a .py file open in the editor; the user has ${g.viewedPath} open. Use run_python for other code.`;
  }
  const target = editorToolTarget(g.input);
  if (target !== g.viewedPath) {
    return `${name} works only on the file the user has open in the editor: /workspace/${g.viewedPath}. Use run_python for other files.`;
  }
  return undefined;
}

/** The decision with the guard applied: `decision` itself when the tool is not an editor tool. */
export function guardEditorFile(decision: PolicyDecision, g: EditorFileGuard): PolicyDecision {
  if (decision.effect === "deny" || g.tool.source !== "kaiju" || !EDITOR_TOOLS.has(g.tool.name)) {
    return decision;
  }
  const problem = editorFileProblem(g);
  if (problem === undefined) return decision;
  return { effect: "deny", risk: decision.risk, reasons: [refusal(problem)] };
}
