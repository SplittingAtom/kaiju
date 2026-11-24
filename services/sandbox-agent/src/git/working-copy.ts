import path from "node:path";
import {
  REPO_STATUS_PROBLEM_MAX,
  REPO_WORKING_COPY_DIR,
  repoStatusFrameSchema,
  type RepoStatusFrame,
  type RunGitRepo,
} from "@kaiju/protocol/sandbox-wire";

/**
 * The conversation's Repo as a real git working copy (KOBE-767, spec workspace-git G18, G19). When
 * `run.start.git.repo` names one, the agent makes sure `/workspace/.kobe/repos/<slug>` is a git working
 * copy of it before the prompt, and reports its branch, ahead/behind and whether it has changes to
 * the server (`repo.status`) then and again when the run ends.
 *
 * The work is one FIXED bash script ({@link REPO_SCRIPT}) with positional arguments only, run AS
 * THE THREAD'S TOOLS (their uid, their environment: the egress BASH_ENV script and token file, the
 * thread's git config with the `insteadOf` rewrites, no prompt). So the clone goes through the
 * egress proxy exactly as the agent's own `git clone` would, and git never runs as the agent's uid
 * over a repository the tools control (its config, hooks or fsmonitor would execute as the agent).
 *
 * The working copy lives under the workspace's reserved `.kobe/` area (`REPO_WORKING_COPY_DIR`,
 * review M4 and N2): the sync never pushes, pulls, restores or deletes anything there and the
 * server never stores such a path, so a Repo's files never become a copy in the member's own
 * storage (outside the project's read rule, quota, retention and legal hold), and nothing of the
 * member's own files (a My files folder named `repos/` included) can land in it. It is
 * re-clonable: a sandbox volume that was lost comes back without it and the script clones again;
 * uncommitted and unpushed work there lives only on the sandbox's volume (the guide and the run
 * context say so). A folder that exists without `.git` (files the agent wrote there before the
 * clone) is initialised in place and reset to the default branch, keeping the files as
 * uncommitted changes. An existing working copy whose `origin` is not the Repo's URL (a reused
 * slug, a renamed repository) is pointed at it again before the fetch (review L4).
 */

/** Time the start of a run waits for the working copy (a first clone may be large). */
export const REPO_PREPARE_TIMEOUT_MS = 120_000;
/** Time the status at the end of a run may take (a fetch, then the counts). */
export const REPO_STATUS_TIMEOUT_MS = 30_000;
/** The script prints one short line; anything beyond this is cut and the line refused. */
export const REPO_SCRIPT_MAX_OUTPUT = 4096;
const COUNT_MAX = 10_000;
const MARK = "KAIJU-REPO-STATUS";

/**
 * Arguments: <dir> <clone url> <default branch> <fetch: 1|0>. Every git call's own output goes to
 * /dev/null; problems are fixed words only (no host text, no URL). Prints exactly one status line,
 * tab-separated: mark, branch, head, upstream, ahead, behind, dirty, fetched, problem.
 */
export const REPO_SCRIPT = String.raw`set -u
dir=$1; url=$2; branch=$3; dofetch=$4
export GIT_TERMINAL_PROMPT=0
problem=""; fetched=1
note() { if [ -z "$problem" ]; then problem=$1; fi; }
g() { git -C "$dir" "$@" >/dev/null 2>&1; }
if [ ! -e "$dir/.git" ]; then
  mkdir -p "$dir" 2>/dev/null || note "cannot create the folder"
  if [ -z "$(ls -A "$dir" 2>/dev/null)" ]; then
    if git clone --quiet -c core.sharedRepository=group "$url" "$dir" >/dev/null 2>&1; then
      g rev-parse -q --verify HEAD || g symbolic-ref HEAD "refs/heads/$branch"
    else
      note "clone failed"; fetched=0
    fi
  else
    if git init --quiet --shared=group "$dir" >/dev/null 2>&1; then
      g symbolic-ref HEAD "refs/heads/$branch"
      g remote add origin "$url"
      if g fetch --quiet origin; then
        if g rev-parse -q --verify "refs/remotes/origin/$branch"; then
          g reset --quiet --mixed "origin/$branch" || note "reset failed"
          g branch --quiet "--set-upstream-to=origin/$branch"
        fi
      else
        note "fetch failed"; fetched=0
      fi
    else
      note "init failed"
    fi
  fi
else
  cur=$(git -C "$dir" config --get remote.origin.url 2>/dev/null) || cur=""
  if [ "$cur" != "$url" ]; then
    g remote set-url origin "$url" || g remote add origin "$url" || note "origin not set"
  fi
  if [ "$dofetch" = 1 ]; then
    g fetch --quiet origin || { note "fetch failed"; fetched=0; }
  fi
fi
b=""; h=""; up=""; ahead=0; behind=0; dirty=0
if [ -e "$dir/.git" ]; then
  b=$(git -C "$dir" symbolic-ref -q --short HEAD 2>/dev/null) || b=""
  h=$(git -C "$dir" rev-parse -q --verify HEAD 2>/dev/null) || h=""
  up=$(git -C "$dir" rev-parse -q --abbrev-ref --symbolic-full-name "@{upstream}" 2>/dev/null) || up=""
  cmp=$up
  if [ -z "$cmp" ] && g rev-parse -q --verify "refs/remotes/origin/$branch"; then cmp="origin/$branch"; fi
  if [ -n "$h" ] && [ -n "$cmp" ]; then
    counts=$(git -C "$dir" rev-list --left-right --count "HEAD...$cmp" 2>/dev/null) || counts=""
    ahead=$(printf '%s\n' "$counts" | awk '{print $1}')
    behind=$(printf '%s\n' "$counts" | awk '{print $2}')
  elif [ -n "$h" ]; then
    ahead=$(git -C "$dir" rev-list --count HEAD 2>/dev/null) || ahead=0
  elif [ -n "$cmp" ]; then
    behind=$(git -C "$dir" rev-list --count "$cmp" 2>/dev/null) || behind=0
  fi
  if [ -n "$(git -C "$dir" status --porcelain 2>/dev/null | head -c 1)" ]; then dirty=1; fi
else
  note "no working copy"
fi
printf '${MARK}\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$b" "$h" "$up" "$ahead" "$behind" "$dirty" "$fetched" "$problem"
`;

