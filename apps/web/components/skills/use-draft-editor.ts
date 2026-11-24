"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiError, ApiResult } from "../../lib/api/client";
import { teamDraftClient, type DraftClient } from "../../lib/skills/draft-client";
import type { DraftFileInfo, DraftSummary } from "../../lib/skills/drafts-api";
import type { ManifestDraftChoice } from "../../lib/skills/manifest-choice";
import { SKILL_MD } from "../../lib/skills/skill-md";
import type { ManifestOutcome, SaveStatus } from "./draft-editor-model";
import { useDraftFileOps } from "./use-draft-file-ops";
import { useDraftWriter, useFlushOnLeave } from "./use-draft-writer";
import { useScanPreview, type ScanState } from "./use-scan-preview";

export type { ScanState } from "./use-scan-preview";
export { MANIFEST, SAVE_IDLE_MS, SAVE_MAX_WAIT_MS } from "./draft-editor-model";
export type { ManifestOutcome, SaveStatus } from "./draft-editor-model";

/**
 * The Workbench editor's state (KOBE-321, SK11/SK12). Edits autosave: a file is written once its
 * edits pause for {@link SAVE_IDLE_MS}, and at least every {@link SAVE_MAX_WAIT_MS} while typing
 * goes on. Every change of the draft (autosaves, new and deleted files, sharing) runs in one queue,
 * each naming the revision the one before returned, so the editor never conflicts with its own
 * writes (review S4). After a write the scan preview of the new revision is asked for, so lint
 * (computed on every keystroke) and the scan reflect an edit within 2 s. Leaving the editor (an
 * in-app link, the bar, the palette) writes what is pending (review B2); closing the tab asks
 * first. A stale revision (someone else saved) stops autosave until the draft is reloaded.
 */
export interface DraftEditor {
  readonly draft: DraftSummary;
  readonly files: readonly DraftFileInfo[];
  /** Loaded text of the files opened so far (SKILL.md always). */
  readonly texts: Readonly<Record<string, string>>;
  readonly status: SaveStatus;
  readonly error: ApiError | null;
  readonly scan: ScanState;
  /** Changes a text file (autosaved). */
  readonly edit: (path: string, text: string) => void;
  /** Loads a file's text to open it. */
  readonly open: (path: string) => Promise<ApiError | null>;
  /** Adds a text file (empty unless `text` is given), by the same write as an autosave. */
  readonly addFile: (path: string, text?: string) => Promise<ApiError | null>;
  /**
   * Create kaiju.skill.yaml with a model (KOBE-564): the file appears in the tree (open it to
   * read the text); the notice says which model wrote it. Absent where the client offers none.
   */
  readonly createManifest?: (choice: ManifestDraftChoice) => Promise<ManifestOutcome>;
  readonly removeFile: (path: string) => Promise<ApiError | null>;
  /** Shares the draft with the team's Builders and Team admins, or stops (author only). */
  readonly share: (shared: boolean) => Promise<ApiError | null>;
  /** Writes every pending edit now; the revision after them, or null when a write failed. */
  readonly flush: () => Promise<number | null>;
}

export type EditorLoad =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly error: ApiError }
  | { readonly status: "ready"; readonly editor: DraftEditor };

interface Loaded {
  readonly draft: DraftSummary;
  readonly files: readonly DraftFileInfo[];
  readonly texts: Readonly<Record<string, string>>;
}

async function loadDraft(client: DraftClient, id: string): Promise<ApiResult<Loaded>> {
  const res = await client.get(id);
  if (!res.ok) return res;
  const hasSkillMd = res.data.files.some((f) => f.path === SKILL_MD && f.kind === "text");
  const text = hasSkillMd ? await client.readText(id, SKILL_MD) : null;
  if (text && !text.ok) return text;
  const texts: Record<string, string> = text?.ok ? { [SKILL_MD]: text.data } : {};
  return { ok: true, status: 200, data: { draft: res.data.draft, files: res.data.files, texts } };
}

/**
 * `client`: where the draft lives; the active team's Workbench unless given (a Site draft of a
 * catalog skill, KOBE-495). Pass a stable object (memoized).
 */
export function useDraftEditor(teamId: string, id: string, client?: DraftClient): EditorLoad {
  const api = useMemo(() => client ?? teamDraftClient(teamId), [client, teamId]);
  const [load, setLoad] = useState<
    | { readonly status: "loading" }
    | { readonly status: "error"; readonly error: ApiError }
    | { readonly status: "ready"; readonly loaded: Loaded }
  >({ status: "loading" });

  useEffect(() => {
    let current = true;
    void loadDraft(api, id).then((res) => {
      if (!current) return;
      setLoad(
        res.ok ? { status: "ready", loaded: res.data } : { status: "error", error: res.error },
      );
    });
    return () => {
      current = false;
    };
  }, [api, id]);

  const editor = useEditorState(teamId, id, api, load.status === "ready" ? load.loaded : null);
  if (load.status === "error") return load;
  return load.status === "ready" && editor ? { status: "ready", editor } : { status: "loading" };
}

function useEditorState(
  teamId: string,
  id: string,
  api: DraftClient,
  loaded: Loaded | null,
): DraftEditor | null {
  const [draft, setDraft] = useState<DraftSummary | null>(null);
  const [files, setFiles] = useState<readonly DraftFileInfo[]>([]);
  const [texts, setTexts] = useState<Readonly<Record<string, string>>>({});
  const [status, setStatus] = useState<SaveStatus>("saved");
  const [error, setError] = useState<ApiError | null>(null);

  const rev = useRef(0);
  const currentRev = useCallback(() => rev.current, []);
  const scanFn = useCallback(
    (draftId: string, signal: AbortSignal) => api.scan(draftId, signal),
    [api],
  );
  const { scan, rescan } = useScanPreview(teamId, id, currentRev, scanFn);
  const writer = useDraftWriter({ api, id, rev, rescan, setDraft, setFiles, setStatus, setError });

  // Adopt a loaded draft once; start its first scan.
  useEffect(() => {
    if (!loaded) return;
    rev.current = loaded.draft.rev;
    setDraft(loaded.draft);
    setFiles(loaded.files);
    setTexts(loaded.texts);
    rescan();
  }, [loaded, rescan]);

  useFlushOnLeave(writer.pending, writer.flush, writer.idleTimer, writer.maxTimer);
  const { edit, open, addFile, createManifest, removeFile, share } = useDraftFileOps({
    api,
    id,
    texts,
    rev,
    pending: writer.pending,
    stopped: writer.stopped,
    setDraft,
    setFiles,
    setTexts,
    setStatus,
    schedule: writer.schedule,
    changed: writer.changed,
    change: writer.change,
  });
  const { flush } = writer;

  if (!draft) return null;
  return {
    draft,
    files,
    texts,
    status,
    error,
    scan,
    edit,
    open,
    addFile,
    ...(createManifest ? { createManifest } : {}),
    removeFile,
    share,
    flush,
  };
}
