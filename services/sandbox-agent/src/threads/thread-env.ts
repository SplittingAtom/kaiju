import type { KobeToolsRequest, KobeToolsResponse } from "@kobe/protocol";
import type {
  PiExtensionUiRequest,
  RepoStatusFrame,
  RunMcpContext,
} from "@kobe/protocol/sandbox-wire";
import type { EgressWiring } from "../egress/egress-wiring.js";
import type { ExecRelay } from "../exec/relay.js";
import type { McpWiring } from "../mcp/pi-mcp-config.js";
import type { ModelWiring } from "../models/types.js";
import type { PiIdentities, PiIdentity } from "../pi/identities.js";
import type { PiExit, PiRecord } from "../pi/pi-process.js";
import type { PolicyChannelCheck, PolicyChannelReply } from "../policy/channel.js";
import type { ExecWiring } from "./exec-wiring.js";

/** What a {@link Thread} is built from: its environment, the hooks it calls, and its limits. */
export const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
export const MAX_PENDING_DIALOGS = 64;
/** Scratch trees every identity can write besides /workspace and $HOME (reclaimed per uid). */
export const SHARED_SCRATCH_DIRS = ["/tmp", "/dev/shm"] as const;
/** Pi startup (extension loading, jiti) up to kobe-policy's `channel.ready`. */
export const POLICY_READY_TIMEOUT_MS = 30_000;

export interface ThreadHooks {
  readonly runStarted: (runId: string, threadId: string) => void;
  readonly piEvent: (runId: string, threadId: string, event: PiRecord) => void;
  readonly runEnded: (runId: string, threadId: string) => void;
  readonly uiRequest: (
    threadId: string,
    runId: string | undefined,
    request: PiExtensionUiRequest,
  ) => void;
  /** `runId`: the run that was active when Pi exited (the thread is leased only through it). */
  readonly piExited: (threadId: string, runId: string | undefined, exit: PiExit) => void;
  readonly policyCheck: (
    threadId: string,
    runId: string | undefined,
    check: PolicyChannelCheck,
    reply: (message: PolicyChannelReply) => void,
  ) => void;
  /** kobe-policy stopped waiting for one of its checks (timeout, Stop): free its slot. */
  readonly policyCancel?: (threadId: string, requestId: string) => void;
  /** The thread's policy channel is unusable: every pending check of the thread is denied. */
  readonly policyChannelClosed: (threadId: string, reason: string) => void;
  /** kobe-tools asked for an artifact (KOBE-128); absent: no tools channel is served. */
  readonly toolsRequest?: (
    threadId: string,
    runId: string | undefined,
    request: KobeToolsRequest,
    reply: (response: KobeToolsResponse) => void,
  ) => void;
  /** The thread's tools channel is unusable: every pending request of the thread fails. */
  readonly toolsChannelClosed?: (threadId: string, reason: string) => void;
  readonly diagnostic: (threadId: string, message: string) => void;
  /** The run's Repo working copy state (KOBE-767), at run start and at its end. */
  readonly repoStatus?: (frame: RepoStatusFrame) => void;
  /** Something went wrong that does not end a run but an operator should see (warn level). */
  readonly warning?: (threadId: string, message: string) => void;
}

/** What the thread keeps of a Pi's `mcp.json` so a rotated token can be written into it. */
export interface McpConfigState {
  readonly agentDir: string;
  readonly shared: boolean;
  readonly mcp: RunMcpContext;
  /** `mcp.json` as written (static for this process). */
  readonly config: string;
  /** The last two token file texts written (a rotation may be mid-rename): what the tripwire accepts. */
  tokenTexts: readonly string[];
}

