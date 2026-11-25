/** The public shapes of workspace sync (`../sync.ts` re-exports them for its importers). */
import type { SyncClient } from "../client.js";
import type { WireLogger } from "../../wire/client.js";

export interface WorkspaceSyncOptions {
  readonly root: string;
  readonly client: SyncClient;
  readonly logger: WireLogger;
  /** Periodic push + pull; 0 disables sync entirely. */
  readonly intervalMs: number;
  /** Directory names never synced, anywhere (rebuildable caches). */
  readonly skipDirs?: readonly string[];
  readonly maxFiles?: number;
  /** Parallel uploads/downloads. */
  readonly concurrency?: number;
  /** How long `beforeRun` waits for a failing restore before letting the run start anyway. */
  readonly restoreWaitMs?: number;
  readonly now?: () => Date;
}

/** A conflict copy the sync just made (KOBE-492): names relative to the root, and both hashes. */
export interface ConflictReport {
  readonly path: string;
  readonly conflict_path: string;
  readonly member_sha256: string;
  readonly agent_sha256: string;
  readonly at: Date;
}
export type ConflictListener = (report: ConflictReport) => void;

export interface RestoreStats {
  readonly mode: "full" | "incremental";
  readonly entries: number;
  readonly files: number;
  readonly bytes: number;
  readonly durationMs: number;
}

export interface PushStats {
  readonly changes: number;
  readonly uploaded: number;
  readonly bytes: number;
  readonly conflicts: number;
  readonly rejected: number;
}

/** The synced entry of one file: what `file.share` must name (files.ts, push-then-share). */
export interface PushedFile {
  readonly path: string;
  readonly rev: number;
  readonly sha256: string;
  readonly size: number;
}

/** `pushPath` could not leave the file synced; the message is shown to the model as a tool error. */
export class PushPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PushPathError";
  }
}

export const DEFAULT_SKIP_DIRS = ["node_modules", "__pycache__", ".venv"] as const;
/** Where files found in a server-owned area that the server never wrote are moved (and kept). */
export const EVICTED_PREFIX = "kaiju-moved/";