/** The working copy's folder for a Repo (`<workspace>/.kobe/repos/<slug>`). */
export function workingCopyDir(workspaceDir: string, repo: Pick<RunGitRepo, "slug">): string {
  return path.join(workspaceDir, REPO_WORKING_COPY_DIR, repo.slug);
}

/** `bash -c <script> kaiju-repo <dir> <url> <branch> <fetch>`: no value is ever in the script. */
export function repoScriptArgs(
  workspaceDir: string,
  repo: RunGitRepo,
  fetch: boolean,
): readonly string[] {
  return [
    "-c",
    REPO_SCRIPT,
    "kaiju-repo",
    workingCopyDir(workspaceDir, repo),
    repo.clone_url,
    repo.default_branch,
    fetch ? "1" : "0",
  ];
}

export type RepoStatus = Omit<
  RepoStatusFrame,
  "v" | "type" | "run_id" | "thread_id" | "project_id"
>;

const count = (raw: string | undefined): number => {
  if (raw === undefined || !/^\d{1,12}$/.test(raw)) return 0;
  return Math.min(Number(raw), COUNT_MAX);
};

/** The script's status line, checked field by field; undefined when there is none. */
export function parseRepoStatus(stdout: string): RepoStatus | undefined {
  if (stdout.length > REPO_SCRIPT_MAX_OUTPUT) return undefined;
  const line = stdout
    .split("\n")
    .reverse()
    .find((l) => l.startsWith(`${MARK}\t`));
  if (line === undefined) return undefined;
  const fields = line.split("\t");
  if (fields.length !== 9) return undefined;
  const [, branch, head, upstream, ahead, behind, dirty, fetched, problem] = fields;
  const shape = repoStatusFrameSchema.shape;
  const orNull = <T>(
    schema: { safeParse(v: unknown): { success: boolean } },
    v: string | undefined,
  ) => (v !== undefined && v !== "" && schema.safeParse(v).success ? (v as T) : null);
  return {
    branch: orNull<string>(shape.branch, branch),
    head_sha: orNull<string>(shape.head_sha, head),
    upstream: orNull<string>(shape.upstream, upstream),
    ahead: count(ahead),
    behind: count(behind),
    dirty: dirty === "1",
    fetched: fetched === "1",
    problem: problem === undefined || problem === "" ? null : clip(problem),
  };
}

const clip = (text: string): string =>
  // eslint-disable-next-line no-control-regex
  text.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, REPO_STATUS_PROBLEM_MAX);

/** A status when the script gave none (timed out, could not start, no tools identity). */
export function failedStatus(problem: string): RepoStatus {
  return {
    branch: null,
    head_sha: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    dirty: false,
    fetched: false,
    problem: clip(problem),
  };
}

export function repoStatusFrame(
  runId: string,
  threadId: string,
  repo: Pick<RunGitRepo, "project_id">,
  status: RepoStatus,
): RepoStatusFrame {
  return {
    v: 1,
    type: "repo.status",
    run_id: runId,
    thread_id: threadId,
    project_id: repo.project_id,
    ...status,
  };
}

/** Runs a program as the thread's tools; resolves with its stdout (cut) or a reason it did not. */
export type ToolCommandRunner = (
  file: string,
  args: readonly string[],
  options: { readonly timeoutMs: number; readonly maxOutput: number },
) => Promise<{ readonly stdout: string } | { readonly failed: string }>;

/**
 * Prepares (or fetches) the working copy and reads its state. Never throws: a failure becomes a
 * status with its problem, so the run goes on and the server still hears about it.
 */
export async function workingCopyStatus(
  run: ToolCommandRunner,
  workspaceDir: string,
  repo: RunGitRepo,
  options: { readonly fetch: boolean; readonly timeoutMs: number },
): Promise<RepoStatus> {
  try {
    const result = await run("/bin/bash", repoScriptArgs(workspaceDir, repo, options.fetch), {
      timeoutMs: options.timeoutMs,
      maxOutput: REPO_SCRIPT_MAX_OUTPUT,
    });
    if ("failed" in result) return failedStatus(result.failed);
    return parseRepoStatus(result.stdout) ?? failedStatus("no status from git");
  } catch {
    return failedStatus("git could not run");
  }
}
