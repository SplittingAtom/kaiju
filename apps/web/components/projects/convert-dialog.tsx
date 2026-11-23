"use client";

/**
 * Convert to repo… (KOBE-768, spec workspace-git G16, GQ12, GQ13; the job is KOBE-765): the
 * connection (when there are several at Read and write), the repository name with the
 * connection's prefix, whether to carry the history, and for Workspace admins an existing empty
 * repository instead of a new one. Every refusal shows in the server's plain words (limits,
 * files the host would reject, unsaved working copies, legal hold…). A started conversion runs in
 * the background: the dialog follows it (the step, commits pushed) to its end, and offers Retry
 * and Abandon after a failure. Inline like the panel's other dialogs: it takes the focus, Escape
 * closes it (a running conversion goes on).
 */
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  isAdminView,
  type GitAdminConnection,
  type GitMemberConnection,
} from "../../lib/admin/api/team/git";
import { hostOf } from "../../lib/admin/git/labels";
import {
  conversionEndText,
  conversionProgressText,
  proposedRepoName,
  refusalText,
  repoNameProblem,
  REPO_NAME_MAX,
} from "../../lib/projects/repo";
import type { RepoApi, RepoConversion } from "../../lib/projects/repo-api";
import type { GitConnections } from "./workspace-repos";

const BUTTON = "rounded-md border px-2 py-0.5 text-xs";
const FIELD = "border-input bg-background rounded-md border px-1.5 py-0.5 text-sm";
/** How often a running conversion is read again; doubled after each failed read (review L3). */
export const CONVERSION_READ_MS = 2_000;
const CONVERSION_READ_MAX_MS = 30_000;
/** Failed reads in a row after which the dialog stops following and says so. */
const CONVERSION_READ_MISSES = 5;

type Connection = GitAdminConnection | GitMemberConnection;

const prefixOf = (c: Connection | undefined): string | undefined =>
  c === undefined ? undefined : isAdminView(c) ? c.repoDefaults.namePrefix : c.repoNamePrefix;

/** The connection's default visibility for new repositories (review M2). */
const visibilityOf = (c: Connection | undefined): "private" | "internal" =>
  c === undefined
    ? "private"
    : isAdminView(c)
      ? c.repoDefaults.visibility
      : (c.repoVisibility ?? "private");

/** What a new repository's visibility means, in plain words (review M2). */
export function visibilityText(
  visibility: "private" | "internal",
  organization: string,
  host: string,
): string {
  return visibility === "internal"
    ? `An internal repository in ${organization} on ${host}: everyone with an account in the host's enterprise (GitHub) or on the server (Gitea, Forgejo) can read it.`
    : `A private repository in ${organization} on ${host}: only people the organization gives access can read it.`;
}

const connectionLabel = (c: Connection) =>
  `${c.displayName} (${hostOf(c.baseUrl)} / ${c.organization})`;

export interface ConvertProject {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

export function ConvertDialog({
  project,
  api,
  git,
  onChanged,
  onClose,
  pollMs = CONVERSION_READ_MS,
}: {
  readonly project: ConvertProject;
  readonly api: Pick<
    RepoApi,
    "conversion" | "startConversion" | "retryConversion" | "abandonConversion"
  >;
  readonly git: GitConnections | null;
  /** The project changed (it became a Repo, or a conversion started, failed or was abandoned). */
  onChanged(): void;
  onClose(): void;
  readonly pollMs?: number | undefined;
}) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState<RepoConversion | null | "loading" | "unreadable">(
    "loading",
  );
  const [left, setLeft] = useState<string | null>(null);
  /** Failed reads in a row while following (review L3). */
  const [misses, setMisses] = useState(0);
  const [loads, setLoads] = useState(0);
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const retryLoad = useRef<HTMLButtonElement>(null);

  // L6: the dialog takes the focus at once; its parts move it on when they appear.
  useEffect(() => box.current?.focus(), []);

