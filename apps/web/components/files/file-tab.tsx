"use client";

/**
 * A workspace file as a tab of the artifact column (KOBE-268), from the synced
 * workspace (so it works while the sandbox hibernates and shows the last-synced version). The read
 * itself tells whether the file still exists (404: `onGone`, its tab closes; `content_missing`:
 * the file is there but its saved copy is not, so the tab stays and says so, KOBE-475) and its size
 * (Content-Length); files that aren't shown inline (HTML, PDF, unknown) are read headers only. Renderers reuse the artifact views:
 * Markdown, CSV/TSV tables, code and text as fenced blocks, JSON pretty-printed, images and SVG
 * as `<img>` from a `data:` URL (never inline SVG markup) in the image viewer (KOBE-807: zoom,
 * fit, pan, dimensions), HTML in the sandboxed frame served by
 * `/v1/workspace/frame` (same sandbox and CSP as artifact frames), PDFs in the pdf.js viewer
 * (KOBE-801, `pdf-viewer.tsx`, loaded on first use; up to 25 MB). Anything else: Cannot preview,
 * with Download; a file over its kind's cap says the limit, with Download (KOBE-807). Text is
 * read up to 1 MB; large images and PDFs are not fetched. Text files
 * open in the file editor (KOBE-463, `file-editor.tsx`): Rendered and Raw modes, Save, and the
 * review of the agent's proposals; the version a save names is the SHA-256 of the bytes read. The
 * editor fills the tab and follows the column's size (KOBE-615); Save As opens the copy here.
 * An open text tab follows outside changes to its file (KOBE-491, `use-outside-change.ts`); the
 * page's change stream says who changed it (KOBE-496, `lib/files/remote-changes.ts`).
 */
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { CheckIcon, ClipboardCopyIcon } from "lucide-react";
import { NOTEBOOK_FILE_MAX_BYTES, sandboxPathOf } from "@kobe/protocol";
import { copyText } from "../../lib/clipboard";
import type { ApiError } from "../../lib/api/client";
import type { FilesApi } from "../../lib/files/api";
import { isTextPreview, sha256Hex } from "../../lib/files/editor";
import type { EditDraftStore, FileReviewStore } from "../../lib/files/editor-state";
import { contentMissingMessage, describeFileError } from "../../lib/files/format";
import {
  cutTextMessage,
  decodePreviewText,
  fileName,
  HTML_FRAME_MAX_BYTES,
  IMAGE_PREVIEW_MAX_BYTES,
  imageDataUrl,
  PDF_PREVIEW_MAX_BYTES,
  previewOf,
  TEXT_PREVIEW_MAX_BYTES,
  tooLargeMessage,
  workspaceFrameUrl,
  type FilePreview,
} from "../../lib/files/preview";
import { saveBytes } from "../../lib/files/save";
import { ARTIFACT_FRAME_SANDBOX } from "../../lib/chat/artifacts";
import { ErrorNotice } from "../admin/error-notice";
import { useArtifactPanel } from "../chat/artifact-state";
import { EditorFallback, FileEditor } from "./file-editor";
import type { KernelWiring } from "../notebooks/use-kernel";
import { TextView } from "./text-view";
import type { ChangeHint } from "../chat/use-file-change-hint";
import { useOutsideChange, type OutsideChange } from "./use-outside-change";
import { useRemoteChange } from "./use-remote-change";
import type { WorkspaceChangeFeed } from "../../lib/files/remote-changes";
import { IconAction } from "../shell/icon-action";
import { AddToProject } from "../projects/add-to-project";
import { CannotPreview } from "./cannot-preview";
import { ImageViewer } from "./image-viewer";
import { Button } from "../ui/button";
import { ProjectFileBar } from "../projects/project-file-bar";
import styles from "../chat/chat.module.css";

// Notebooks and the `.py` editor with Run load only when such a file opens (KOBE-465).
const NotebookView = lazy(() => import("../notebooks/notebook-view"));
const PythonFile = lazy(() => import("../notebooks/python-run"));
// pdf.js and its viewer load only when a PDF opens (KOBE-801).
const PdfViewer = lazy(() => import("./pdf-viewer"));

const isNotebook = (path: string) => path.toLowerCase().endsWith(".ipynb");
const isPython = (path: string) => path.toLowerCase().endsWith(".py");

type Loaded =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly error: ApiError }
  | { readonly status: "none" | "frame" }
  /** The file exists; its saved copy is missing until the sandbox resends it (KOBE-475). */
  | { readonly status: "missing" }
  /** Over its kind's cap: the message names the size and the limit (KOBE-807). */
  | { readonly status: "too_large"; readonly reason: string }
  | { readonly status: "image"; readonly src: string; readonly size: number }
  | { readonly status: "pdf"; readonly bytes: Uint8Array }
  | {
      readonly status: "text";
      readonly text: string;
      readonly truncated: boolean;
      readonly size: number | null;
      /** The version read (SHA-256); absent for a cut read. */
      readonly sha256?: string | undefined;
    };

