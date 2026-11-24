"use client";

/**
 * Repo details… (KOBE-768, spec workspace-git G17, G19, G20): a Repo's host and repository with a
 * link to it on the host, the branch and the member's working copy (ahead/behind, its open pull
 * request), the mirror (last refreshed, refreshing, why the last refresh failed, too large to
 * mirror, read-only from its last mirror) with Refresh, the newest commits, and for Workspace
 * admins Relink and Detach. Host-provided strings are shown as text; links go only to the
 * connection's own host, in a new tab without an opener or referrer.
 */
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { hostOf } from "../../lib/admin/git/labels";
import {
  aheadBehindText,
  hostLink,
  mirrorStateText,
  readOnlyText,
  refusalText,
  repoBranch,
  repoNameProblem,
  repoSubtitle,
} from "../../lib/projects/repo";
import type { RepoApi, RepoView } from "../../lib/projects/repo-api";
import type { GitConnections, RepoInfo } from "./workspace-repos";

const BUTTON = "rounded-md border px-2 py-0.5 text-xs";
const FIELD = "border-input bg-background rounded-md border px-1.5 py-0.5 text-sm";
const COMMITS_SHOWN = 5;
/** While the mirror refreshes, read it again after this, doubling up to the cap (review M1). */
export const REFRESH_READ_MS = 2_000;
const REFRESH_READ_MAX_MS = 30_000;
const REFRESH_READS = 8;

