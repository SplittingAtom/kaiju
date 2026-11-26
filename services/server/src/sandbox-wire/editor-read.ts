import { SYSTEM_ACTOR, withTeam, type KaijuDb } from "@kaiju/db";
import {
  CAPABILITY_NOTEBOOKS,
  EDITOR_LOG_MAX_ENTRIES,
  NOTEBOOK_INSPECT_TIMEOUT_MS,
  notebookInspectResultSchema,
  workspaceToolPath,
} from "@kaiju/protocol";
import { type EditorReadFrame, type ServerToSandboxFrame } from "@kaiju/protocol/sandbox-wire";
import type { Logger } from "pino";
import { recordAudit } from "../audit/record.js";
import { logText, outputText, variablesText, type EditorText } from "../notebooks/editor-text.js";
import { readOutputs } from "../notebooks/execution.js";
import { fileExecutions } from "../notebooks/history.js";
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
 * Audited as `run.editor_read` (which tab, never content). Never in a skill eval's sandbox.
 */
export interface EditorReadConnection {
  readonly db: KaijuDb;
  readonly target: SandboxTarget;
  readonly log: Pick<Logger, "error" | "warn">;
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
      answerer(frame)(refused("not_allowed", "Skill evals never read the member's editor."));
      return true;
    },
    refuse(frame, refusal) {
      const answer = answerer(frame);
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
        .then(answerer(frame));
    },
  };
}

export async function readEditor(c: EditorReadConnection, frame: EditorReadFrame): Promise<Answer> {
  const path = workspaceToolPath(frame.input.path);
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
  if (answer.ok) await auditRead(c, frame);
  return answer;
}

async function readVariables(c: EditorReadConnection, threadId: string): Promise<Answer> {
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
  return { ok: true, ...variablesText(parsed.data) };
}

/** `run.editor_read`: which tab, never content; a failed audit is logged, the read stands. */
async function auditRead(c: EditorReadConnection, frame: EditorReadFrame): Promise<void> {
  const { teamId, userId } = c.target;
  try {
    await withTeam(c.db, teamId, (tx) =>
      recordAudit(tx, {
        action: "run.editor_read",
        actor: SYSTEM_ACTOR,
        teamId,
        target: {
          userId,
          threadId: frame.thread_id,
          runId: frame.run_id,
          toolCallId: frame.tool_call_id,
          what: frame.input.what,
        },
      }),
    );
  } catch (err) {
    c.log.error({ err, run_id: frame.run_id }, "could not audit run.editor_read");
  }
}
