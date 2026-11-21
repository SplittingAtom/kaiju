/** MCP Apps in the rail (KOBE-440): launching an app card (KOBE-717 area). */
import type { FakeCore } from "./core";
import { error, json } from "./state";

export function launch(k: FakeCore, threadId: string, appId: unknown): Response {
  const app = k.teamApps.find((a) => a.appId === appId);
  if (!app) return error(404, "app_not_available", "This app is not available to you.");
  if (k.activeRun(threadId)) {
    k.counters.card += 1;
    const ref = `card-ref-${k.counters.card}`;
    k.queuedCards.set(threadId, [...(k.queuedCards.get(threadId) ?? []), { threadId, app, ref }]);
    k.appResults.set(threadId, [
      ...(k.appResults.get(threadId) ?? []),
      k.cardView(app, ref, `ka-${String(k.counters.card).padStart(24, "f")}`, true),
    ]);
    k.appResultBodies.set(ref, { id: ref });
    return json(201, { thread_id: threadId, result_ref: ref, queued: true });
  }
  const entryId = k.addAppCard(threadId, app);
  const ref = (k.appResults.get(threadId) ?? []).at(-1)?.result_ref;
  return json(201, { thread_id: threadId, entry_id: entryId, result_ref: ref, queued: false });
}
