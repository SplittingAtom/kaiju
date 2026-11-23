"use client";

/**
 * A workspace text file in the artifact column (KOBE-463, spec docs/specs/file-editor.md):
 * Rendered (today's renderers) and Raw (CodeMirror, loaded lazily) modes. Raw edits are kept as
 * a draft per file (the session's `editDrafts`) until saved; Save sends the version the draft was
 * based on, and a 409 says the file changed meanwhile (nothing is overwritten). Project files,
 * thread uploads and files over the preview cap open read-only with a notice. An agent proposal
 * under review (the session's `fileReviews`) replaces both modes with the inline diff
 * (`proposal-review.tsx`). KOBE-615: the editor fills the artifact column and follows its size;
 * one toolbar at the top holds Save, Save As (also for read-only files, into My files) and the
 * Rendered/Raw switch, plus a runnable file's Run and kernel controls (`actions`, `status`); a
 * run's output opens below the code in a split (`output`).
 */
import { SaveIcon, SaveAllIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { OutsideChange } from "./use-outside-change";
import type { ApiError } from "../../lib/api/client";
import type { FilesApi } from "../../lib/files/api";
import { useWorkspaceProjects } from "../projects/workspace-projects";
import { editBlockReason } from "../../lib/files/editor";
import type { EditDraftStore, FileReviewStore } from "../../lib/files/editor-state";
import { fileVersion } from "../../lib/files/outside-change";
import { defaultModeOf, fileName, previewOf } from "../../lib/files/preview";
import { ErrorNotice } from "../admin/error-notice";
import {
  ChangedBadge,
  ChangesStatus,
  CompareView,
  LIVE_OFF_NOTE,
  OutsideChoices,
  TAKE_THEIRS_PROMPT,
  UPDATED_NOTE,
} from "./outside-change-notice";
import { useDraft, useReview, useSave, type SaveState } from "./editor-save";
import { EditorToolbar, ModeSwitch, type ToolbarAction } from "./editor-toolbar";
import { ProposalReview } from "./proposal-review";
import { SaveAsForm } from "./save-as";
import { SplitPane } from "./split-pane";
import type { SelectedLines } from "./code-editor";
import { BUTTON, EditorFallback, TextModeBody, type TextMode } from "./text-modes";

export { BUTTON, EditorFallback };
export {
  CONFLICT_NOTICE,
  SaveNotices,
  useDraft,
  useReview,
  useSave,
  type SaveState,
} from "./editor-save";

const CHANGED_AGAIN: ApiError = {
  status: 409,
  code: "version_conflict",
  message:
    "The file changed again, so nothing was saved. Compare again, or Keep mine to save over the newest version.",
};
const DISCARD_PROMPT = (name: string) => `Discard your unsaved changes to ${name}?`;

/** Asks before the page unloads while any file has unsaved changes. */
export function useUnsavedGuard(drafts: EditDraftStore): void {
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (!drafts.hasAny()) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [drafts]);
}

/** Whether the file's tab may close: no unsaved draft, or the member agreed to drop it. */
export function confirmDiscard(drafts: EditDraftStore, path: string): boolean {
  if (drafts.get(path) === undefined) return true;
  if (!window.confirm(DISCARD_PROMPT(fileName(path)))) return false;
  drafts.clear(path);
  return true;
}

/** A run's output under the code (KOBE-615): the split shows while `node` is given. */
export interface EditorOutput {
  readonly label: string;
  readonly node: ReactNode;
  /** In the pane's header instead of its label (the run pane's tabs, KOBE-804). */
  readonly header?: ReactNode;
  onClose(): void;
}

/**
 * What a runnable file's controls get from the editor (KOBE-805): save before running, and the
 * lines selected in Raw for Run selection.
 */
export interface EditorRunContext {
  /** Saves unsaved changes (if any); true once the saved file holds what is on screen. */
  saveFirst(): Promise<boolean>;
  /** The selected lines in Raw; null without a selection or in Rendered. */
  readonly selection: SelectedLines | null;
  /** Unsaved changes on screen. */
  readonly dirty: boolean;
}

