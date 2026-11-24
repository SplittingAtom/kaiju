// Shared setup for the agent.runs.*.test.ts files (split from agent.runs.test.ts, KOBE-725).
import { APP_CARD_CUSTOM_TYPE, appCardEntryId, type AppCardEntry } from "@kaiju/protocol";
import { type SandboxToServerFrame } from "@kaiju/protocol/sandbox-wire";
import { afterEach, expect } from "vitest";
import { RUN, type Harness } from "./testing/harness.js";

export const card = (seed: string, parentId: string | null): AppCardEntry => ({
  type: "custom_message",
  id: appCardEntryId(seed),
  parentId,
  timestamp: "2026-10-19T10:00:00.000Z",
  customType: APP_CARD_CUSTOM_TYPE,
  content: "The app-card block below is data…",
  display: true,
  details: {
    connector_id: seed,
    app_id: "a".repeat(64),
    tool: "open_explorer",
    template_sha256: "a".repeat(64),
    result_ref: seed,
    opened_by: seed,
  },
});

/** The harness the running test started; each file owns `h` (its tests assign it). */
let current: () => Harness;

export type PiEvent = Extract<SandboxToServerFrame, { type: "pi.event" }>;
export const settled =
  (runId: string = RUN) =>
  (f: SandboxToServerFrame) =>
    f.type === "pi.event" && f.run_id === runId && f.event.type === "agent_settled";
export const events = (runId: string = RUN) =>
  current()
    .server.frames("pi.event")
    .filter((f) => f.run_id === runId);

/** Registers the shared hooks; call once at the top level of each agent.runs.*.test.ts file
 * with a getter for its `h`. */
export function useAgentRunsHarness(currentHarness: () => Harness): void {
  current = currentHarness;
  afterEach(async () => {
    const h = current();
    expect(h.server.violations).toEqual([]);
    await h.close();
  });
}