  useEffect(() => {
    let stale = false;
    void api.conversion(project.id).then((res) => {
      if (stale) return;
      // Review L4: unreadable is not "no conversion" (one may be running).
      if (!res.ok) return setAttempt("unreadable");
      const latest = res.data;
      // A finished or abandoned attempt is history: offer the form again.
      setAttempt(latest?.status === "running" || latest?.status === "failed" ? latest : null);
    });
    return () => {
      stale = true;
    };
  }, [api, project.id, loads]);
  useEffect(() => {
    if (attempt === "unreadable") retryLoad.current?.focus();
  }, [attempt]);

  // Follow a running conversion to its end; back off after failed reads, stop after a few.
  const running = typeof attempt === "object" && attempt?.status === "running";
  const lost = misses >= CONVERSION_READ_MISSES;
  useEffect(() => {
    if (!running || lost) return;
    let stale = false;
    const delay = Math.min(pollMs * 2 ** misses, CONVERSION_READ_MAX_MS);
    const timer = setTimeout(() => {
      void api.conversion(project.id).then((res) => {
        if (stale) return;
        if (!res.ok || res.data === null) return setMisses((n) => n + 1);
        setMisses(0);
        setAttempt(res.data);
        if (res.data.status !== "running") changed.current();
      });
    }, delay);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [running, lost, attempt, misses, api, project.id, pollMs]);

  const started = useCallback(
    (c: RepoConversion) => {
      setAttempt(c);
      onChanged();
    },
    [onChanged],
  );

  return (
    <div
      ref={box}
      tabIndex={-1}
      role="dialog"
      aria-labelledby={`${id}-t`}
      aria-describedby={`${id}-h`}
      className="border-border mt-1 flex flex-col gap-1.5 rounded-md border p-2 text-xs"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <p id={`${id}-t`} className="m-0 font-medium">
        {`Convert ${project.name} to a repo`}
      </p>
      <p id={`${id}-h`} className="text-muted-foreground m-0">
        The project moves to a new repository on the git host, which becomes its record: Kobe then
        shows a read-only mirror of the default branch, and commits go to the host. This cannot be
        undone here.
      </p>
      {attempt === "loading" ? (
        <p role="status" className="text-muted-foreground m-0">
          Reading the project…
        </p>
      ) : attempt === "unreadable" ? (
        <>
          <p role="alert" className="m-0">
            Kobe could not read whether this project has a conversion. Try again in a moment.
          </p>
          <div className="flex justify-end gap-2">
            <button
              ref={retryLoad}
              type="button"
              className={BUTTON}
              onClick={() => {
                setAttempt("loading");
                setLoads((n) => n + 1);
              }}
            >
              Try again
            </button>
            <button type="button" className={BUTTON} onClick={onClose}>
              Close
            </button>
          </div>
        </>
      ) : attempt === null ? (
        <ConvertForm
          id={id}
          project={project}
          api={api}
          git={git}
          left={left}
          onStarted={started}
          onCancel={onClose}
        />
      ) : (
        <Progress
          id={id}
          attempt={attempt}
          api={api}
          projectId={project.id}
          lost={lost}
          onAttempt={(next, leftOnHost) => {
            setMisses(0);
            setAttempt(next.status === "abandoned" ? null : next);
            if (leftOnHost !== undefined) setLeft(leftOnHost);
            onChanged();
          }}
          onClose={onClose}
        />
      )}
    </div>
  );
}

function ConvertForm({
  id,
  project,
  api,
  git,
  left,
  onStarted,
  onCancel,
}: {
  readonly id: string;
  readonly project: ConvertProject;
  readonly api: Pick<RepoApi, "startConversion">;
  readonly git: GitConnections | null;
  /** The previous attempt was abandoned and left this repository on the host. */
  readonly left: string | null;
  onStarted(c: RepoConversion): void;
  onCancel(): void;
}) {
  const writable = (git?.connections ?? []).filter((c) => c.accessLevel === "read_write");
  const [connectionId, setConnectionId] = useState(writable[0]?.id ?? "");
  const chosen = writable.find((c) => c.id === connectionId);
  const [name, setName] = useState(() => proposedRepoName(prefixOf(writable[0]), project.slug));
  const [history, setHistory] = useState(true);
  const [existing, setExisting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => (nameInput.current ?? closeButton.current)?.focus(), []);

  if (writable.length === 0) {
    return (
      <>
        <p role="alert" className="m-0">
          No git connection is at Read and write, so nothing can be converted. A Workspace admin can
          connect a git organization, or raise a connection&apos;s access, in the Git section.
        </p>
        <div className="flex justify-end">
          <button ref={closeButton} type="button" className={BUTTON} onClick={onCancel}>
            Close
          </button>
        </div>
      </>
    );
  }

  const choose = (next: string) => {
    const before = proposedRepoName(prefixOf(chosen), project.slug);
    setConnectionId(next);
    // Keep a name the member typed; follow the prefix otherwise.
    if (name === before)
      setName(proposedRepoName(prefixOf(writable.find((c) => c.id === next)), project.slug));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const issue = repoNameProblem(name);
    setProblem(issue);
    if (issue !== null) return nameInput.current?.focus();
    setBusy(true);
    const res = await api.startConversion(project.id, {
      connection_id: connectionId,
      repository_name: name,
      carry_history: history,
      ...(existing ? { use_existing: true } : {}),
    });
    setBusy(false);
    if (!res.ok) {
      setProblem(refusalText(res.error));
      return nameInput.current?.focus();
    }
    onStarted(res.data);
  };

  const expiring = chosen !== undefined && isAdminView(chosen) && chosen.credential.expiresSoon;
  return (
    <form className="flex flex-col gap-1.5" onSubmit={(e) => void submit(e)}>
      {left !== null && (
        <p role="status" className="m-0">
          {left}
        </p>
      )}
      {writable.length > 1 ? (
        <>
          <label htmlFor={`${id}-c`}>Git connection</label>
          <select
            id={`${id}-c`}
            value={connectionId}
            disabled={busy}
            className={FIELD}
            onChange={(e) => choose(e.currentTarget.value)}
          >
            {writable.map((c) => (
              <option key={c.id} value={c.id}>
                {connectionLabel(c)}
              </option>
            ))}
          </select>
        </>
      ) : (
        <p className="m-0">Git connection: {chosen ? connectionLabel(chosen) : ""}</p>
      )}
      {expiring && (
        <p role="note" className="m-0">
          This connection&apos;s credential expires soon. Replace it in the Git section so the
          conversion and the Repo&apos;s mirror keep working.
        </p>
      )}
      <label htmlFor={`${id}-n`}>Repository name</label>
      <input
        ref={nameInput}
        id={`${id}-n`}
        value={name}
        maxLength={REPO_NAME_MAX + 20}
        disabled={busy}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={problem !== null}
        aria-describedby={`${id}-nh${problem ? ` ${id}-p` : ""}`}
        className={FIELD}
        onChange={(e) => setName(e.currentTarget.value)}
      />
      <p id={`${id}-nh`} className="text-muted-foreground m-0">
        {chosen
          ? visibilityText(visibilityOf(chosen), chosen.organization, hostOf(chosen.baseUrl))
          : ""}
      </p>
      <fieldset className="m-0 flex flex-col gap-1 border-0 p-0" disabled={busy}>
        <legend className="mb-1 p-0">History</legend>
        <label className="flex items-start gap-1.5">
          <input
            type="radio"
            name={`${id}-history`}
            checked={history}
            onChange={() => setHistory(true)}
          />
          <span>Carry the history: each commit with its author, time and message</span>
        </label>
        <label className="flex items-start gap-1.5">
          <input
            type="radio"
            name={`${id}-history`}
            checked={!history}
            onChange={() => setHistory(false)}
          />
          <span>One commit of the current files</span>
        </label>
      </fieldset>
      {git?.admin && (
        <label className="flex items-start gap-1.5">
          <input
            type="checkbox"
            checked={existing}
            disabled={busy}
            onChange={(e) => setExisting(e.currentTarget.checked)}
          />
          <span>Use an existing empty repository with this name (Workspace admins)</span>
        </label>
      )}
      <p className="text-muted-foreground m-0">
        Commits carry each author&apos;s Kobe email, or a no-reply address if the Workspace uses
        one. Files under .github/workflows/ run on the host if it runs Actions. The conversion runs
        in the background and you get an email when it ends.
      </p>
      {problem && (
        <p id={`${id}-p`} role="alert" className="text-destructive m-0">
          {problem}
        </p>
      )}
      {busy && (
        <p role="status" className="text-muted-foreground m-0">
          Starting the conversion…
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className={BUTTON} onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className={BUTTON} disabled={busy}>
          Convert
        </button>
      </div>
    </form>
  );
}

function Progress({
  id,
  attempt,
  api,
  projectId,
  lost,
  onAttempt,
  onClose,
}: {
  readonly id: string;
  readonly attempt: RepoConversion;
  readonly api: Pick<RepoApi, "retryConversion" | "abandonConversion">;
  readonly projectId: string;
  /** Its progress could no longer be read. */
  readonly lost: boolean;
  onAttempt(next: RepoConversion, leftOnHost?: string): void;
  onClose(): void;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const close = useRef<HTMLButtonElement>(null);
  const { status } = attempt;
  useEffect(() => {
    close.current?.focus();
  }, [status]);

  const retry = async () => {
    setBusy(true);
    const res = await api.retryConversion(projectId);
    setBusy(false);
    if (!res.ok) return setProblem(refusalText(res.error));
    setProblem(null);
    onAttempt(res.data);
  };
  const abandon = async () => {
    setBusy(true);
    const res = await api.abandonConversion(projectId);
    setBusy(false);
    setConfirming(false);
    if (!res.ok) return setProblem(refusalText(res.error));
    const kept = res.data.leftOnHost;
    onAttempt(
      res.data.conversion,
      kept === null
        ? "The conversion was abandoned; the project is an ordinary project again."
        : `The conversion was abandoned. The repository ${kept.fullName} stays on ${hostOf(kept.baseUrl)}: a Workspace admin can delete or reuse it.`,
    );
  };

  return (
    <div className="flex flex-col gap-1.5">
      <p className="m-0">
        {`${attempt.fullName} on ${hostOf(attempt.baseUrl)} (${attempt.visibility}), ${attempt.carryHistory ? "with its history" : "one commit of the current files"}`}
      </p>
      {lost && status === "running" && (
        <p role="alert" className="m-0">
          Kobe could not read the conversion&apos;s progress. It goes on in the background: close
          this and open Convert to repo… again later, or wait for the email.
        </p>
      )}
      {status === "running" && (
        <>
          <p id={`${id}-s`} role="status" className="m-0">
            {conversionProgressText(attempt)}
          </p>
          {attempt.step === "push" && attempt.commitsTotal !== null && (
            <progress
              aria-labelledby={`${id}-s`}
              max={attempt.commitsTotal}
              value={attempt.commitsPushed}
              className="w-full"
            />
          )}
          <p className="text-muted-foreground m-0">
            You can close this: the conversion goes on, and its end shows here and in an email.
          </p>
        </>
      )}
      {status === "completed" && (
        <p role="status" className="m-0">
          {conversionEndText(attempt)}
        </p>
      )}
      {status === "failed" && (
        <p role="alert" className="text-destructive m-0">
          {conversionEndText(attempt)}
        </p>
      )}
      {problem && (
        <p role="alert" className="text-destructive m-0">
          {problem}
        </p>
      )}
      {confirming && (
        <p role="note" className="m-0">
          Abandon the conversion? The project becomes an ordinary project again; a repository the
          host already created stays there.
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        {status === "failed" && !confirming && (
          <>
            <button type="button" className={BUTTON} disabled={busy} onClick={() => void retry()}>
              Retry
            </button>
            <button
              type="button"
              className={BUTTON}
              disabled={busy}
              onClick={() => setConfirming(true)}
            >
              Abandon…
            </button>
          </>
        )}
        {confirming && (
          <>
            <button type="button" className={BUTTON} onClick={() => setConfirming(false)}>
              Keep it
            </button>
            <button type="button" className={BUTTON} disabled={busy} onClick={() => void abandon()}>
              Abandon conversion
            </button>
          </>
        )}
        <button ref={close} type="button" className={BUTTON} onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
