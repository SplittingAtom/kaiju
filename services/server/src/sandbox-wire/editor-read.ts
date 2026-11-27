import { withTeam, type KaijuDb } from "@kaiju/db";
import {
  CAPABILITY_NOTEBOOKS,
  EDITOR_LOG_MAX_ENTRIES,
  NOTEBOOK_INSPECT_TIMEOUT_MS,
  notebookInspectResultSchema,
} from "@kaiju/protocol";
import { type EditorReadFrame, type ServerToSandboxFrame } from "@kaiju/protocol/sandbox-wire";
import type { Logger } from "pino";
import { readTeamAgentVariableValues } from "../notebooks/agent-variable-values.js";
import { VARIABLES_RATE_LIMIT } from "../notebooks/variables.js";
import { editorToolTarget } from "../policy/editor-file-guard.js";
import { hitRateLimit } from "../rate-limit.js";
import { logText, outputText, variablesText, type EditorText } from "../notebooks/editor-text.js";
import { readOutputs } from "../notebooks/execution.js";
import { fileExecutions } from "../notebooks/history.js";
import type { AuditEditor } from "./editor-audit.js";
import type { ToolFrameSpec } from "./gated-frame.js";
import { COMMAND_FAILURES, type CommandOutcome, type SandboxTarget } from "./types.js";

/**
 * `editor.read` (KOBE-848, `editor_read`) on one connection: accepted only if it announced
 * `notebooks`, the run is leased here and active, and this call was allowed here (a read; the
 * policy check's editor-file guard limited it to the run's viewed `.py` file) with the same
 * canonical input, taken once. Answers a bounded text the extension fences as untrusted:
 *
 * - `output` / `log`: from the thread's stored run events (`notebook.started` / `.finished` /
 *   `.output`), as the run pane's Run Output and Log show them;
 * - `variables`: a snapshot from the thread's kernel through `notebook.inspect` on this connection
 *   (KOBE-816: no member code; credential-like names withheld in the sandbox; never `show`,
 *   never `refresh`, nothing stored). Never starts a kernel.
 *
 * Audited as `run.editor_read` (which tab and its outcome, refusals included; never content).
 * Never in a skill eval's sandbox. Variable values beyond numbers, bools and None only when the
 * team's `agent_variable_values` setting is on; variable reads are rate limited.
 */
export interface EditorReadConnection {
  readonly db: KaijuDb;
  readonly target: SandboxTarget;
  readonly log: Pick<Logger, "error" | "warn">;
  /** Records `run.editor_read`. */
  readonly auditEditor: AuditEditor;
  /** A variables snapshot of the thread's kernel on this connection. */
  readonly inspect: (
    threadId: string,
    timeoutMs: number,
    waitMs: number,
  ) => Promise<CommandOutcome>;
  send(frame: ServerToSandboxFrame): boolean;
}

type Answer =
  | ({ readonly ok: true } & EditorText)
  | { readonly ok: false; readonly code: string; readonly message: string };

const refused = (code: string, message: string): Answer => ({ ok: false, code, message });

/** The agent's own wait for a snapshot plus the trip there and back. */
const INSPECT_MARGIN_MS = 5_000;

export function editorReadSpec(c: EditorReadConnection): ToolFrameSpec<EditorReadFrame, "consume"> {
  const answerer = (frame: EditorReadFrame) => (out: Answer) =>
    c.send(
      out.ok
        ? {
            v: 1,
            type: "editor.read_result",
            request_id: frame.request_id,
            ok: true,
            op: "editor_read",
            what: frame.input.what,
            text: out.text,
            truncated: out.truncated,
          }
        : {
            v: 1,
            type: "editor.read_result",
            request_id: frame.request_id,
            ok: false,
            error: { code: out.code, message: out.message },
          },
    );
  return {
    capabilities: [CAPABILITY_NOTEBOOKS],
    allowance: "consume",
    beforeRun(frame) {
      if (c.target.evalThreadId === undefined) return false;
      auditRead(c, frame, "refused");
      answerer(frame)(refused("not_allowed", "Skill evals never read the member's editor."));
      return true;
    },
    refuse(frame, refusal) {
      const send = answerer(frame);
      const answer = (out: Answer) => {
        auditRead(c, frame, "refused");
        send(out);
      };
      switch (refusal.stage) {
        case "capability":
          answer(refused("not_allowed", "This sandbox did not announce notebooks."));
          return;
        case "ended":
          answer(refused("not_allowed", "The run has ended, so nothing was read."));
          return;
        case "verdict": {
          const { verdict } = refusal;
          c.log.warn({ run_id: frame.run_id, verdict, security: true }, "editor.read refused");
          answer(
            refused(
              "not_allowed",
              verdict === "input_mismatch"
                ? "The request differs from the call that was allowed."
                : verdict === "replayed"
                  ? "This tool call was already used."
                  : "This tool call was not allowed for this tool.",
            ),
          );
          return;
        }
        case "busy":
          return; // no in-flight cap for this kind
      }
    },
    act(frame) {
      void readEditor(c, frame)
        .catch((err: unknown): Answer => {
          c.log.error({ err, run_id: frame.run_id }, "editor.read failed");
          return refused("storage_failed", "The run pane could not be read. Try again.");
        })
        .then((out) => {
          auditRead(c, frame, out.ok ? "ok" : out.code === "storage_failed" ? "failed" : "refused");
          answerer(frame)(out);
        });
    },
  };
}