/** Save As's toolbar action (KOBE-615): folds into More when the toolbar is narrow. */
export const saveAsAction = (onSelect: () => void): ToolbarAction => ({
  id: "save-as",
  label: "Save As",
  icon: SaveAllIcon,
  overflow: true,
  onSelect,
});

/** Save's toolbar action: enabled while there is something to save. */
export function saveAction(
  state: SaveState,
  canSave: boolean,
  onSelect: () => void,
): ToolbarAction {
  const saving = state.status === "saving";
  return {
    id: "save",
    label: "Save",
    text: saving ? "Saving…" : "Save",
    icon: SaveIcon,
    busy: saving,
    disabled: !canSave || saving,
    reason: saving ? undefined : "Nothing to save: no unsaved changes.",
    onSelect,
  };
}

export interface FileEditorProps {
  readonly path: string;
  /** The file as read. */
  readonly text: string;
  /** The version read; undefined when the read was cut (then it cannot be saved whole). */
  readonly sha256: string | undefined;
  readonly truncated: boolean;
  readonly api: FilesApi;
  readonly drafts: EditDraftStore;
  readonly reviews: FileReviewStore;
  /** A save went through: the tab shows `text` at version `sha256`. */
  onSaved(text: string, sha256: string): void;
  /** Read the file again (after a conflict). */
  onReload(): void;
  /** The file changed outside this tab (KOBE-491): read in, or waiting behind a draft. */
  readonly outside?: OutsideChange | null | undefined;
  /** Keep mine on the banner (or a save over the agent's version): stop showing it. */
  onOutsideDismiss?(): void;
  /** The badge's Reload (KOBE-496): read someone else's change in. */
  onOutsideReload?(): void;
  /** Past the change stream's path limit: this tab gets no live changes (KOBE-496). */
  readonly liveOff?: boolean | undefined;
  /** Save As saved a copy: open that path in this tab (KOBE-615). */
  readonly onOpenPath?: ((path: string) => void) | undefined;
  /** The member opened this file: Raw may take the cursor when it opens (KOBE-802). */
  readonly takeFocus?: boolean | undefined;
  /**
   * More toolbar actions after Save and Save As (a `.py` file's Run and kernel controls); a
   * function gets the run context (KOBE-805).
   */
  readonly actions?:
    readonly ToolbarAction[] | ((ctx: EditorRunContext) => readonly ToolbarAction[]) | undefined;
  /** Shift+Enter / Mod+Enter in Raw (KOBE-805): run the selection, or all of the file. */
  readonly onRunKey?: ((ctx: EditorRunContext, scope: "all" | "selection") => void) | undefined;
  /** Go to this line in Raw each time `seq` changes (an error's line, KOBE-804). */
  readonly reveal?: { readonly line: number; readonly seq: number } | undefined;
  /** At the toolbar's end (the kernel's state). */
  readonly status?: ReactNode;
  /** Under the toolbar (the kernel's notices). */
  readonly notices?: ReactNode;
  /** A run's output: the editor splits, code on top. */
  readonly output?: EditorOutput | null | undefined;
}

