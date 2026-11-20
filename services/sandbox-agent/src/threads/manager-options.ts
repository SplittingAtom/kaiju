import type { PiSessionHeader, RunStartFrame, ServerToSandboxFrame } from "@kobe/protocol";
import type { RunModel } from "../models/types.js";
import type { SessionRestore } from "../pi/session-files.js";
import type { SkillStore } from "../skills/store.js";
import type { CommandOutcome } from "./outcome.js";
import type { Thread } from "./thread.js";
import type { ThreadEnv, ThreadHooks } from "./thread-env.js";

export type Frame<T extends ServerToSandboxFrame["type"]> = Extract<
  ServerToSandboxFrame,
  { type: T }
>;

export interface ThreadManagerOptions extends ThreadEnv {
  readonly hooks: ThreadHooks;
  readonly maxProcesses: number;
  readonly idleMs: number;
  readonly restoreMaxBytes: number;
  readonly parentEnv: Readonly<Record<string, string | undefined>>;
  /** Seam for KOBE-27 (S3 ↔ /workspace sync): runs before a prompt reaches Pi. */
  readonly beforeRun?: (frame: RunStartFrame) => Promise<void>;
  readonly beforeRunTimeoutMs?: number;
  /**
   * The skills store (KOBE-82). Absent (development, tests): a run that lists skills fails, one
   * that lists none starts as before.
   */
  readonly skills?: Pick<SkillStore, "prepare" | "release">;
  /**
   * The run's current span as a `traceparent` (KOBE-274), written to the model file with the run
   * so Pi's first model call already carries it; absent or null: none.
   */
  readonly traceparentOf?: (runId: string) => string | null;
}

/**
 * What the compaction and session commands (`compaction.ts`, `session-commands.ts`) use of their
 * `ThreadManager`: its options, its restores, and the steps that stay on the class.
 */
export interface ManagerPort {
  readonly options: ThreadManagerOptions;
  /** Session restores in progress, by thread id. */
  readonly restores: Map<string, SessionRestore>;
  readonly draining: () => boolean;
  /** Spawn (or restart) the thread's Pi; inside the thread's lock. */
  readonly ensureProcess: (
    thread: Thread,
    frame: RunStartFrame | undefined,
    model?: RunModel | null,
  ) => Promise<CommandOutcome | undefined>;
  readonly sessionFile: (threadId: string) => string;
  readonly defaultHeader: (threadId: string) => PiSessionHeader;
  readonly endRestore: (thread: Thread) => void;
  readonly warn: (threadId: string, message: string) => void;
}
