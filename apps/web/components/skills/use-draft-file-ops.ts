"use client";

import {
  useCallback,
  useMemo,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { ApiError, ApiResult } from "../../lib/api/client";
import type { DraftClient } from "../../lib/skills/draft-client";
import type { Changed, DraftFileInfo, DraftSummary } from "../../lib/skills/drafts-api";
import type { ManifestDraftChoice, ManifestWritten } from "../../lib/skills/manifest-choice";
import {
  byteLength,
  MANIFEST,
  UNSAVED,
  type ManifestOutcome,
  type SaveStatus,
} from "./draft-editor-model";

export interface FileOpsInput {
  readonly api: DraftClient;
  readonly id: string;
  readonly texts: Readonly<Record<string, string>>;
  readonly rev: MutableRefObject<number>;
  readonly pending: MutableRefObject<Map<string, string>>;
  readonly stopped: MutableRefObject<boolean>;
  readonly setDraft: Dispatch<SetStateAction<DraftSummary | null>>;
  readonly setFiles: Dispatch<SetStateAction<readonly DraftFileInfo[]>>;
  readonly setTexts: Dispatch<SetStateAction<Readonly<Record<string, string>>>>;
  readonly setStatus: Dispatch<SetStateAction<SaveStatus>>;
  readonly schedule: () => void;
  readonly changed: (res: Changed) => void;
  readonly change: <T>(
    write: (rev: number) => Promise<ApiResult<T>>,
    apply: (data: T) => void,
  ) => Promise<ApiError | null>;
}

/** What the editor does to the draft's files and sharing; each change goes through the queue. */
export function useDraftFileOps({
  api,
  id,
  texts,
  rev,
  pending,
  stopped,
  setDraft,
  setFiles,
  setTexts,
  setStatus,
  schedule,
  changed,
  change,
}: FileOpsInput) {
  const edit = useCallback(
    (path: string, text: string) => {
      setTexts((t) => ({ ...t, [path]: text }));
      if (stopped.current) return;
      pending.current.set(path, text);
      setStatus("pending");
      schedule();
    },
    [schedule],
  );

  const open = useCallback(
    async (path: string) => {
      if (texts[path] !== undefined) return null;
      const res = await api.readText(id, path);
      if (!res.ok) return res.error;
      setTexts((t) => (t[path] === undefined ? { ...t, [path]: res.data } : t));
      return null;
    },
    [api, id, texts],
  );

  const addFile = useCallback(
    (path: string, text = "") =>
      change(
        (r) => api.put(id, path, r, text),
        (data) => {
          changed(data);
          const info: DraftFileInfo = {
            path,
            size: byteLength(text),
            kind: "text",
            updatedAt: data.draft.updatedAt,
          };
          setFiles((fs) => [...fs, info].sort((a, b) => a.path.localeCompare(b.path)));
          setTexts((t) => ({ ...t, [path]: text }));
        },
      ),
    [api, id, change, changed],
  );

  const manifestApi = api.manifest?.bind(api);
  const createManifest = useMemo(
    () =>
      manifestApi === undefined
        ? undefined
        : async (choice: ManifestDraftChoice): Promise<ManifestOutcome> => {
            let made: ManifestWritten | undefined;
            const err = await change(
              (r) => manifestApi(id, r, choice),
              (data) => {
                changed(data);
                made = data;
                const info: DraftFileInfo = {
                  path: MANIFEST,
                  size: 0,
                  kind: "text",
                  updatedAt: data.draft.updatedAt,
                };
                setFiles((fs) =>
                  [...fs.filter((f) => f.path !== MANIFEST), info].sort((a, b) =>
                    a.path.localeCompare(b.path),
                  ),
                );
              },
            );
            if (err) return { ok: false, error: err };
            if (!made) return { ok: false, error: UNSAVED };
            return { ok: true, ...made };
          },
    [manifestApi, id, change, changed],
  );

  const removeFile = useCallback(
    (path: string) => {
      pending.current.delete(path);
      return change(
        (r) => api.remove(id, path, r),
        (data) => {
          changed(data);
          setFiles((fs) => fs.filter((f) => f.path !== path));
          setTexts((t) => Object.fromEntries(Object.entries(t).filter(([p]) => p !== path)));
        },
      );
    },
    [api, id, change, changed],
  );

  const share = useCallback(
    (shared: boolean) =>
      change(
        (r) => api.share(id, r, shared),
        (next) => {
          rev.current = next.rev;
          setDraft(next);
        },
      ),
    [api, id, change],
  );
  return { edit, open, addFile, createManifest, removeFile, share };
}
