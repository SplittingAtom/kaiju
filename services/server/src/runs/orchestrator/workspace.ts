import type { AttachmentStager } from "../../uploads/attach.js";
import type { ViewingReader } from "../../workspace-files/viewing.js";

/**
 * What a run reads from the member's synced workspace. Both need workspace sync, which the
 * process builds after its dependencies (it needs their database), so they are read at call time.
 * Unbound, they fail closed: `file_ids` are refused `attachments_unavailable` (KOBE-144) and a
 * viewed file adds only its path (KOBE-462).
 */
export interface RunWorkspace {
  attachments(): AttachmentStager | undefined;
  viewing(): ViewingReader | undefined;
}

/** The seams workspace sync provides, bound once it exists (index.ts; tests bind their own). */
export interface RunWorkspaceSeams {
  readonly attachments?: AttachmentStager;
  readonly viewing?: ViewingReader;
}

/** A `RunWorkspace` bound once, like `NotebookFiles.use` and the project mounts. */
export interface RunWorkspaceSlot extends RunWorkspace {
  use(seams: RunWorkspaceSeams): void;
}

export function createRunWorkspace(): RunWorkspaceSlot {
  let bound: RunWorkspaceSeams = {};
  return {
    attachments: () => bound.attachments,
    viewing: () => bound.viewing,
    use(seams) {
      bound = { ...bound, ...seams };
    },
  };
}
