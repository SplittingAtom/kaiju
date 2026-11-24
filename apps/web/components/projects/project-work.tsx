"use client";

/**
 * Check out, Commit…, Update and Discard for one project (Workspaces CM2, CM5, CM8; KOBE-581),
 * shared by the editor's header, the Files panel's project menu and the Threads panel's project
 * header. Commit asks for a message (at most 500 characters); a `commit_conflict` (the head moved
 * since the checkout's base) offers Update in the same dialog, then Commit again. Discard asks
 * first when the working copy has changes. The server decides every step. On a Repo (KOBE-767)
 * the dialog says where the commit goes (a pull request, or the default branch where the
 * Workspace allows it), the outcome links the pull request, and `repo_moved` offers Update too.
 */
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { ApiError, ApiResult } from "../../lib/api/client";
import { describeProjectError } from "../../lib/projects/api";
import {
  changesLabel,
  COMMIT_MESSAGE_MAX,
  type CommitResult,
  type RepoCommitInfo,
} from "../../lib/projects/commits-api";
import { ErrorNotice } from "../admin/error-notice";
import { useWorkspaceProjects } from "./workspace-projects";

export const WORK_BUTTON = "rounded-md border px-2 py-0.5 text-xs disabled:opacity-50";

export interface ProjectRef {
  readonly id: string;
  readonly name: string;
}

/** `projects/<slug>/a/b.csv` (Update's workspace paths, KOBE-579) as `a/b.csv`. */
export const insideProject = (path: string): string =>
  path.startsWith("projects/") ? path.split("/").slice(2).join("/") || path : path;

const worded = (error: ApiError): ApiError => ({ ...error, message: describeProjectError(error) });

/** A link shown with a notice (the pull request a commit opened, KOBE-767). */
export interface NoticeLink {
  readonly href: string;
  readonly label: string;
}

