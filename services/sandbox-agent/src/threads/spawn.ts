import { chmod, chown, mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { MEMORY_FILE_ENV, MEMORY_FILE_NAME, MemoryContextFile } from "../memory/context-file.js";
import { PiProcess, type PiExit, type PiRecord } from "../pi/pi-process.js";
import type { PiIdentities, PiIdentity } from "../pi/identities.js";
import type { PiLaunch } from "../pi/pi-launch.js";
import { piCommand } from "../pi/pi-command.js";
import { shareOnVolume } from "../workspace/volume.js";
import { ensureSessionDir } from "../pi/session-files.js";
import { MODEL_FILE_ENV } from "../kobe-models/protocol.js";
import { CONTEXT_FILE_ENV, CONTEXT_FILE_NAME } from "../kobe-models/context-capture.js";
import {
  SYSTEM_PROMPT_FILE_NAME,
  SystemPromptFile,
  systemPromptArgs,
} from "../pi/system-prompt-file.js";
import { writeGuardedConfig } from "../models/agent-config.js";
import {
  buildPiMcpConfig,
  MCP_CONFIG_FILE,
  MCP_TOKEN_FILE,
  mcpTokenFileText,
  writeAgentFile,
} from "../mcp/pi-mcp-config.js";
import { ModelFile } from "../models/model-file.js";
import {
  AGENT_SUBDIR,
  MODEL_FILE_NAME,
  RUNTIME_DIR_PREFIX,
  ensureRuntimeRoot,
  removeRuntimeDir,
} from "../models/runtime-dir.js";
import type { RunModel } from "../models/types.js";
import { TOOL_HOME_ENV } from "../kobe-exec/protocol.js";
import type { ExecRelay } from "../exec/relay.js";
import { assertPaired, openRelay, preparePiPrivateDirs, prepareToolDir } from "./exec-wiring.js";
import { EGRESS_TOKEN_FILE_NAME, EgressTokenFile, egressEnv } from "../egress/egress-wiring.js";
import {
  GIT_CONFIG_FILE_NAME,
  GitConfigFile,
  gitConfigText,
  gitEnv,
} from "../git/git-config.js";
import type { McpConfigState, RuntimeOf, ThreadEnv } from "./thread-env.js";

/** What `Thread#spawn` gets back: the started Pi and the files the thread then watches. */
export interface SpawnedPi {
  readonly pi: PiProcess;
  readonly runtime: RuntimeOf;
  readonly modelFile: ModelFile | undefined;
  readonly mcpConfig: McpConfigState | undefined;
  readonly egressFile: EgressTokenFile | undefined;
  /** The process's git config (KOBE-764): safe defaults now, the run's identity at each run. */
  readonly gitFile: GitConfigFile | undefined;
  readonly promptFile: SystemPromptFile | undefined;
  readonly memoryFile: MemoryContextFile | undefined;
  readonly contextFile: string | undefined;
}

/** The thread's side of a Pi being started: its record handlers and its set of closing Pis. */
export interface SpawnCallbacks {
  readonly onEvent: (pi: PiProcess, event: PiRecord) => void;
  readonly onUiRequest: (pi: PiProcess, record: PiRecord) => void;
  readonly onExit: (pi: PiProcess, exit: PiExit) => void;
  readonly diagnostic: (threadId: string, message: string) => void;
  /** Pis being stopped on purpose (their exit is not reported). */
  readonly closing: Set<PiProcess>;
}

/**
 * Start one Pi for `threadId` with `launch` (`Thread#spawn`, inside the thread's lock): its
 * private runtime directory (and identity), config, model, egress, prompt and memory files, and
 * the executor relay. On failure nothing of it stays behind and the error is rethrown.
 */
export async function spawnPi(
  threadEnv: ThreadEnv,
  threadId: string,
  launch: PiLaunch,
  model: RunModel | null,
  callbacks: SpawnCallbacks,
): Promise<SpawnedPi> {
  const identities = threadEnv.identities;
  await ensureSessionDir(threadEnv.sessionDir, {
    shared: identities !== undefined,
    workspaceDir: threadEnv.workspaceDir,
  });
  await mkdir(threadEnv.home, { recursive: true }).catch(() => undefined);
  // Shared by every thread (the pod's home volume is; one the agent made itself must be too).
  if (identities !== undefined) await shareOnVolume(threadEnv.home, threadEnv.home, 0o2770);
  await ensureRuntimeRoot(threadEnv.runtimeDir, identities !== undefined);
  const exec = launch.execChannel ? threadEnv.exec : undefined;
  if (launch.execChannel && exec === undefined) {
    throw new Error("the launch asks for kobe-exec but this agent has no tool executor");
  }
  if (exec !== undefined) assertPaired(identities);
  const identity = await identities?.acquire();
  let runtimeDir: string | undefined;
  let toolDir: string | undefined;
  let piDir: string | undefined;
  let relay: ExecRelay | undefined;
  let pi: PiProcess;
  let modelFile: ModelFile | undefined;
  let mcpConfig: McpConfigState | undefined;
  let egressFile: EgressTokenFile | undefined;
  let gitFile: GitConfigFile | undefined;
  let promptFile: SystemPromptFile | undefined;
  let memoryFile: MemoryContextFile | undefined;
  let contextFile: string | undefined;
  try {
    runtimeDir = await mkdtemp(path.join(threadEnv.runtimeDir, RUNTIME_DIR_PREFIX));
    const env: Record<string, string> = { ...launch.env };
    const agentDir = path.join(runtimeDir, AGENT_SUBDIR);
    if (identity === undefined) {
      await mkdir(agentDir, { mode: 0o700 });
    } else {
      await prepareIdentityDirs(runtimeDir, identity);
    }
    await writeGuardedConfig(agentDir, identity !== undefined);
    env.PI_CODING_AGENT_DIR = agentDir;
    // Per-session MCP (KOBE-111): the file goes into this process's private config dir, the one
    // place Pi reads `mcp.json`; the workspace and the shared HOME are never involved.
    if (launch.mcp !== undefined) {
      const wiring = threadEnv.mcp;
      if (wiring === undefined) throw new Error("this sandbox has no MCP proxy wiring");
      const config = buildPiMcpConfig({
        proxyUrl: wiring.proxyUrl,
        tokenFile: path.join(agentDir, MCP_TOKEN_FILE),
        threadId: threadId,
        mcp: launch.mcp,
      });
      const tokenText = mcpTokenFileText(await wiring.tokens.current());
      mcpConfig = {
        agentDir,
        shared: identity !== undefined,
        mcp: launch.mcp,
        config,
        tokenTexts: [tokenText],
      };
      // Token first: Pi may run the header command as soon as it reads the config.
      await writeAgentFile(agentDir, MCP_TOKEN_FILE, tokenText, mcpConfig.shared);
      await writeAgentFile(agentDir, MCP_CONFIG_FILE, config, mcpConfig.shared);
    }
    // The tools get the launch's HOME and TMPDIR (the shared ones); Pi gets private ones, as it
    // loads code from both. With the executor the tools are another uid; without it (KOBE-228)
    // they are Pi's own and inherit its environment, so the shared ones reach them through the
    // BASH_ENV script (`KOBE_TOOL_HOME`/`KOBE_TOOL_TMPDIR`).
    // Known limit (KOBE-235): `~` in Pi's own read/write/edit tools is expanded inside Pi against
    // its private HOME, so a file written to `~/x` there is lost when Pi exits; bash tools and
    // the executor's file tools see the shared home. Not mapped: Pi's HOME must stay private
    // (it loads code from it) and Pi 1.0.x has no hook to remap `~` without the executor.
    const toolEnvBase = { ...env };
    const priv = await preparePiPrivateDirs(threadEnv.piPrivateRoot ?? "/tmp", identity, {
      partner: exec !== undefined,
    });
    piDir = priv.root;
    env.HOME = priv.home;
    env.TMPDIR = priv.tmp;
    if (exec !== undefined) {
      // `~` in the file tools is resolved by Pi: tell kobe-exec where the tools' home is.
      if (toolEnvBase.HOME !== undefined) env[TOOL_HOME_ENV] = toolEnvBase.HOME;
    } else {
      if (toolEnvBase.HOME !== undefined) env.KOBE_TOOL_HOME = toolEnvBase.HOME;
      // No TMPDIR in the launch: the tools' scratch is /tmp, never Pi's private (deleted) one.
      env.KOBE_TOOL_TMPDIR = toolEnvBase.TMPDIR ?? "/tmp";
      // The switch itself is the BASH_ENV script, whether or not egress is wired (KOBE-235);
      // with egress it sets the same variable below.
      if (threadEnv.toolEnvScript !== undefined) env.BASH_ENV = threadEnv.toolEnvScript;
    }
    const models = threadEnv.models;
    if (models !== undefined) {
      modelFile = new ModelFile(
        path.join(runtimeDir, MODEL_FILE_NAME),
        {
          gatewayUrl: models.gatewayUrl,
          model,
          token: await models.tokens.current(),
          runId: null,
        },
        identity === undefined ? 0o600 : 0o640,
      );
      await modelFile.create();
      env[MODEL_FILE_ENV] = modelFile.path;
      // The context viewer's capture (KOBE-470): written by kobe-models in the dir Pi writes.
      contextFile = path.join(agentDir, CONTEXT_FILE_NAME);
      env[CONTEXT_FILE_ENV] = contextFile;
    }
    const command = await piCommand(threadEnv.bin, launch.env.PATH);
    const egress = threadEnv.egress;
    let egressVars: Record<string, string> = {};
    if (egress !== undefined) {
      // With the executor the tools are not Pi's: the token lives where their uid (and not
      // Pi) can read it, and the variables go to the executor, not to Pi.
      if (exec !== undefined && identity !== undefined) {
        toolDir = await prepareToolDir(runtimeDir, identity);
      }
      egressFile = new EgressTokenFile(
        path.join(toolDir ?? runtimeDir, EGRESS_TOKEN_FILE_NAME),
        identity === undefined ? 0o600 : 0o640,
      );
      await egressFile.write(await egress.tokens.current());
      egressVars = egressEnv(egress, egressFile.path, threadId);
      if (exec === undefined) Object.assign(env, egressVars);
    }
    // Git (KOBE-764): the tools' global config is this process's own file, never ~/.gitconfig;
    // no credential helper, no prompt. Readable by the tools (next to the egress token), written
    // only by the agent; `attachGit` rewrites it with the run's identity and remotes.
    if (exec !== undefined && identity !== undefined && toolDir === undefined) {
      toolDir = await prepareToolDir(runtimeDir, identity);
    }
    gitFile = new GitConfigFile(
      path.join(toolDir ?? runtimeDir, GIT_CONFIG_FILE_NAME),
      identity === undefined ? 0o600 : 0o640,
    );
    await gitFile.write(gitConfigText(undefined));
    const gitVars = gitEnv(gitFile.path);
    // Pi's environment is an allow-list that never names these; dropped here all the same.
    delete env.GIT_ASKPASS;
    delete env.SSH_ASKPASS;
    if (exec === undefined) Object.assign(env, gitVars);
    if (launch.systemPrompt !== undefined) {
      promptFile = new SystemPromptFile(
        path.join(runtimeDir, SYSTEM_PROMPT_FILE_NAME),
        launch.systemPrompt,
        identity === undefined ? 0o600 : 0o640,
      );
      await promptFile.write();
    }
    if (launch.memoryFile) {
      // Memory off until the run says otherwise (attachMemory, before every prompt).
      memoryFile = new MemoryContextFile(
        path.join(runtimeDir, MEMORY_FILE_NAME),
        identity === undefined ? 0o600 : 0o640,
      );
      await memoryFile.write({ tools: false, text: "", project: "" });
      env[MEMORY_FILE_ENV] = memoryFile.path;
    }
    pi = new PiProcess({
      bin: command.bin,
      args: [
        ...command.prefix,
        ...launch.args,
        ...(promptFile === undefined ? [] : systemPromptArgs(promptFile.path)),
      ],
      cwd: threadEnv.workspaceDir,
      env,
      onEvent: (event) => callbacks.onEvent(pi, event),
      onUiRequest: (request) => callbacks.onUiRequest(pi, request),
      onExit: (exit) => callbacks.onExit(pi, exit),
      onDiagnostic: (message) => callbacks.diagnostic(threadId, message),
      ...(launch.toolsChannel ? { toolsChannel: true } : {}),
      ...(exec === undefined ? {} : { execChannel: true }),
      ...(identity === undefined || identities === undefined
        ? {}
        : { runAs: { identities, identity } }),
    });
    if (exec !== undefined) {
      try {
        relay = openRelay({
          pi,
          wiring: exec,
          launchEnv: toolEnvBase,
          egress: { ...egressVars, ...gitVars },
          cwd: threadEnv.workspaceDir,
          runAs:
            identity === undefined || identities === undefined
              ? undefined
              : { identities, identity },
          onDiagnostic: (message) => callbacks.diagnostic(threadId, message),
        });
      } catch (error) {
        // A Pi whose tools have nowhere to go must not run: its own would be the fallback.
        callbacks.closing.add(pi);
        pi.kill();
        await pi.whenExited();
        callbacks.closing.delete(pi);
        throw error;
      }
    }
  } catch (error) {
    // Nothing of a Pi that never started may stay behind (the token included).
    if (runtimeDir !== undefined) {
      const removed = await removeDirs([runtimeDir, toolDir, piDir], identities);
      // A directory the next holder of the identity could read: keep the identity out of use.
      if (removed && identity !== undefined) identities?.release(identity);
    } else if (identity !== undefined) {
      identities?.release(identity);
    }
    throw error;
  }
  return {
    pi,
    runtime: { dir: runtimeDir, identity, toolDir, piDir, relay },
    modelFile,
    mcpConfig,
    egressFile,
    gitFile,
    promptFile,
    memoryFile,
    contextFile,
  };
}

/**
 * Under a Pi identity: the runtime directory becomes the agent's with the Pi's own group
 * (setgid, 2750: the Pi reads it, nobody else gets in), with `agent/` the only place that Pi
 * may write (3770, sticky: it cannot rename or delete the agent's guarded files there, see
 * models/agent-config.ts; Pi 1.0.0 writes its credential and catalog stores there).
 */
async function prepareIdentityDirs(runtimeDir: string, identity: PiIdentity): Promise<void> {
  await chown(runtimeDir, -1, identity.gid);
  await chmod(runtimeDir, 0o2750);
  const agentDir = path.join(runtimeDir, AGENT_SUBDIR);
  await mkdir(agentDir);
  await chmod(agentDir, 0o3770);
}

/** Remove runtime directories (the second is optional); true when every one is gone. */
async function removeDirs(
  dirs: readonly (string | undefined)[],
  identities: PiIdentities | undefined,
): Promise<boolean> {
  let all = true;
  for (const dir of dirs) {
    if (dir === undefined) continue;
    const removed = await removeRuntimeDir(dir, identities).then(
      () => true,
      () => false,
    );
    all = all && removed;
  }
  return all;
}