const GONE = "gone";

/** The bytes to read for a preview, and whether only the whole file will do. */
function readPlan(
  preview: FilePreview,
  path: string,
): { readonly max: number; readonly wholeOnly: boolean } {
  // A notebook opens whole up to the server's notebook limit (outputs with images are large).
  if (isNotebook(path)) return { max: NOTEBOOK_FILE_MAX_BYTES, wholeOnly: false };
  switch (preview.kind) {
    case "none":
    case "html":
      return { max: 0, wholeOnly: true }; // headers only: whether it exists, and its size
    case "image":
    case "svg":
      return { max: IMAGE_PREVIEW_MAX_BYTES, wholeOnly: true };
    case "pdf":
      return { max: PDF_PREVIEW_MAX_BYTES, wholeOnly: true };
    default:
      return { max: TEXT_PREVIEW_MAX_BYTES, wholeOnly: false };
  }
}

/** What the tab shows for `path`, or GONE when the read says the file no longer exists. */
async function load(api: FilesApi, path: string, preview: FilePreview): Promise<Loaded | "gone"> {
  const plan = readPlan(preview, path);
  const read = await api.read(path, plan.max, plan.wholeOnly);
  if (!read.ok) {
    if (read.error.code === "content_missing") return { status: "missing" };
    return read.error.status === 404
      ? GONE
      : { status: "error", error: describeFileError(read.error) };
  }
  const { bytes, truncated, size } = read.data;
  switch (preview.kind) {
    case "none":
      return { status: "none" };
    case "html":
      return size !== null && size > HTML_FRAME_MAX_BYTES
        ? { status: "too_large", reason: tooLargeMessage(preview, size) }
        : { status: "frame" };
    case "image":
    case "svg":
      return truncated
        ? { status: "too_large", reason: tooLargeMessage(preview, size) }
        : { status: "image", src: imageDataUrl(bytes, preview.mime), size: bytes.length };
    case "pdf":
      return truncated
        ? { status: "too_large", reason: tooLargeMessage(preview, size) }
        : { status: "pdf", bytes };
    default: {
      const text = decodePreviewText(bytes, truncated);
      if (text === null) return { status: "none" };
      const sha256 = truncated ? undefined : await sha256Hex(bytes);
      return { status: "text", text, truncated, size, sha256 };
    }
  }
}

/**
 * The file's preview, read again on each new `reload` (the member opened it again) and on
 * `reread()`; `saved` shows what the editor just saved without reading it back.
 */
function useFilePreview(
  api: FilesApi,
  path: string,
  reload: number,
  onGone: (path: string) => void,
) {
  const [state, setState] = useState<Loaded>({ status: "loading" });
  const [reads, setReads] = useState(0);
  const reread = useCallback(() => setReads((n) => n + 1), []);
  const saved = useCallback(
    (text: string, sha256: string) =>
      setState({ status: "text", text, truncated: false, size: null, sha256 }),
    [],
  );
  useEffect(() => {
    let current = true;
    void load(api, path, previewOf(path)).then((loaded) => {
      if (!current) return;
      if (loaded === GONE) onGone(path);
      else setState(loaded);
    });
    return () => {
      current = false;
    };
  }, [api, path, reload, onGone, reads]);
  return { loaded: state, reread, saved };
}

/** What the editor needs beyond the read: the stores and what to do after a save or conflict. */
interface EditorWiring {
  readonly api: FilesApi;
  readonly drafts: EditDraftStore;
  readonly reviews: FileReviewStore;
  saved(text: string, sha256: string): void;
  reread(): void;
  /** The conversation's kernel (KOBE-465): notebooks and `.py` files run in it. */
  readonly kernel?: KernelWiring | undefined;
  /** An outside change to the file (KOBE-491) and the banner's Keep mine. */
  readonly outside: OutsideChange | null;
  dismissOutside(): void;
  /** The badge's Reload (KOBE-496). */
  reloadOutside(): void;
  /** Past the change stream's path limit: no live changes for this tab (KOBE-496). */
  readonly liveOff: boolean;
  /** Save As saved a copy: this tab opens it (KOBE-615). */
  readonly onOpenPath?: ((path: string) => void) | undefined;
  readonly takeFocus?: boolean | undefined;
}

/** The PDF and image viewers fill the tab edge to edge, with their own toolbar and scrolling. */
function fillsBare(loaded: Loaded): boolean {
  return loaded.status === "pdf" || loaded.status === "image";
}

