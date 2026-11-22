"use client";

import { useEffect, useState } from "react";
import { Dialog } from "radix-ui";
import {
  NEVER_SYNCED,
  NODE_MAY_RETURN,
  syncTimeText,
  type RebuildApi,
  type RebuildStatus,
} from "../../lib/workspace/rebuild";
import { Button } from "../ui/button";
import { chatPortalContainer } from "../ui/chat-portal";

type Phase =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "ready"; readonly status: RebuildStatus }
  | { readonly kind: "rebuilding"; readonly status: RebuildStatus }
  | { readonly kind: "done"; readonly already: boolean };

/**
 * Rebuild a workspace whose storage was lost with its server (KOBE-739). Member-confirmed: the
 * dialog first reads the volume's state and the last sync time and says, in plain words, what will
 * be lost (changes after that time, and what the sync never copies), then the member (or a team
 * admin, for `memberName`) confirms. A volume that is not lost is never offered for a rebuild.
 */
export function RebuildWorkspaceDialog({
  api,
  open,
  onOpenChange,
  memberName,
  onRebuilt,
}: {
  readonly api: RebuildApi;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** A team admin rebuilding this member's workspace; absent: the caller's own. */
  readonly memberName?: string | undefined;
  readonly onRebuilt?: (() => void) | undefined;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const whose = memberName === undefined ? "your" : `${memberName}'s`;

  useEffect(() => {
    if (!open) return;
    let current = true;
    setPhase({ kind: "loading" });
    void api.status().then((res) => {
      if (!current) return;
      setPhase(
        res.ok
          ? { kind: "ready", status: res.data }
          : { kind: "failed", message: res.error.message },
      );
    });
    return () => {
      current = false;
    };
  }, [api, open]);

  async function confirm(status: RebuildStatus) {
    setPhase({ kind: "rebuilding", status });
    const res = await api.confirm();
    if (res.ok) {
      setPhase({ kind: "done", already: res.data.status === "already" });
      onRebuilt?.();
    } else {
      setPhase({ kind: "failed", message: res.error.message });
    }
  }

  const status = phase.kind === "ready" || phase.kind === "rebuilding" ? phase.status : null;
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal container={chatPortalContainer()}>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" data-kobe-portal />
        <Dialog.Content
          className="bg-background text-foreground fixed top-1/2 left-1/2 z-50 grid w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 gap-3 rounded-lg border p-5 shadow-lg"
          data-rebuild-workspace-dialog
          data-kobe-portal
        >
          <Dialog.Title className="m-0 text-base font-semibold">
            Rebuild {whose} sandbox from the last sync?
          </Dialog.Title>
          <Dialog.Description className="text-muted-foreground m-0 text-sm">
            {phase.kind === "loading" && "Checking the sandbox's storage…"}
            {phase.kind === "done" &&
              (phase.already
                ? "The sandbox was already rebuilt."
                : "The sandbox is being rebuilt from the last sync of My files.")}
            {phase.kind === "failed" && phase.message}
            {status && !status.rebuildable && notLostText(status)}
            {status?.rebuildable &&
              (status.volume === "rebuilding"
                ? `The rebuild of ${whose} sandbox was confirmed but has not finished. Kobe keeps trying on its own; you can also finish it now.`
                : `The storage that held ${whose} sandbox is lost: the server it lived on has been gone too long. Kobe can rebuild the sandbox from the last sync of My files.`)}
          </Dialog.Description>
          {status?.rebuildable && (
            <div className="grid gap-2 text-sm">
              <p className="m-0">
                Last sync: <strong>{syncTimeText(status.lastSyncedAt)}</strong>
              </p>
              <p className="m-0">
                Lost for good: every change made after the last sync, and what the sync never copies
                ({NEVER_SYNCED}). Conversations are not affected.
              </p>
              <p className="m-0">{NODE_MAY_RETURN}</p>
            </div>
          )}
          {phase.kind === "done" && (
            <p className="m-0 text-sm">
              Send a message (or retry the last one) to start it: the first start takes a little
              longer while the files come back.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button type="button" variant="outline">
                {phase.kind === "done" || !status?.rebuildable ? "Close" : "Cancel"}
              </Button>
            </Dialog.Close>
            {status?.rebuildable && (
              <Button
                type="button"
                variant="destructive"
                disabled={phase.kind === "rebuilding"}
                onClick={() => void confirm(status)}
              >
                {phase.kind === "rebuilding" ? "Rebuilding…" : "Rebuild sandbox"}
              </Button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function notLostText(status: RebuildStatus): string {
  if (status.volume === "unreachable") {
    const since = syncTimeText(status.downSince ?? null);
    const offer = syncTimeText(status.offerAt ?? null);
    return `The server that holds the sandbox's storage isn't answering (since ${since}). It may come back with the files, so the rebuild is offered only if it stays down until ${offer}.`;
  }
  if (status.volume === "unknown") {
    return "Kobe couldn't check the sandbox's storage right now, so it can't be rebuilt. Try again in a moment.";
  }
  return "The sandbox's storage isn't lost, so there is nothing to rebuild. If it still doesn't start, ask your site admin.";
}
