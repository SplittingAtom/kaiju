import { CAPABILITY_GIT, type RepoStatusFrame } from "@kobe/protocol/sandbox-wire";
import { recordRepoStatus } from "../../git/working-copy.js";
import type { ConnectionPort } from "./port.js";

/** Reports a connection may send per minute (two per run: at start and at the end). */
export const REPO_STATUS_PER_MINUTE = 30;

/**
 * `repo.status` (KOBE-767, G19) on one connection: the agent's report of the thread's Repo
 * working copy. Kept only from an agent that announced `git`, within a per-connection budget, and
 * for a run of this member on a thread in that Repo (checked against the database). Never
 * answered; anything else is dropped (and logged), the connection stays.
 */
export class RepoStatusIntake {
  readonly #port: ConnectionPort;
  readonly #announced: () => boolean;
  #windowStart = 0;
  #count = 0;

  constructor(port: ConnectionPort, announced: () => boolean) {
    this.#port = port;
    this.#announced = announced;
  }

  take(frame: RepoStatusFrame, now = Date.now()): void {
    if (!this.#announced()) return;
    if (now - this.#windowStart >= 60_000) {
      this.#windowStart = now;
      this.#count = 0;
    }
    this.#count += 1;
    if (this.#count > REPO_STATUS_PER_MINUTE) return;
    const { ctx, target, log } = this.#port;
    if (target.evalThreadId !== undefined) return;
    recordRepoStatus(ctx.db, target, frame)
      .then((kept) => {
        if (!kept) log.warn({ run_id: frame.run_id }, "repo.status for another thread dropped");
      })
      .catch((err: unknown) => log.warn({ err }, "repo.status not recorded"));
  }
}

export const REPO_STATUS_CAPABILITY = CAPABILITY_GIT;
