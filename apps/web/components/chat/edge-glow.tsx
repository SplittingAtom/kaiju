"use client";

import { useEffect, useState } from "react";
import { isNoticeClosed, subscribeClosedNotices } from "../../lib/chat/closed-notices";
import { edgeGlow, type EdgeGlow } from "../../lib/chat/edge-glow";
import type { ThreadState } from "../../lib/chat/thread-state";

/**
 * The conversation's edge glow (KOBE-840): "waiting" (gold) while the run waits for the member,
 * "error" (red) after a failed run until the next send or until its notice is closed. The thread
 * root carries it as `data-kaiju-edge-glow`; app/chat-global.css draws it from the theme tokens.
 * Closed notices are read after mount, as the notice itself does, so the server render agrees.
 */
export function useEdgeGlow(state: ThreadState): EdgeGlow | null {
  const [mounted, setMounted] = useState(false);
  const [closedHere, setClosedHere] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    setMounted(true);
    return subscribeClosedNotices((id) => setClosedHere((prev) => new Set([...prev, id])));
  }, []);
  return edgeGlow(state, (id) => closedHere.has(id) || (mounted && isNoticeClosed(id)));
}