export function FileEditor(props: FileEditorProps) {
  const { path, text, sha256, truncated, drafts, reviews } = props;
  const draft = useDraft(drafts, path);
  const review = useReview(reviews, path);
  const [mode, setMode] = useState<TextMode>(() =>
    draft === undefined ? (drafts.chosenModes.get(path) ?? defaultModeOf(path)) : "raw",
  );
  // The cursor goes into the editor only when the file opened in Raw by itself (KOBE-802).
  const [openedRaw] = useState(props.takeFocus === true && mode === "raw");
  const [savingAs, setSavingAs] = useState(false);
  const [selection, setSelection] = useState<SelectedLines | null>(null);
  // Going to a line shows the code in Raw.
  const revealSeq = props.reveal?.seq;
  useEffect(() => {
    if (revealSeq !== undefined) setMode("raw");
  }, [revealSeq]);
  const [savedAs, setSavedAs] = useState<string | null>(null);
  const { state, save, reset } = useSave(props.api, path, (saved, version) => {
    // Keystrokes typed while the save was in flight stay unsaved, now based on the new version.
    const latest = drafts.get(path);
    if (latest === undefined || latest.text === saved) drafts.clear(path);
    else drafts.set(path, { text: latest.text, baseSha256: version });
    props.onSaved(saved, version);
  });
  const outside = useOutsideChoices(props, draft, state, { save, reset });
  const projects = useWorkspaceProjects() ?? undefined;
  const blocked =
    editBlockReason(path, truncated, projects) ??
    (sha256 === undefined ? "This file's version is unknown, so it opens read-only." : undefined);
  const current = draft?.text ?? text;
  const base = draft?.baseSha256 ?? sha256;
  const name = fileName(path);
  const edit = (next: string) => {
    if (base === undefined) return;
    if (next === text && base === sha256) drafts.clear(path);
    else drafts.set(path, { text: next, baseSha256: base });
    if (state.status === "saved") reset();
  };

  if (review !== undefined) {
    return (
      <ProposalReview
        key={review.toolCallId}
        {...props}
        review={review}
        dirty={draft !== undefined}
      />
    );
  }
  const savedCopy = (to: string) => {
    setSavingAs(false);
    // The copy has the unsaved changes; the file itself stays as saved.
    drafts.clear(path);
    if (props.onOpenPath) props.onOpenPath(to);
    else setSavedAs(to);
  };
  const canSave = blocked === undefined && draft !== undefined && base !== undefined;
  const saveNow = () => {
    if (canSave && state.status !== "saving") void save(base, current);
  };
  const runContext: EditorRunContext = {
    saveFirst: async () => {
      if (draft === undefined) return true;
      // Never a second save of the same version while one is in flight (review M1).
      if (!canSave || state.status === "saving") return false;
      return (await save(base, current)) === "saved";
    },
    selection: mode === "raw" ? selection : null,
    dirty: draft !== undefined,
  };
  const extra = typeof props.actions === "function" ? props.actions(runContext) : props.actions;
  const onRunKey = props.onRunKey;
  const actions: ToolbarAction[] = [
    ...(blocked === undefined ? [saveAction(state, canSave, saveNow)] : []),
    saveAsAction(() => setSavingAs(true)),
    ...(extra ?? []),
  ];
  const updated =
    props.outside?.kind === "updated" && props.outside.sha256 === sha256 && draft === undefined;
  const body =
    outside.comparing && draft !== undefined ? (
      <CompareView
        api={props.api}
        path={path}
        name={name}
        draft={current}
        onDraft={edit}
        onTheirs={outside.setTheirs}
      />
    ) : (
      <div
        data-kobe-editor-body={mode}
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto"
      >
        <TextModeBody
          mode={mode}
          text={current}
          preview={previewOf(path)}
          label={`Edit ${name}`}
          readOnly={blocked !== undefined}
          autoFocus={openedRaw}
          onChange={edit}
          keys={{
            // Mod+S never opens the browser's Save page in the editor (KOBE-805).
            onSave: saveNow,
            onSelectionLines: setSelection,
            ...(onRunKey ? { onRun: (scope) => onRunKey(runContext, scope) } : {}),
            ...(props.reveal ? { reveal: props.reveal } : {}),
          }}
        />
      </div>
    );
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2" data-kobe-file-editor={path}>
      <EditorToolbar
        label={`${name} view`}
        leading={
          <ModeSwitch
            mode={mode}
            onMode={(next) => {
              drafts.chosenModes.set(path, next);
              setMode(next);
            }}
          />
        }
        actions={actions}
        status={props.status}
      />
      {savingAs && (
        <SaveAsForm
          api={props.api}
          path={path}
          text={current}
          truncated={truncated}
          checkedOut={projects?.checkedOut}
          onSaved={savedCopy}
          onCancel={() => setSavingAs(false)}
        />
      )}
      <ChangesStatus>
        {props.outside?.kind === "remote" && draft === undefined && (
          <ChangedBadge
            by={props.outside.by}
            name={name}
            onReload={() => (props.onOutsideReload ?? props.onReload)()}
          />
        )}
      </ChangesStatus>
      {props.liveOff === true && (
        <p role="note" className="text-muted-foreground text-xs">
          {LIVE_OFF_NOTE}
        </p>
      )}
      <p role="status" className="text-muted-foreground text-xs empty:hidden">
        {draft !== undefined
          ? "Unsaved changes."
          : state.status === "saved"
            ? "Saved."
            : savedAs !== null
              ? `Saved a copy as ${savedAs}.`
              : updated
                ? UPDATED_NOTE
                : ""}
      </p>
      {blocked !== undefined && (
        <p role="note" className="text-muted-foreground text-xs">
          {blocked}
        </p>
      )}
      {state.status === "error" && <ErrorNotice error={state.error} />}
      {outside.mode !== null && (
        <OutsideChoices
          mode={outside.mode}
          by={props.outside?.kind === "changed" ? props.outside.by : undefined}
          busy={state.status === "saving"}
          comparing={outside.comparing}
          onCompare={outside.toggleCompare}
          onKeepMine={() => void outside.keepMine(current)}
          onTakeTheirs={outside.takeTheirs}
        />
      )}
      {outside.error && <ErrorNotice error={outside.error} />}
      {props.notices}
      {props.output !== undefined ? (
        // A runnable file always renders the split, so opening its output keeps the editor (and
        // its cursor and undo history) in place.
        <SplitPane
          top={body}
          bottom={props.output?.node ?? null}
          bottomLabel={props.output?.label ?? ""}
          header={props.output?.header}
          onClose={props.output?.onClose ?? (() => {})}
        />
      ) : (
        body
      )}
    </div>
  );
}

