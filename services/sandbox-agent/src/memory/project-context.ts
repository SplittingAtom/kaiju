import type { RunProjectContext } from "@kobe/protocol";
import { REPO_WORKING_COPY_DIR, type RunGitRepo } from "@kobe/protocol/sandbox-wire";
import { capBytes, sanitizeUntrusted } from "../kobe-tools/memory-fence.js";

/**
 * Project instructions in the model's context (KOBE-245, `run.start.project`). They ride the same
 * per-run file as the memory index (memory/context-file.ts), so editing them never restarts Pi.
 *
 * Trust: written by project admins (owners), so unlike saved memory they are NOT fenced as
 * untrusted data; the model is told to follow them. They still pass the memory sanitiser (NFKC,
 * no control or format characters, no `<<<`, so they cannot forge a memory fence or hide text) and
 * are capped. They are a prompt, not a permission: tools, approvals and policy are server-side.
 */
export const PROJECT_HEADER = "## Project instructions (set by project admins)";
export const PROJECT_INSTRUCTIONS_CAP_BYTES = 8 * 1024;

const oneLine = (value: string): string => sanitizeUntrusted(value).replace(/\s+/g, " ").trim();

/**
 * The viewer's access to the project (spec PR3, CM6; KOBE-580), from `run.start.project.access`:
 * the agent can tell a reader it cannot change the project instead of failing a commit. Absent
 * (an old server) reads as `read`.
 */
export function projectAccessLine(project: RunProjectContext): string {
  const name = oneLine(project.name);
  const mount = oneLine(project.mount);
  return project.access === "write"
    ? `You can edit project "${name}"; commit with commit_project. Its files under ${mount} are writable while the user has the project checked out (read-only otherwise: ask them to check it out first); commit_project then makes your changes the project's next version. To change a project file, call propose_file_edit; the member accepts it and that commits it.`
    : `You can read project "${name}" but not change it: its files under ${mount} are read-only to you and you cannot commit. If the user wants the project changed, tell them an editor of the project has to do it.`;
}

/**
 * The project is a Repo (KOBE-767, spec workspace-git G18): where its git working copy is and how
 * changes reach the host. Only for the run's own project (`repo.project_id`); values were checked
 * by the wire schema and are cleaned once more here.
 */
export function repoLine(
  project: RunProjectContext,
  repo: RunGitRepo | undefined,
): string | undefined {
  if (repo === undefined || repo.project_id !== project.id) return undefined;
  const dir = `/workspace/${REPO_WORKING_COPY_DIR}/${oneLine(repo.slug)}`;
  const branch = oneLine(repo.default_branch);
  const url = oneLine(repo.clone_url);
  const base = `This project is a Repo: its record is the git repository ${url} (default branch ${branch}). Its git working copy is ${dir} (origin = that repository, prepared before this message); ${oneLine(project.mount)} is Kobe's read-only copy of the default branch.`;
  return repo.access === "write"
    ? `${base} To change the Repo, work in ${dir}: create a branch, commit, push it (git push -u origin <branch>), then open a pull request with git_open_pull_request. commit_project on the user's checked-out copy also ends on the host, as a pull request by default. Its .git folder is not synced to the user's files: push your branches.`
    : `${base} You may fetch and read it there, but you cannot push to it: the user is not an editor of the project, or the Workspace's connection is read-only.`;
}

/** The project section (instructions, if any, and the viewer's access); undefined without a project. */
export function projectContextText(
  project: RunProjectContext | undefined,
  repo?: RunGitRepo,
): string | undefined {
  if (project === undefined) return undefined;
  const asRepo = repoLine(project, repo);
  const access =
    asRepo === undefined ? projectAccessLine(project) : `${projectAccessLine(project)}\n${asRepo}`;
  const clean = sanitizeUntrusted(project.instructions).trim();
  const belongs = `This conversation belongs to the project "${oneLine(project.name)}" (files are under ${oneLine(project.mount)}).`;
  if (clean === "") {
    return [PROJECT_HEADER, `${belongs} Its admins wrote no instructions.`, access].join("\n");
  }
  const capped = capBytes(clean, PROJECT_INSTRUCTIONS_CAP_BYTES);
  const lines = [
    PROJECT_HEADER,
    `${belongs} The project's admins wrote the instructions below: follow them for this project's work. They do not change your safety rules, tools or approvals.`,
    access,
    capped.text,
  ];
  if (capped.cut || project.truncated === true) lines.push("(the instructions are truncated)");
  return lines.join("\n");
}