/** Whether the tab shows the file editor, a notebook or a viewer, which fill the tab themselves. */
function fillsTab(loaded: Loaded, path: string, editor: EditorWiring | undefined): boolean {
  if (fillsBare(loaded)) return true;
  return (
    editor !== undefined &&
    loaded.status === "text" &&
    (isNotebook(path) || isTextPreview(previewOf(path)))
  );
}

/** A text file in the editor; a `.py` file with the kernel gets Run and the output split. */
function TextFileEditor({
  path,
  loaded,
  editor,
}: {
  readonly path: string;
  readonly loaded: Extract<Loaded, { status: "text" }>;
  readonly editor: EditorWiring;
}) {
  const props = {
    path,
    text: loaded.text,
    sha256: loaded.sha256,
    truncated: loaded.truncated,
    api: editor.api,
    drafts: editor.drafts,
    reviews: editor.reviews,
    onSaved: editor.saved,
    onReload: editor.reread,
    outside: editor.outside,
    onOutsideDismiss: editor.dismissOutside,
    onOutsideReload: editor.reloadOutside,
    liveOff: editor.liveOff,
    onOpenPath: editor.onOpenPath,
    takeFocus: editor.takeFocus,
  };
  if (isPython(path) && editor.kernel) {
    return (
      <Suspense fallback={<EditorFallback />}>
        <PythonFile {...props} kernel={editor.kernel} />
      </Suspense>
    );
  }
  return <FileEditor {...props} />;
}

function FileBody({
  loaded,
  path,
  teamId,
  editor,
  onDownload,
}: {
  readonly loaded: Loaded;
  readonly path: string;
  readonly teamId: string;
  readonly editor?: EditorWiring | undefined;
  onDownload(): void;
}) {
  const name = fileName(path);
  switch (loaded.status) {
    case "loading":
      return <p role="status">Loading the file…</p>;
    case "error":
      return <ErrorNotice error={loaded.error} />;
    case "missing":
      return <p role="status">{contentMissingMessage(name)}</p>;
    case "none":
      return <CannotPreview reason="Cannot preview this file." onDownload={onDownload} />;
    case "too_large":
      return <CannotPreview reason={loaded.reason} onDownload={onDownload} />;
    case "pdf":
      return (
        <Suspense fallback={<p role="status">Opening the PDF…</p>}>
          <PdfViewer bytes={loaded.bytes} name={name} onDownload={onDownload} />
        </Suspense>
      );
    case "frame":
      return (
        <iframe
          title={name}
          src={workspaceFrameUrl(path, teamId)}
          sandbox={ARTIFACT_FRAME_SANDBOX}
          referrerPolicy="no-referrer"
          className="h-full min-h-80 w-full rounded-md border bg-white"
        />
      );
    case "image":
      return <ImageViewer src={loaded.src} name={name} size={loaded.size} />;
    case "text":
      return (
        <>
          {loaded.truncated && (
            <p role="status" className="text-muted-foreground mb-2 shrink-0 text-xs">
              {`${cutTextMessage(loaded.size)} Use Download to get all of it. `}
              <Button
                type="button"
                variant="link"
                size="xs"
                className="h-auto p-0"
                onClick={onDownload}
              >
                Download
              </Button>
            </p>
          )}
          {editor && isNotebook(path) ? (
            <Suspense fallback={<EditorFallback />}>
              <NotebookView
                path={path}
                text={loaded.text}
                sha256={loaded.sha256}
                truncated={loaded.truncated}
                files={editor.api}
                drafts={editor.drafts}
                reviews={editor.reviews}
                kernel={editor.kernel}
                onSaved={editor.saved}
                onReload={editor.reread}
                onOpenPath={editor.onOpenPath}
              />
            </Suspense>
          ) : editor && isTextPreview(previewOf(path)) ? (
            <TextFileEditor path={path} loaded={loaded} editor={editor} />
          ) : (
            <TextView text={loaded.text} preview={previewOf(path)} />
          )}
        </>
      );
  }
}

/** Copy path (KOBE-806): the sandbox path the agent sees, the one an @file mention rewrites to. */
function CopyPath({ path }: { readonly path: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () => {
    const done = (next: "copied" | "failed") => {
      setState(next);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setState("idle"), 2000);
    };
    copyText(sandboxPathOf(path)).then(
      () => done("copied"),
      () => done("failed"),
    );
  };
  return (
    <>
      <IconAction
        command="copy-file-path"
        label={`Copy the path of ${fileName(path)}`}
        onClick={copy}
      >
        {state === "copied" ? <CheckIcon aria-hidden /> : <ClipboardCopyIcon aria-hidden />}
      </IconAction>
      <span role="status" className="text-muted-foreground text-xs empty:hidden">
        {state === "copied" ? "Path copied" : state === "failed" ? "Copy failed" : ""}
      </span>
    </>
  );
}