export function RepoPanel({
  project,
  info,
  api,
  git,
  onChanged,
  onDetached,
  onClose,
  refreshReadMs = REFRESH_READ_MS,
}: {
  readonly project: { readonly id: string; readonly name: string };
  readonly info: RepoInfo | undefined;
  readonly api: Pick<RepoApi, "repo" | "refresh" | "relink" | "detach">;
  readonly git: GitConnections | null;
  /** The Repo changed (Refresh started, relinked): read it again. */
  onChanged(): void;
  /** The Repo is an ordinary project again. */
  onDetached(): void;
  onClose(): void;
  readonly refreshReadMs?: number | undefined;
}) {
  const id = useId();
  const closeButton = useRef<HTMLButtonElement>(null);
  const [view, setView] = useState<RepoView | null>(info?.view ?? null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setView(info?.view ?? null), [info?.view]);
  useEffect(() => closeButton.current?.focus(), []);
  const changed = useRef(onChanged);
  changed.current = onChanged;

  // Review M1: while the mirror refreshes, read it again (back-off) until it settles, so the
  // state and Refresh follow; the row is read again at the end.
  const refreshing = view?.mirror.refreshing ?? false;
  useEffect(() => {
    if (!refreshing) return;
    let stale = false;
    let delay = refreshReadMs;
    let reads = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const res = await api.repo(project.id);
      if (stale) return;
      reads += 1;
      if (res.ok) setView(res.data);
      if (res.ok && !res.data.mirror.refreshing) {
        setNotice(null);
        changed.current();
        return;
      }
      if (reads >= REFRESH_READS) {
        setNotice(
          "Still refreshing. Close Repo details and open it again later to see the result.",
        );
        return;
      }
      delay = Math.min(delay * 2, REFRESH_READ_MAX_MS);
      timer = setTimeout(() => void tick(), delay);
    };
    timer = setTimeout(() => void tick(), delay);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [refreshing, api, project.id, refreshReadMs]);

  const refresh = async () => {
    setBusy(true);
    const res = await api.refresh(project.id);
    setBusy(false);
    if (!res.ok) {
      setNotice(null);
      return setProblem(refusalText(res.error));
    }
    setProblem(null);
    setView(res.data);
    setNotice("Refreshing from the host. The files follow in a moment.");
  };

  const copy = info?.status?.workingCopy ?? null;
  const pr = info?.status?.pullRequest ?? null;
  const link = view === null ? null : hostLink(view);
  const prLink =
    view === null || pr === null ? null : hostLink({ baseUrl: view.baseUrl, webUrl: pr.url });

  return (
    <div
      role="dialog"
      aria-labelledby={`${id}-t`}
      className="border-border mt-1 flex flex-col gap-1.5 rounded-md border p-2 text-xs"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <p id={`${id}-t`} className="m-0 font-medium">
        {`${project.name}: Repo`}
      </p>
      {view === null ? (
        <p role="status" className="text-muted-foreground m-0">
          The Repo&apos;s repository could not be read. Close this and try again in a moment.
        </p>
      ) : (
        <>
          <p className="m-0">{repoSubtitle(view)}</p>
          {link !== null && (
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              className="m-0 self-start underline"
            >
              {`Open on ${hostOf(view.baseUrl)}`}
            </a>
          )}
          {view.readOnly && view.readOnlyReason !== null && (
            <p role="note" className="m-0 font-medium">
              {readOnlyText(view.readOnlyReason)}
              {view.canManage ? " Relink it to another repository, or detach it." : ""}
            </p>
          )}
          <p className="m-0">
            {`Default branch: ${view.defaultBranch}`}
            {info?.status
              ? info.status.directCommits
                ? ". Commits go straight to it."
                : ". Commits open a pull request."
              : ""}
          </p>
          {copy !== null && (
            <p className="m-0">
              {`Your working copy: ${repoBranch(view, copy)}, ${aheadBehindText(copy).long}.`}
              {copy.problem ? ` ${copy.problem}` : ""}
            </p>
          )}
          {pr !== null && (
            <p className="m-0">
              {`Your pull request #${pr.number} (${pr.branch})`}
              {prLink !== null && (
                <>
                  {": "}
                  <a href={prLink} target="_blank" rel="noopener noreferrer" className="underline">
                    open it on the host
                  </a>
                </>
              )}
            </p>
          )}
          <p role="status" className="m-0">
            {mirrorStateText(view.mirror)}
          </p>
          {notice && <p className="text-muted-foreground m-0">{notice}</p>}
          {problem && (
            <p role="alert" className="text-destructive m-0">
              {problem}
            </p>
          )}
          <p className="text-muted-foreground m-0">
            Kaiju refreshes the mirror when it pushes, when the Repo is opened and every few
            minutes; Refresh asks now, within the connection&apos;s hourly limit.
          </p>
          {view.commits.length > 0 && (
            <>
              <p className="m-0 font-medium">Newest commits on the host</p>
              <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                {view.commits.slice(0, COMMITS_SHOWN).map((c) => (
                  <li key={c.sha} className="min-w-0 truncate" title={c.message}>
                    <code>{c.sha.slice(0, 7)}</code> {c.message}{" "}
                    <span className="text-muted-foreground">{c.authorName}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {view.canManage && (
            <ManageRepo
              id={id}
              projectId={project.id}
              view={view}
              api={api}
              git={git}
              onRelinked={(next) => {
                setView(next);
                setProblem(null);
                setNotice(`Relinked to ${next.fullName}. The files follow at the next refresh.`);
                onChanged();
              }}
              onDetached={onDetached}
            />
          )}
        </>
      )}
      <div className="flex justify-end gap-2">
        {view !== null && view.connectionId !== null && (
          <button
            type="button"
            className={BUTTON}
            disabled={busy || view.mirror.refreshing}
            aria-busy={busy || view.mirror.refreshing}
            onClick={() => void refresh()}
          >
            Refresh
          </button>
        )}
        <button ref={closeButton} type="button" className={BUTTON} onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

/** Relink and Detach (Workspace admins, G20). */
function ManageRepo({
  id,
  projectId,
  view,
  api,
  git,
  onRelinked,
  onDetached,
}: {
  readonly id: string;
  readonly projectId: string;
  readonly view: RepoView;
  readonly api: Pick<RepoApi, "relink" | "detach">;
  readonly git: GitConnections | null;
  onRelinked(view: RepoView): void;
  onDetached(): void;
}) {
  const usable = (git?.connections ?? []).filter((c) => c.accessLevel !== "off");
  const [mode, setMode] = useState<"idle" | "relink" | "detach">("idle");
  const [connectionId, setConnectionId] = useState(view.connectionId ?? usable[0]?.id ?? "");
  const [name, setName] = useState(view.fullName.slice(view.fullName.indexOf("/") + 1));
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const relink = async (e: FormEvent) => {
    e.preventDefault();
    const issue = connectionId === "" ? "Choose a git connection." : repoNameProblem(name);
    if (issue !== null) return setProblem(issue);
    setBusy(true);
    const res = await api.relink(projectId, connectionId, name);
    setBusy(false);
    if (!res.ok) return setProblem(refusalText(res.error));
    setMode("idle");
    setProblem(null);
    onRelinked(res.data);
  };
  const detach = async () => {
    setBusy(true);
    const res = await api.detach(projectId);
    setBusy(false);
    if (!res.ok) return setProblem(refusalText(res.error));
    onDetached();
  };

  return (
    <div className="border-border flex flex-col gap-1.5 border-t pt-1.5">
      <p className="m-0 font-medium">Workspace admins</p>
      {mode === "idle" && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className={BUTTON} onClick={() => setMode("relink")}>
            Relink…
          </button>
          <button type="button" className={BUTTON} onClick={() => setMode("detach")}>
            Detach…
          </button>
        </div>
      )}
      {mode === "relink" && (
        <form className="flex flex-col gap-1.5" onSubmit={(e) => void relink(e)}>
          <p className="text-muted-foreground m-0">
            Link the Repo to another repository (or the same one through another connection). Its
            default branch becomes the record. A public repository is refused.
          </p>
          <label htmlFor={`${id}-rc`}>Git connection</label>
          <select
            id={`${id}-rc`}
            value={connectionId}
            disabled={busy}
            className={FIELD}
            onChange={(e) => setConnectionId(e.currentTarget.value)}
          >
            {usable.length === 0 && <option value="">No git connection</option>}
            {usable.map((c) => (
              <option key={c.id} value={c.id}>
                {`${c.displayName} (${hostOf(c.baseUrl)} / ${c.organization})`}
              </option>
            ))}
          </select>
          <label htmlFor={`${id}-rn`}>Repository name</label>
          <input
            id={`${id}-rn`}
            value={name}
            disabled={busy}
            spellCheck={false}
            autoComplete="off"
            className={FIELD}
            onChange={(e) => setName(e.currentTarget.value)}
          />
          <div className="flex justify-end gap-2">
            <button type="button" className={BUTTON} onClick={() => setMode("idle")}>
              Cancel
            </button>
            <button type="submit" className={BUTTON} disabled={busy}>
              Relink
            </button>
          </div>
        </form>
      )}
      {mode === "detach" && (
        <>
          <p role="note" className="m-0">
            Detach the Repo? It becomes an ordinary project again, starting from the mirrored files
            as one commit. The repository on the host stays as it is.
          </p>
          <div className="flex justify-end gap-2">
            <button type="button" className={BUTTON} onClick={() => setMode("idle")}>
              Keep it
            </button>
            <button type="button" className={BUTTON} disabled={busy} onClick={() => void detach()}>
              Detach
            </button>
          </div>
        </>
      )}
      {problem && (
        <p role="alert" className="text-destructive m-0">
          {problem}
        </p>
      )}
    </div>
  );
}
