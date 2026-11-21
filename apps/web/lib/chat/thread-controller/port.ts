/**
 * The narrow port a `ThreadController` hands its action modules (KOBE-716): read the state, change
 * it, mark an action busy, report, and ask for a fresh read. The private fields stay in the class.
 */
import type { ApiError } from "../../api/client";
import type { ChatApi } from "../api";
import type { ThreadState } from "../thread-state";

export interface ControllerPort {
  readonly api: ChatApi;
  state(): ThreadState;
  set(change: (state: ThreadState) => ThreadState): void;
  busy<T>(action: string, fn: () => Promise<T>): Promise<T>;
  fail(error: ApiError, draft?: string): void;
  announce(announcement: string): void;
  refresh(): Promise<void>;
  /** A leaf choice is on its way: a read already sent keeps the leaf it is about to show. */
  bumpLeafVersion(): void;
  /** The member moved the leaf (`POST /leaf`): this browser's other tabs are told. */
  leafMoved(threadId: string): void;
}
