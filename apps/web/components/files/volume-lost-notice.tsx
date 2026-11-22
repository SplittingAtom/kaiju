"use client";

import { useEffect, useState } from "react";
import type { RebuildApi } from "../../lib/workspace/rebuild";
import { RebuildWorkspaceDialog } from "./rebuild-workspace-dialog";

/**
 * "The storage that held your sandbox was lost" with a Rebuild sandbox… button (KOBE-739). In the
 * conversation it follows a run that failed `workspace_volume_lost` (`known`); in the Files panel
 * it asks the server once whether the volume is lost and shows only then (`check`). Gone once the
 * member rebuilt the sandbox from the last sync of My files.
 */
export function VolumeLostNotice({
  api,
  mode,
}: {
  readonly api: RebuildApi;
  /** `known`: the caller already knows (a run failed so); `check`: ask the server first. */
  readonly mode: "known" | "check";
}) {
  const [lost, setLost] = useState(mode === "known");
  const [open, setOpen] = useState(false);
  const [rebuilt, setRebuilt] = useState(false);

  useEffect(() => {
    if (mode !== "check") return;
    let current = true;
    void api.status().then((res) => {
      if (current && res.ok && res.data.rebuildable) setLost(true);
    });
    return () => {
      current = false;
    };
  }, [api, mode]);

  if (!lost) return null;
  return (
    <div
      role={mode === "check" ? "alert" : undefined}
      className="m-0 grid gap-1 text-xs"
      data-volume-lost-notice
    >
      {rebuilt ? (
        <p className="m-0">
          Your sandbox is being rebuilt from the last sync of My files. Send a message to start it.
        </p>
      ) : (
        <p className="m-0">
          {/* In the conversation the run's own message has already said what happened. */}
          {mode === "check" &&
            "The storage that held your sandbox was lost with its server. You can rebuild it from the last sync of My files; changes after it can't be recovered. "}
          <button type="button" className="underline" onClick={() => setOpen(true)}>
            Rebuild sandbox…
          </button>
        </p>
      )}
      <RebuildWorkspaceDialog
        api={api}
        open={open}
        onOpenChange={setOpen}
        onRebuilt={() => setRebuilt(true)}
      />
    </div>
  );
}