/** The words (and link) of a commit's outcome. */
export function commitNotice(
  name: string,
  r: CommitResult,
): { readonly text: string; readonly link?: NoticeLink } {
  switch (r.status) {
    case "committed":
      return { text: `Committed #${r.seq} to ${name}.` };
    case "nothing_to_commit":
      return { text: "Nothing to commit: your working copy matches its base." };
    case "pull_request": {
      const text = r.opened
        ? `${r.fallback ? "The git host protects the default branch, so your commit went to a pull request instead: " : ""}Opened pull request #${r.number} for ${name} (branch ${r.branch}).`
        : `Added your commit to pull request #${r.number} (branch ${r.branch}).`;
      return r.url === ""
        ? { text }
        : { text, link: { href: r.url, label: `Open pull request #${r.number}` } };
    }
    case "pushed":
      return {
        text: `Committed to ${r.branch} on the git host${r.seq === null ? "" : ` (#${r.seq} in Kaiju)`}.`,
      };
  }
}

/** Where a commit to this Repo goes, in one sentence (null for an ordinary project). */
export function repoCommitHint(info: RepoCommitInfo | null): string | null {
  const repo = info?.repo;
  if (!repo) return null;
  if (!repo.canCommit) {
    return "This is a Repo: you can't commit to it now (it needs the Contributor role, editor rights and a connection at Read and write).";
  }
  if (repo.directCommits) {
    return `This is a Repo: your commit goes straight to ${repo.defaultBranch} on the git host, or to a pull request where the host protects ${repo.defaultBranch}.`;
  }
  if (repo.pullRequest) {
    return `This is a Repo: your commit is added to your pull request #${repo.pullRequest.number}.`;
  }
  return `This is a Repo: your commit goes to a new branch on the git host, with a pull request into ${repo.defaultBranch}.`;
}

/** The project's work actions with their busy, error and notice state. */
export function useProjectWork(project: ProjectRef) {
  const ctx = useWorkspaceProjects();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState("");
  const [noticeLink, setNoticeLink] = useState<NoticeLink | null>(null);

  const run = useCallback(
    async <T,>(
      call: () => Promise<ApiResult<T>>,
      done: (data: T) => string | { readonly text: string; readonly link?: NoticeLink },
    ) => {
      setBusy(true);
      setError(null);
      setNotice("");
      setNoticeLink(null);
      const res = await call();
      setBusy(false);
      if (!res.ok) {
        setError(worded(res.error));
        return res;
      }
      const said = done(res.data);
      setNotice(typeof said === "string" ? said : said.text);
      setNoticeLink(typeof said === "string" ? null : (said.link ?? null));
      ctx?.reload();
      return res;
    },
    [ctx],
  );

  const commits = ctx?.commits;
  return {
    busy,
    error,
    notice,
    noticeLink,
    clear: () => {
      setError(null);
      setNotice("");
      setNoticeLink(null);
    },
    /** Where a commit to this project goes when it is a Repo (KOBE-767); null when unknown. */
    repoInfo: async (): Promise<RepoCommitInfo | null> => {
      if (!commits) return null;
      const res = await commits.repoStatus(project.id);
      return res.ok ? res.data : null;
    },
    checkout: () =>
      commits
        ? run(
            () => commits.checkout(project.id),
            () => `Checked out ${project.name}: its folder is yours to edit.`,
          )
        : Promise.resolve(null),
    commit: (message: string) =>
      commits
        ? run(
            () => commits.commit(project.id, message),
            (r) => commitNotice(project.name, r),
          )
        : Promise.resolve(null),
    update: () =>
      commits
        ? run(
            () => commits.update(project.id),
            (r) =>
              r.conflictPaths.length === 0
                ? `Updated ${project.name} to the latest commit.`
                : `Updated ${project.name}. Both sides changed ${r.conflictPaths.map(insideProject).join(", ")}: the latest version took them and your edits were kept beside them as .conflict- copies.`,
          )
        : Promise.resolve(null),
    discard: () =>
      commits
        ? run(
            () => commits.discard(project.id),
            () => `Discarded your working copy of ${project.name}.`,
          )
        : Promise.resolve(null),
    changes: async (): Promise<number | null> => {
      if (!commits) return null;
      const res = await commits.checkoutState(project.id);
      return res.ok && res.data ? res.data.diff.length : null;
    },
  };
}

export type ProjectWork = ReturnType<typeof useProjectWork>;

/**
 * The Commit… dialog: a message, then Commit. On `commit_conflict` it says the project moved on
 * and offers Update; after it, Commit again.
 */
export function CommitForm({
  project,
  work,
  onDone,
  onCancel,
}: {
  readonly project: ProjectRef;
  readonly work: ProjectWork;
  onDone(): void;
  onCancel(): void;
}) {
  const id = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const [message, setMessage] = useState("");
  const [behind, setBehind] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    let live = true;
    void work.repoInfo().then((info) => {
      if (live) setHint(repoCommitHint(info));
    });
    return () => {
      live = false;
    };
    // Once per dialog.
  }, []);
  const trimmed = message.trim();

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (trimmed === "" || work.busy) return;
    const res = await work.commit(trimmed);
    if (!res) return;
    if (!res.ok) {
      // KOBE-767: a Repo's default branch moved on the host: Update brings Kaiju's copy in.
      setBehind(res.error.code === "commit_conflict" || res.error.code === "repo_moved");
      return;
    }
    setBehind(false);
    if (res.data.status !== "nothing_to_commit") onDone();
  }

  async function update() {
    const res = await work.update();
    if (res?.ok) setBehind(false);
  }

  return (
    <form
      role="dialog"
      aria-labelledby={`${id}-t`}
      className="border-border mt-1 flex flex-col gap-1.5 rounded-md border p-2 text-xs"
      onSubmit={(e) => void submit(e)}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <p id={`${id}-t`} className="m-0 font-medium">
        Commit to {project.name}
      </p>
      <label htmlFor={`${id}-m`} className="text-muted-foreground">
        What changed?
      </label>
      <textarea
        ref={input}
        id={`${id}-m`}
        rows={3}
        maxLength={COMMIT_MESSAGE_MAX}
        value={message}
        className="border-input bg-background rounded-md border px-1.5 py-1 text-xs"
        aria-describedby={`${id}-c`}
        onChange={(e) => setMessage(e.target.value)}
      />
      <span id={`${id}-c`} className="text-muted-foreground">
        {message.length} / {COMMIT_MESSAGE_MAX}
      </span>
      {hint && <p className="text-muted-foreground m-0">{hint}</p>}
      {behind && (
        <p role="alert" className="m-0">
          {project.name} has newer commits than your working copy. Update brings them in; then
          commit again.
        </p>
      )}
      {work.error && !behind && <ErrorNotice error={work.error} />}
      <WorkNotice work={work} />
      <div className="flex flex-wrap gap-1.5">
        {behind && (
          <button
            type="button"
            className={WORK_BUTTON}
            disabled={work.busy}
            onClick={() => void update()}
          >
            Update
          </button>
        )}
        <button type="submit" className={WORK_BUTTON} disabled={work.busy || trimmed === ""}>
          Commit
        </button>
        <button type="button" className={WORK_BUTTON} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** The outcome's words, with the pull request's link when a commit opened or joined one. */
export function WorkNotice({
  work,
}: {
  readonly work: Pick<ProjectWork, "notice" | "noticeLink">;
}) {
  return (
    <p role="status" className="m-0">
      {work.notice}
      {work.noticeLink && (
        <>
          {" "}
          <a
            href={work.noticeLink.href}
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            {work.noticeLink.label}
          </a>
        </>
      )}
    </p>
  );
}

/** Asks before Discard when the working copy has changes (CM5). */
export function DiscardConfirm({
  project,
  changes,
  busy,
  onConfirm,
  onCancel,
}: {
  readonly project: ProjectRef;
  /** Null: the count could not be read. */
  readonly changes: number | null;
  readonly busy: boolean;
  onConfirm(): void;
  onCancel(): void;
}) {
  const id = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  return (
    <div
      role="alertdialog"
      aria-labelledby={id}
      className="border-destructive/40 mt-1 flex flex-wrap items-center gap-2 rounded-md border p-2 text-xs"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <p id={id} className="m-0 min-w-0 flex-1">
        {`Discard your working copy of ${project.name}? ${
          changes === null ? "Changes" : changesLabel(changes)
        } not committed will be lost.`}
      </p>
      <button type="button" ref={cancel} className={WORK_BUTTON} onClick={onCancel}>
        Cancel
      </button>
      <button
        type="button"
        className={`${WORK_BUTTON} text-destructive border-destructive/40`}
        disabled={busy}
        onClick={onConfirm}
      >
        Discard
      </button>
    </div>
  );
}

/**
 * Which inline dialog is open for a project's work, and the Discard step: it counts the changes
 * first and asks only when there are some.
 */
export function useWorkDialogs(work: ProjectWork) {
  const [open, setOpen] = useState<
    | { readonly kind: "commit" }
    | { readonly kind: "discard"; readonly changes: number | null }
    | null
  >(null);
  return {
    open,
    close: () => setOpen(null),
    commit: () => {
      work.clear();
      setOpen({ kind: "commit" });
    },
    discard: async () => {
      work.clear();
      const changes = await work.changes();
      if (changes === 0) {
        await work.discard();
        return;
      }
      setOpen({ kind: "discard", changes }); // unknown counts as changes: ask
    },
  };
}

export type WorkAction = "checkout" | "commit" | "update" | "discard";

/**
 * One work action on a project from a menu (the Files panel's project row, the Threads panel's
 * project header): Commit… opens its dialog, Discard asks when there are changes, Check out and
 * Update run at once; the outcome stays until Close.
 */
export function ProjectWorkPanel({
  project,
  action,
  onClose,
}: {
  readonly project: ProjectRef;
  readonly action: WorkAction;
  onClose(): void;
}) {
  const work = useProjectWork(project);
  const dialogs = useWorkDialogs(work);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (action === "commit") dialogs.commit();
    else if (action === "discard") void dialogs.discard();
    else if (action === "update") void work.update();
    else void work.checkout();
    // Once per panel: the panel is keyed by project and action.
  }, []);
  if (dialogs.open?.kind === "commit") {
    return <CommitForm project={project} work={work} onDone={dialogs.close} onCancel={onClose} />;
  }
  if (dialogs.open?.kind === "discard") {
    return (
      <DiscardConfirm
        project={project}
        changes={dialogs.open.changes}
        busy={work.busy}
        onConfirm={() => {
          dialogs.close();
          void work.discard();
        }}
        onCancel={onClose}
      />
    );
  }
  return (
    <div className="border-border mt-1 flex flex-col gap-1.5 rounded-md border p-2 text-xs">
      {work.busy && <p className="m-0">Working on {project.name}…</p>}
      {work.error && <ErrorNotice error={work.error} />}
      <WorkNotice work={work} />
      <button type="button" className={`${WORK_BUTTON} self-start`} onClick={onClose}>
        Close
      </button>
    </div>
  );
}