export async function readEditor(c: EditorReadConnection, frame: EditorReadFrame): Promise<Answer> {
  // The same normalisation as the policy check's editor-file guard (`/workspace/./a.py` is a.py).
  const path = editorToolTarget(frame.input);
  if (path === undefined) return refused("invalid_path", "Name a file under /workspace.");
  const { teamId } = c.target;
  const what = frame.input.what;
  let answer: Answer;
  if (what === "variables") {
    answer = await readVariables(c, frame.thread_id);
  } else {
    const entries = await withTeam(c.db, teamId, (tx) =>
      fileExecutions(tx, teamId, frame.thread_id, path, EDITOR_LOG_MAX_ENTRIES + 1),
    );
    if (what === "log") {
      answer = { ok: true, ...logText(path, entries) };
    } else {
      const newest = entries[0];
      const outputs =
        newest === undefined
          ? []
          : await readOutputs(c.db, teamId, newest.run_id, newest.started.exec_id);
      answer = { ok: true, ...outputText(path, newest, outputs) };
    }
  }
  return answer;
}

/**
 * KOBE-848 review: at most {@link VARIABLES_RATE_LIMIT} snapshots per member per minute (each runs
 * introspection in their kernel), counted apart from the owner's own Variables tab; values of
 * strings, bytes and containers only when the team's setting allows them (default off).
 */
async function readVariables(c: EditorReadConnection, threadId: string): Promise<Answer> {
  const { teamId, userId } = c.target;
  if (!(await hitRateLimit(c.db, `editor-read-variables:${userId}`, VARIABLES_RATE_LIMIT))) {
    return refused("rate_limited", "Too many variable reads; wait a minute, then read them again.");
  }
  const values = (await readTeamAgentVariableValues(c.db, teamId)).effective;
  const outcome = await c.inspect(
    threadId,
    NOTEBOOK_INSPECT_TIMEOUT_MS,
    NOTEBOOK_INSPECT_TIMEOUT_MS + INSPECT_MARGIN_MS,
  );
  if (!outcome.ok) {
    const code = outcome.error.code;
    if (code === COMMAND_FAILURES.inspectUnsupported) {
      return refused(
        "variables_unsupported",
        "Reading variables is not available on this sandbox yet (an older Kaiju agent).",
      );
    }
    if (code === COMMAND_FAILURES.timeout) {
      return { ok: true, ...variablesText({ status: "unavailable" }) };
    }
    c.log.warn({ code }, "editor.read variables snapshot failed");
    return refused("storage_failed", "The kernel's variables could not be read. Try again.");
  }
  const parsed = notebookInspectResultSchema.safeParse(outcome.data);
  if (!parsed.success) {
    c.log.warn({ thread_id: threadId }, "the sandbox sent a malformed variables snapshot");
    return { ok: true, ...variablesText({ status: "unavailable" }) };
  }
  return { ok: true, ...variablesText(parsed.data, values) };
}

/** `run.editor_read`: which tab and how it went, never content. */
function auditRead(
  c: EditorReadConnection,
  frame: EditorReadFrame,
  outcome: "ok" | "refused" | "failed",
): void {
  c.auditEditor(c.target, {
    action: "run.editor_read",
    threadId: frame.thread_id,
    runId: frame.run_id,
    toolCallId: frame.tool_call_id,
    what: frame.input.what,
    outcome,
  });
}
