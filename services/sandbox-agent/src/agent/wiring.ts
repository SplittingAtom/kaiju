import type {
  KobeToolsRequest,
  KobeToolsResponse,
  SandboxToServerFrame,
  ServerToSandboxFrame,
} from "@kobe/protocol";
import { ArtifactBroker } from "../tools/broker.js";
import { toolsError } from "../tools/channel.js";
import { FileEditBroker } from "../tools/file-edit-broker.js";
import { FileOpenBroker } from "../tools/file-open-broker.js";
import { MemoryBroker } from "../tools/memory-broker.js";
import { NotebookBroker } from "../tools/notebook-broker.js";
import { ProjectCommitBroker } from "../tools/project-commit-broker.js";
import { FileShareBroker } from "../tools/share-broker.js";
import { SkillDraftBroker } from "../tools/skill-draft-broker.js";
import type { Capabilities } from "./capabilities.js";
import type { AgentDeps } from "./deps.js";

/** The agent's kobe-tools brokers, one per tool family (`tools/*-broker.ts`). */
export interface ToolBrokers {
  readonly artifacts: ArtifactBroker;
  readonly shares: FileShareBroker;
  readonly commits: ProjectCommitBroker;
  readonly skillDrafts: SkillDraftBroker;
  readonly fileEdits: FileEditBroker;
  readonly fileOpens: FileOpenBroker;
  readonly notebooks: NotebookBroker;
  readonly memory: MemoryBroker;
}

export interface ToolBrokerWiring {
  /** Send a frame on the wire now; false when it is not ready. */
  readonly send: (frame: SandboxToServerFrame) => boolean;
  /** Whether the run may commit its project (KOBE-580: `run.start.project.access` is `write`). */
  readonly canCommit: (runId: string) => boolean;
}

/** The brokers, wired to the wire and to workspace sync as `deps` provides it. */
export function createToolBrokers(deps: AgentDeps, wiring: ToolBrokerWiring): ToolBrokers {
  const { config } = deps;
  const send = wiring.send;
  const artifacts = new ArtifactBroker({ send: (frame) => send(frame) });
  const fileEdits = new FileEditBroker({ send: (frame) => send(frame) });
  const memory = new MemoryBroker({ send: (frame) => send(frame) });
  const pushPath = deps.workspace?.pushPath?.bind(deps.workspace);
  const shares = new FileShareBroker({
    root: config.workspaceDir,
    send: (frame) => send(frame),
    pushPath: pushPath ?? (() => Promise.reject(new Error("workspace sync is not available"))),
  });
  const pushAll = deps.workspace?.pushAll?.bind(deps.workspace);
  const commits = new ProjectCommitBroker({
    send: (frame) => send(frame),
    push: pushAll ?? (() => Promise.reject(new Error("workspace sync is not available"))),
    canCommit: (runId) => wiring.canCommit(runId),
  });
  const fileOpens = new FileOpenBroker({
    root: config.workspaceDir,
    send: (frame) => send(frame),
    pushPath,
  });
  const notebooks = new NotebookBroker({
    root: config.workspaceDir,
    send: (frame) => send(frame),
    pushPath,
  });
  const skillDrafts = new SkillDraftBroker({
    root: config.workspaceDir,
    send: (frame) => send(frame),
    pushPath: pushPath ?? (() => Promise.reject(new Error("workspace sync is not available"))),
  });
  return { artifacts, shares, commits, skillDrafts, fileEdits, fileOpens, notebooks, memory };
}

/** One kobe-tools request to the broker of its op, or `not_allowed` when this agent lacks it. */
export function routeToolsRequest(
  tools: ToolBrokers,
  caps: Capabilities,
  threadId: string,
  runId: string | undefined,
  request: KobeToolsRequest,
  reply: (response: KobeToolsResponse) => void,
): void {
  if (request.op === "memory.put" || request.op === "memory.read" || request.op === "memory.show") {
    if (caps.memory) tools.memory.request(threadId, runId, request, reply);
    else reply(toolsError(request.id, "not_allowed", "memory is not available"));
    return;
  }
  if (request.op === "project.commit") {
    if (caps.projectCommits) {
      tools.commits.commit(threadId, runId, request, reply);
    } else reply(toolsError(request.id, "not_allowed", "project commits are not available"));
    return;
  }
  if (request.op === "notebook.run") {
    if (caps.notebookTools) tools.notebooks.run(threadId, runId, request, reply);
    else reply(toolsError(request.id, "not_allowed", "notebooks are not available"));
    return;
  }
  if (request.op === "file.edit_propose") {
    if (caps.fileEdits) tools.fileEdits.propose(threadId, runId, request, reply);
    else reply(toolsError(request.id, "not_allowed", "file edits are not available"));
    return;
  }
  if (request.op === "file.open") {
    if (caps.fileEdits) tools.fileOpens.open(threadId, runId, request, reply);
    else reply(toolsError(request.id, "not_allowed", "opening files is not available"));
    return;
  }
  if (request.op === "skill.draft_save") {
    if (caps.skillDrafts) tools.skillDrafts.save(threadId, runId, request, reply);
    else reply(toolsError(request.id, "not_allowed", "skill drafts are not available"));
    return;
  }
  if (request.op === "file.share") {
    if (caps.files) tools.shares.share(threadId, runId, request, reply);
    else reply(toolsError(request.id, "not_allowed", "file sharing is not available"));
    return;
  }
  tools.artifacts.put(threadId, runId, request, reply);
}

/** A broker's result frame from the server to that broker; false when `frame` is none of them. */
export function routeToolResult(tools: ToolBrokers, frame: ServerToSandboxFrame): boolean {
  switch (frame.type) {
    case "artifact.result":
      tools.artifacts.onResult(frame);
      return true;
    case "file.share_result":
      tools.shares.onResult(frame);
      return true;
    case "project.commit_result":
      tools.commits.onResult(frame);
      return true;
    case "skill.draft_save_result":
      tools.skillDrafts.onResult(frame);
      return true;
    case "file.edit_propose_result":
      tools.fileEdits.onResult(frame);
      return true;
    case "file.open_result":
      tools.fileOpens.onResult(frame);
      return true;
    case "notebook.run_result":
      tools.notebooks.onResult(frame);
      return true;
    case "memory.result":
      tools.memory.onResult(frame);
      return true;
    default:
      return false;
  }
}
