import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  SKILL_DRAFT_TOOL_MAX_BYTES,
  SKILL_DRAFT_TOOL_MAX_FILES,
  SKILL_DRAFT_TOOL_PATH_MAX,
  workspacePathIssue,
  type KobeToolsRequest,
  type KobeToolsResponse,
  type SkillDraftSaveFile,
} from "@kobe/protocol";
import {
  type SkillDraftSaveFrame,
  type SkillDraftSaveResultFrame,
} from "@kobe/protocol/sandbox-wire";
import { TEMP_PREFIX, lstatIfExists } from "../workspace/fs.js";
import { DEFAULT_SKIP_DIRS, PushPathError, type PushedFile } from "../workspace/sync.js";
import { toolsError } from "./channel.js";
import { PendingRequests } from "./pending-requests.js";

/**
 * The agent side of `save_skill_draft` (KOBE-442; contract: packages/protocol
 * `skill-draft-tool.ts`, push-then-save like `share_file`). One `skill.draft_save` kobe-tools
 * request becomes, in this order and only if each step succeeds: find the folder
 * `/workspace/skills/<folder>/` (a real directory, reached without any symlink), list its files
 * (no symlinks or special files, no hidden files, no cache directories, within the draft's caps),
 * push each through workspace sync, send `skill.draft_save` naming the pushed entries, and relay
 * the server's `skill.draft_save_result` as the tool result. Nothing is sent before every push
 * succeeded; any failure on the way is exactly one error answer. The server reads only the
 * pushed objects, so a file swapped after the listing is caught there (its hash).
 */
export const MAX_PENDING_SKILL_SAVES = 4;
export const MAX_PENDING_SKILL_SAVES_PER_THREAD = 1;

export interface SkillDraftBrokerDeps {
  /** The workspace root (`KOBE_WORKSPACE_DIR`). */
  readonly root: string;
  /** Send a frame now; false when the wire is not ready. */
  readonly send: (frame: SkillDraftSaveFrame) => boolean;
  readonly pushPath: (rel: string) => Promise<PushedFile>;
}

type SaveRequest = Extract<KobeToolsRequest, { op: "skill.draft_save" }>;

class FolderError extends Error {
  constructor(
    readonly code: "not_found" | "invalid_path" | "too_large" | "too_many_files",
    message: string,
  ) {
    super(message);
  }
}

const SKIP_DIRS: ReadonlySet<string> = new Set(DEFAULT_SKIP_DIRS);

/** The folder as a real directory under `<root>/skills/`, or a {@link FolderError}. */
async function folderDir(root: string, folder: string): Promise<string> {
  const rel = `skills/${folder}`;
  const dir = path.join(root, rel);
  let stat;
  try {
    stat = await lstatIfExists(dir);
  } catch {
    // Not missing: something the agent may not read (CODE-25 review).
    throw new FolderError("invalid_path", `/workspace/${rel}/ cannot be read by the agent`);
  }
  if (!stat) throw new FolderError("not_found", `/workspace/${rel}/ does not exist`);
  const real = await realpath(dir).catch(() => undefined);
  const realRoot = await realpath(root).catch(() => undefined);
  if (!stat.isDirectory() || real === undefined || real !== path.join(realRoot ?? "", rel)) {
    throw new FolderError("invalid_path", `/workspace/${rel}/ is not a plain folder`);
  }
  return dir;
}