/**
 * The banner and conflict choices (KOBE-491). The agent's version is named once: by Compare's
 * read, by the change that raised the banner, or by a version read when a save was refused; Keep
 * mine saves over exactly that version, so a newer change is refused again, never overwritten.
 */
function useOutsideChoices(
  props: FileEditorProps,
  draft: { readonly text: string } | undefined,
  state: SaveState,
  saver: Pick<ReturnType<typeof useSave>, "save" | "reset">,
) {
  const { api, path, drafts, outside } = props;
  const [comparing, setComparing] = useState(false);
  const [theirs, setTheirs] = useState<{ readonly sha256: string } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const conflict = state.status === "conflict";
  const banner = outside?.kind === "changed" && draft !== undefined;
  // A refused save: name the version that is there now.
  useEffect(() => {
    if (!conflict) return;
    let current = true;
    void fileVersion(api, path).then((v) => {
      if (current && v.kind === "version") setTheirs((t) => t ?? { sha256: v.sha256 });
    });
    return () => {
      current = false;
    };
  }, [conflict, api, path]);
  const done = () => {
    setComparing(false);
    setTheirs(null);
    setError(null);
  };
  const keepMine = async (text: string) => {
    setError(null);
    if (!conflict) {
      // The banner's Keep mine: nothing is saved yet; Save asks again.
      setComparing(false);
      props.onOutsideDismiss?.();
      return;
    }
    const base = theirs?.sha256 ?? (outside?.kind === "changed" ? outside.sha256 : undefined);
    if (base === undefined) return;
    const result = await saver.save(base, text);
    if (result === "saved") {
      done();
      props.onOutsideDismiss?.();
      return;
    }
    if (result !== "conflict") return;
    // It changed again since that version: say so, and name the newest for the next Keep mine.
    setError(CHANGED_AGAIN);
    const latest = await fileVersion(api, path);
    setTheirs(latest.kind === "version" ? { sha256: latest.sha256 } : null);
  };
  const takeTheirs = () => {
    if (!window.confirm(TAKE_THEIRS_PROMPT(fileName(path)))) return;
    drafts.clear(path);
    done();
    saver.reset();
    props.onReload();
  };
  return {
    mode: conflict ? ("conflict" as const) : banner ? ("banner" as const) : null,
    comparing: comparing && (conflict || banner),
    toggleCompare: () => setComparing((c) => !c),
    setTheirs,
    keepMine,
    takeTheirs,
    error,
  };
}
