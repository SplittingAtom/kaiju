import { lstat, readFile } from "node:fs/promises";
import {
  gitIdentitySchema,
  type GitIdentity,
  type RunGitContext,
  type RunGitRemote,
} from "@kobe/protocol/sandbox-wire";
import { isTempOf, writeFileAtomic } from "../atomic-file.js";

/**
 * Git in the sandbox (KOBE-764, spec docs/specs/workspace-git.md G11, G13). Each Pi process gets a
 * git config file of its own, written by the agent next to its egress token file (0600, or 0640
 * under a Pi identity: its tools read it, nobody can write it but the agent) and named in
 * `GIT_CONFIG_GLOBAL`, so the tools' git never reads or writes `~/.gitconfig` (the shared HOME) and
 * never touches the member's repositories' own config. It is rewritten from `run.start.git` before
 * every run, so a member's identity or a new connection reaches the next run without a restart.
 *
 * What it says:
 * - `http.proxyAuthMethod=basic`: the egress token (in `http_proxy`) goes with the first request;
 * - `core.sshCommand` that only prints why and fails: there is no SSH from the sandbox;
 * - `credential.helper` reset to nothing and `core.askPass` empty, with `GIT_TERMINAL_PROMPT=0` in
 *   the environment: git never prompts for, stores or reads a credential (there is none in the
 *   sandbox, and the egress proxy never passes a host's `WWW-Authenticate` through, KOBE-763);
 * - `url.<http://host/org/>.insteadOf` for each connected organization: `https://host/org/...`
 *   (and the SSH spellings on hosts without a sub-path) become plain-HTTP URLs, which git sends to
 *   the egress proxy through `http_proxy` (set per command from the rotating egress token by the
 *   BASH_ENV script, KOBE-39); the proxy adds the Workspace's credential upstream over verified
 *   HTTPS. No `http.extraHeader`, no proxy URL (it holds the token) and no secret in the file;
 * - the member as author and "<name> via Kobe" as committer (G13), and `user.useConfigOnly` so git
 *   never invents an address from the host name when there is no identity.
 *
 * `safe.directory` for `/workspace` is the image's system config (images/sandbox/Dockerfile).
 */
export const GIT_CONFIG_FILE_NAME = "gitconfig";

/** A temp file of the config writer (`gitconfig.<hex>.tmp`). */
export function isGitConfigTemp(name: string): boolean {
  return isTempOf(GIT_CONFIG_FILE_NAME, name);
}

/** The variables Pi's tools get for git; no secret among them. */
export function gitEnv(configFile: string): Record<string, string> {
  return { GIT_CONFIG_GLOBAL: configFile, GIT_TERMINAL_PROMPT: "0" };
}

export interface RemoteRewrite {
  /** The plain-HTTP prefix the egress proxy recognises (`http://host[/base]/org/`). */
  readonly to: string;
  /** The remote prefixes git replaces with it. */
  readonly from: readonly string[];
}

const BASE_URL = /^https:\/\/([a-z0-9.-]+)((?:\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)*)$/;
const ORGANIZATION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * One rewrite per connected organization, in the order given, duplicates dropped. Values are
 * checked again here (the wire schema already did): anything else gets no rewrite, so nothing
 * odd is ever written into the config file.
 */
export function remoteRewrites(remotes: readonly RunGitRemote[]): RemoteRewrite[] {
  const out: RemoteRewrite[] = [];
  const seen = new Set<string>();
  for (const remote of remotes) {
    const m = BASE_URL.exec(remote.base_url);
    if (!m || !ORGANIZATION.test(remote.organization)) continue;
    const host = m[1] as string;
    const basePath = m[2] ?? "";
    const tail = `${host}${basePath}/${remote.organization}/`;
    if (seen.has(tail)) continue;
    seen.add(tail);
    // SSH spellings only where the host serves repositories at its root (no sub-path install).
    const ssh = basePath === "" ? [`git@${host}:${remote.organization}/`, `ssh://git@${tail}`] : [];
    out.push({ to: `http://${tail}`, from: [`https://${tail}`, ...ssh] });
  }
  return out;
}

/** What `core.sshCommand` runs: a message on stderr, then failure (git appends its arguments). */
export const SSH_REFUSAL =
  "echo 'kobe: SSH is not available in the sandbox; use the https:// URL of a repository in a connected organization' >&2; false";

/** A config value in double quotes (the schema and `validIdentity` keep `"`, `\` and controls out). */
const quoted = (value: string): string => `"${value}"`;

function validIdentity(identity: GitIdentity | undefined): GitIdentity | undefined {
  if (identity === undefined) return undefined;
  const parsed = gitIdentitySchema.safeParse(identity);
  return parsed.success ? parsed.data : undefined;
}

/** The config file's text for a run's git context (or git's safe defaults without one). */
export function gitConfigText(context: RunGitContext | undefined): string {
  const author = validIdentity(context?.author);
  const committer = author === undefined ? undefined : validIdentity(context?.committer);
  const lines = [
    "# Written by kobe-sandbox-agent before every run (KOBE-764). Read-only for tools.",
    "# No credential is in the sandbox: connected organizations go through the egress proxy.",
    "[credential]",
    "\thelper =",
    "[core]",
    "\taskPass =",
    // No SSH in the sandbox: an ssh remote git did not rewrite fails at once, with the reason.
    `\tsshCommand = ${quoted(SSH_REFUSAL)}`,
    // The egress token goes with the first request (as curl and pip send it), not after a 407.
    "[http]",
    "\tproxyAuthMethod = basic",
    "[user]",
    ...(author === undefined
      ? []
      : [`\tname = ${quoted(author.name)}`, `\temail = ${quoted(author.email)}`]),
    "\tuseConfigOnly = true",
  ];
  if (author !== undefined && committer !== undefined) {
    lines.push(
      "[author]",
      `\tname = ${quoted(author.name)}`,
      `\temail = ${quoted(author.email)}`,
      "[committer]",
      `\tname = ${quoted(committer.name)}`,
      `\temail = ${quoted(committer.email)}`,
    );
  }
  for (const rewrite of remoteRewrites(context?.remotes ?? [])) {
    lines.push(`[url ${quoted(rewrite.to)}]`);
    for (const from of rewrite.from) lines.push(`\tinsteadOf = ${quoted(from)}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * One Pi process's git config file: written atomically, serialised, verified by the tripwire.
 * `mode` 0600 when the tools run as the agent's uid; 0640 under a Pi identity (the setgid
 * directory gives the file the tools' group, so they read it and cannot change it).
 */
export class GitConfigFile {
  readonly path: string;
  readonly #mode: number;
  #written: string | undefined;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(path: string, mode = 0o600) {
    this.path = path;
    this.#mode = mode;
  }

  write(text: string): Promise<void> {
    const next = this.#chain.then(async () => {
      if (this.#written === text && (await this.#onDisk()) === text) return;
      await writeFileAtomic(this.path, text, this.#mode);
      this.#written = text;
    });
    this.#chain = next.catch(() => undefined);
    return next;
  }

  /** True when the file is a regular file with this writer's mode holding what it last wrote. */
  verify(): Promise<boolean> {
    const result = this.#chain.then(async () => {
      const written = this.#written;
      if (written === undefined) return false;
      try {
        const info = await lstat(this.path);
        if (!info.isFile() || (info.mode & 0o777) !== this.#mode) return false;
      } catch {
        return false;
      }
      return (await this.#onDisk()) === written;
    });
    this.#chain = result.catch(() => undefined);
    return result;
  }

  #onDisk(): Promise<string> {
    return readFile(this.path, "utf8").catch(() => "");
  }
}