/** Workspace paths of the folder's regular files, sorted, within the draft's caps. */
async function listFiles(root: string, folder: string): Promise<string[]> {
  const base = `skills/${folder}`;
  const dir = await folderDir(root, folder);
  const files: string[] = [];
  let bytes = 0;
  const walk = async (abs: string, rel: string): Promise<void> => {
    const entries = await readdir(abs, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name.startsWith(TEMP_PREFIX)) continue;
      const child = `${rel}/${entry.name}`;
      if (workspacePathIssue(child) !== undefined || child.length > SKILL_DRAFT_TOOL_PATH_MAX) {
        throw new FolderError("invalid_path", `${child} is not a valid skill file path`);
      }
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(path.join(abs, entry.name), child);
      } else if (entry.isFile()) {
        const stat = await lstat(path.join(abs, entry.name));
        if (!stat.isFile()) continue;
        bytes += stat.size;
        files.push(child);
        if (files.length > SKILL_DRAFT_TOOL_MAX_FILES)
          throw new FolderError(
            "too_many_files",
            `a skill holds at most ${SKILL_DRAFT_TOOL_MAX_FILES} files`,
          );
        if (bytes > SKILL_DRAFT_TOOL_MAX_BYTES)
          throw new FolderError(
            "too_large",
            `a skill holds at most ${SKILL_DRAFT_TOOL_MAX_BYTES} bytes`,
          );
      }
    }
  };
  await walk(dir, base);
  if (files.length === 0) throw new FolderError("not_found", `/workspace/${base}/ has no files`);
  return files;
}

export class SkillDraftBroker {
  readonly #deps: SkillDraftBrokerDeps;
  readonly #pending = new PendingRequests({
    prefix: "sd",
    max: MAX_PENDING_SKILL_SAVES,
    maxPerThread: MAX_PENDING_SKILL_SAVES_PER_THREAD,
  });

  constructor(deps: SkillDraftBrokerDeps) {
    this.#deps = deps;
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  save(
    threadId: string,
    runId: string | undefined,
    request: SaveRequest,
    reply: (response: KobeToolsResponse) => void,
  ): void {
    if (runId === undefined) {
      reply(toolsError(request.id, "not_allowed", "no active run on this thread"));
      return;
    }
    // Registered before the (slow) pushes, so a run that ends meanwhile answers it exactly once.
    const requestId = this.#pending.add(threadId, runId, request.id, reply);
    if (requestId === undefined) {
      reply(toolsError(request.id, "unavailable", "a skill is already being saved"));
      return;
    }
    void this.#run(requestId, threadId, runId, request);
  }

  async #run(requestId: string, threadId: string, runId: string, request: SaveRequest) {
    // A no-op once answered (run ended, connection lost).
    const fail = (code: string, message: string) => this.#pending.fail(requestId, code, message);
    try {
      const listed = await listFiles(this.#deps.root, request.input.folder);
      const files: SkillDraftSaveFile[] = [];
      for (const rel of listed) {
        if (!this.#pending.has(requestId)) return; // answered meanwhile: push no more
        const pushed = await this.#deps.pushPath(rel);
        files.push({
          path: pushed.path,
          rev: pushed.rev,
          sha256: pushed.sha256,
          size: pushed.size,
        });
      }
      if (!this.#pending.has(requestId)) return;
      const frame: SkillDraftSaveFrame = {
        v: 1,
        type: "skill.draft_save",
        request_id: requestId,
        run_id: runId,
        thread_id: threadId,
        tool_call_id: request.tool_call_id,
        tool: request.tool,
        input: request.input,
        files,
      };
      if (!this.#deps.send(frame)) fail("unavailable", "Kaiju server not reachable");
    } catch (error) {
      if (error instanceof FolderError) fail(error.code, error.message);
      else if (error instanceof PushPathError) fail("not_synced", error.message);
      else fail("not_synced", "the skill's files could not be pushed to the Kaiju server");
    }
  }

  /** `skill.draft_save_result` from the server; false when nothing waits for it. */
  onResult(frame: SkillDraftSaveResultFrame): boolean {
    const pending = this.#pending.take(frame.request_id);
    if (pending === undefined) return false;
    if (!frame.ok) {
      pending.reply({ id: pending.extensionId, ok: false, error: frame.error });
      return true;
    }
    const { v: _v, type: _type, request_id: _request, ...fields } = frame;
    pending.reply({ id: pending.extensionId, ...fields });
    return true;
  }

  failAll(message: string): void {
    this.#pending.failAll(message);
  }

  failRun(runId: string, message: string): void {
    this.#pending.failRun(runId, message);
  }

  failThread(threadId: string, message: string): void {
    this.#pending.failThread(threadId, message);
  }
}
