"use client";

import { useAui } from "@assistant-ui/react";
import { useEffect } from "react";
import { stashDraftForReload, takeReloadDraft } from "../../lib/build/reload-draft";
import { useChatSession } from "./kaiju-runtime";

/**
 * The composer's text across the new-build banner's Reload (KOBE-487 ac-4): stashed as the page
 * unloads after Reload, and put back once when the composer shows the same draft (`draft` is the
 * thread id, or the new conversation's key) after the reload. Its file chips come back with it
 * (KOBE-756), checked again as picks.
 */
export function useReloadDraft(draft: string): void {
  const aui = useAui();
  const { mentions } = useChatSession();
  useEffect(() => {
    const kept = takeReloadDraft(draft);
    if (kept !== undefined) {
      aui.composer.setText(kept.text);
      mentions.restore(draft, kept.mentions);
    }
    const onHide = () =>
      stashDraftForReload(draft, aui.composer.getState().text, mentions.chips(draft));
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [draft, aui, mentions]);
}