export interface ThreadEnv {
  readonly bin: string;
  /**
   * Parent of the private per-process directories (KOBE-41): each Pi gets a fresh `mkdtemp` dir
   * holding its `PI_CODING_AGENT_DIR` (Pi 1.0.0 writes `auth.json` there on every credential
   * read) and its model file; removed when the process exits. Nothing in it outlives the
   * process, so nothing a tool writes there reaches another thread or a later Pi. ($HOME and
   * /tmp stay shared, see docs/ledger/KOBE-71.md.)
   */
  readonly runtimeDir: string;
  /** Model gateway wiring; absent when this sandbox has no model access. */
  readonly models?: ModelWiring | undefined;
  /** Egress for Pi's tools (KOBE-39): token file + BASH_ENV; absent outside Kobe's pods. */
  readonly egress?: EgressWiring | undefined;
  /**
   * The root-owned BASH_ENV script (KOBE-235) for Pi's tools when there is no egress wiring: it
   * switches each bash tool call to the shared HOME/TMPDIR, which does not depend on egress.
   * Absent outside the image (development); with egress, `egress.envScript` is the same file.
   */
  readonly toolEnvScript?: string | undefined;
  /** mcp-proxy wiring for Pi's per-session MCP config (KOBE-111); absent: no connector tools. */
  readonly mcp?: McpWiring | undefined;
  /** The kobe-policy extension (root-owned file), loaded last into every Pi (KOBE-36). */
  readonly policyExtension: string;
  /** The kobe-tools extension (root-owned file, KOBE-128); absent: no tools, no fd 4. */
  readonly toolsExtension?: string | undefined;
  /** The agent announced the `files` capability: the extension registers `share_file` (KOBE-149). */
  readonly shareFiles?: boolean | undefined;
  /** The agent announced `projects` (KOBE-162): kobe-tools registers `commit_project`. */
  readonly projectTools?: boolean | undefined;
  /** The agent announced `skill_drafts` (KOBE-442): kobe-tools registers `save_skill_draft`. */
  readonly skillDraftTools?: boolean | undefined;
  /** The agent announced `file_edits` (KOBE-462): kobe-tools registers `propose_file_edit`. */
  readonly fileEditTools?: boolean | undefined;
  /** The agent announced `notebooks` (KOBE-464): kobe-tools registers `run_python`. */
  readonly notebookTools?: boolean | undefined;
  /** The agent announced `memory` (KOBE-157): kobe-tools registers remember/recall. */
  readonly memoryTools?: boolean | undefined;
  /** Other root-owned extension paths loaded with `-e`, before kobe-policy. */
  readonly extensions?: readonly string[];
  /** How long a new Pi may take to report kobe-policy ready (default {@link POLICY_READY_TIMEOUT_MS}). */
  readonly policyReadyTimeoutMs?: number;
  readonly workspaceDir: string;
  readonly sessionDir: string;
  readonly home: string;
  /**
   * Pi identities (KOBE-71): each Pi process runs as one of them, with a runtime directory, HOME
   * and TMPDIR of its own that no other thread's process can reach. Absent: Pi runs as the
   * agent's own uid (development, tests outside the image).
   */
  readonly identities?: PiIdentities | undefined;
  /**
   * The tool executor (KOBE-167): present, a Pi started with the kobe-exec extension gets the fd-5
   * relay and its tools run in an executor under its partner uid. Absent: Pi runs its own tools.
   */
  readonly exec?: ExecWiring | undefined;
  /**
   * The scratch volume (the pod's /tmp) Pi's private HOME and TMPDIR are made on when the tools run
   * in the executor (KOBE-196). Default `/tmp`.
   */
  readonly piPrivateRoot?: string | undefined;
  /** The kobe-exec extension (root-owned file); loaded into every Pi when `exec` is set. */
  readonly execExtension?: string | undefined;
}

/** A Pi process's private directory and the identity it runs as (if any). */
export interface RuntimeOf {
  readonly dir: string;
  readonly identity: PiIdentity | undefined;
  /** The partner-readable directory beside `dir` (the egress token), under paired identities. */
  readonly toolDir?: string | undefined;
  /** Pi's private HOME/TMPDIR root beside `dir` (KOBE-196), under paired identities. */
  readonly piDir?: string | undefined;
  readonly relay?: ExecRelay | undefined;
  /**
   * How a program runs as this process's tools (KOBE-767: the Repo working copy): their
   * environment (shared HOME, egress BASH_ENV and token file, git config) and their uid (the
   * identity's partner under paired identities, the identity itself without the executor).
   */
  readonly tools?: ToolCommand | undefined;
}

/** A program run as a Pi process's tools (see {@link RuntimeOf.tools}). */
export interface ToolCommand {
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly runAs?:
    | {
        readonly identities: PiIdentities;
        readonly identity: PiIdentity;
        readonly partner: boolean;
      }
    | undefined;
}