/** One file tab's header (name, Download) and body. `titleId` labels the column. */
export function FileTabContent({
  path,
  api,
  teamId,
  titleId,
  reload,
  onGone,
  drafts,
  reviews,
  kernel,
  changeHint,
  changes,
  owner = false,
  focusOnOpen = false,
  onOpenPath,
}: {
  readonly path: string;
  readonly api: FilesApi;
  readonly teamId: string;
  readonly titleId: string;
  /** A new value reads the file again (it was opened again from Files). */
  readonly reload: number;
  onGone(path: string): void;
  /** The file editor's state (KOBE-463); without it, text is shown read-only. */
  readonly drafts?: EditDraftStore | undefined;
  readonly reviews?: FileReviewStore | undefined;
  /** The conversation's kernel (KOBE-465); without it, notebooks and `.py` files do not run. */
  readonly kernel?: KernelWiring | undefined;
  /** When to check whether the file changed outside this tab (KOBE-491). */
  readonly changeHint?: ChangeHint | null | undefined;
  /** The page's change stream (KOBE-496): who changed the file, live. */
  readonly changes?: WorkspaceChangeFeed | undefined;
  /** The viewer is the conversation's owner: Add to project is offered (KOBE-585). */
  readonly owner?: boolean | undefined;
  /** The member opened this tab: its editor may take the cursor (KOBE-802); not an agent's open. */
  readonly focusOnOpen?: boolean | undefined;
  /** Save As saved a copy at `path`: open it in this tab (KOBE-615). */
  readonly onOpenPath?: ((path: string) => void) | undefined;
}) {
  const { loaded, reread, saved } = useFilePreview(api, path, reload, onGone);
  // Text files in the editor follow outside changes; notebooks keep today's explicit reload.
  const known = drafts && loaded.status === "text" && !isNotebook(path) ? loaded.sha256 : undefined;
  const { change: remote, overflow: liveOff } = useRemoteChange(
    known === undefined ? undefined : changes,
    path,
  );
  const {
    outside,
    dismiss,
    reload: reloadOutside,
  } = useOutsideChange({
    api,
    path,
    known,
    hint: changeHint,
    drafts,
    remote,
    reread,
  });
  const editor =
    drafts && reviews
      ? {
          api,
          drafts,
          reviews,
          saved,
          reread,
          kernel,
          outside,
          dismissOutside: dismiss,
          reloadOutside,
          liveOff,
          onOpenPath,
          takeFocus: focusOnOpen,
        }
      : undefined;
  const [downloadError, setDownloadError] = useState<ApiError | null>(null);
  const name = fileName(path);
  const download = async () => {
    setDownloadError(null);
    const res = await api.download(path);
    if (res.ok) saveBytes(name, res.data);
    else setDownloadError(describeFileError(res.error));
  };
  return (
    <>
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <h2 id={titleId} className="min-w-0 flex-1 truncate text-sm font-medium" title={path}>
          {name}
        </h2>
        <CopyPath path={path} />
        <IconAction
          command="artifact-download"
          label={`Download ${name}`}
          onClick={() => void download()}
        />
        {owner && <AddToProject source={{ kind: "workspace_file", path }} defaultName={name} />}
      </header>
      <ProjectFileBar path={path} version={loaded.status === "text" ? loaded.sha256 : undefined} />
      <div
        className={
          fillsBare(loaded)
            ? "flex min-h-0 min-w-0 flex-1 flex-col"
            : fillsTab(loaded, path, editor)
              ? "flex min-h-0 min-w-0 flex-1 flex-col px-3 pt-2 pb-3"
              : "min-h-0 flex-1 overflow-auto p-3"
        }
      >
        {downloadError && <ErrorNotice error={downloadError} />}
        <FileBody
          loaded={loaded}
          path={path}
          teamId={teamId}
          editor={editor}
          onDownload={() => void download()}
        />
      </div>
    </>
  );
}

/** Says which file's tab closed because the file left the workspace (until dismissed). */
export function FileGoneNotice() {
  const panel = useArtifactPanel();
  const gone = panel?.goneFile ?? null;
  if (!panel || gone === null) return null;
  return (
    <div className={styles.dismissibleBanner} role="status">
      <p>{`${fileName(gone)} is no longer in your files (moved, renamed or deleted), so its tab was closed.`}</p>
      <IconAction
        command="dismiss-notice"
        label="Dismiss file notice"
        size="sm"
        className="shrink-0"
        onClick={panel.dismissGone}
      />
    </div>
  );
}
