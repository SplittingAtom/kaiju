import {
  parseEventPayload,
  type KaijuEvent,
  type KaijuEventPayload,
  type KaijuEventType,
} from "../events.js";

/**
 * In-memory stand-in for `run_events` (test use only): per-run gapless `seq` from 1, payloads
 * validated against the contract, replay with `readAfter(run, cursor)` as SSE resume does.
 */
export interface InMemoryEventLog {
  append<T extends KaijuEventType>(
    runId: string,
    type: T,
    payload: KaijuEventPayload<T>,
  ): KaijuEvent<T>;
  readAfter(runId: string, after: number): readonly KaijuEvent[];
  subscribe(runId: string, listener: (event: KaijuEvent) => void): () => void;
}

export function createInMemoryEventLog(now: () => Date = () => new Date()): InMemoryEventLog {
  const logs = new Map<string, readonly KaijuEvent[]>();
  const listeners = new Map<string, ReadonlySet<(event: KaijuEvent) => void>>();

  return {
    append(runId, type, payload) {
      const existing = logs.get(runId) ?? [];
      const event = {
        run_id: runId,
        seq: existing.length + 1,
        ts: now().toISOString(),
        type,
        payload: parseEventPayload(type, payload),
      } as KaijuEvent<typeof type>;
      logs.set(runId, [...existing, event as KaijuEvent]);
      for (const listener of listeners.get(runId) ?? []) listener(event as KaijuEvent);
      return event;
    },
    readAfter(runId, after) {
      return (logs.get(runId) ?? []).filter((event) => event.seq > after);
    },
    subscribe(runId, listener) {
      listeners.set(runId, new Set([...(listeners.get(runId) ?? []), listener]));
      return () => {
        const remaining = [...(listeners.get(runId) ?? [])].filter((l) => l !== listener);
        listeners.set(runId, new Set(remaining));
      };
    },
  };
}
