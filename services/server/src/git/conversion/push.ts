import { rm } from "node:fs/promises";
import git, { Errors, type HttpClient } from "isomorphic-git";
import type { GitWireSession } from "../../git-hosts/git-wire.js";
import { parseReportStatus, writeReceivePack } from "./pack.js";
import { GitHostError } from "../../git-hosts/adapter.js";
import { ConversionStepError, type BuiltHistory } from "./objects.js";

/**
 * Pushing a conversion's history (KOBE-765, G16) with isomorphic-git over the guarded smart-HTTP
 * client (`git-hosts/git-wire.ts`). Commits go oldest first in batches of about
 * `batchBytes` of new content, each push a fast-forward of the default branch (never forced), so
 * at most one batch's pack is in memory and an interrupted push resumes after the last batch the
 * host took: the host's branch head must then be one of the plan's commits (they are
 * deterministic), otherwise someone else wrote there and the attempt stops (`repository_changed`).
 */
export interface RemoteState {
  /** The default branch's head on the host, or null when it has no such branch. */
  readonly head: string | null;
  /** How many refs the host has (0: an empty repository). */
  readonly refs: number;
}

export async function readRemote(
  http: HttpClient,
  url: string,
  branch: string,
): Promise<RemoteState> {
  const info = await git.getRemoteInfo2({ http, url, forPush: true, protocolVersion: 1 });
  const refs = ((info.refs ?? []) as { ref: string; oid: string }[]).filter((r) =>
    r.ref.startsWith("refs/"),
  );
  return {
    head: refs.find((r) => r.ref === `refs/heads/${branch}`)?.oid ?? null,
    refs: refs.length,
  };
}

/** Where to continue: the index of the first commit the host does not have yet. */
export function resumeIndex(built: BuiltHistory, remote: RemoteState): number {
  if (remote.head === null) {
    if (remote.refs > 0) throw new ConversionStepError("repository_not_empty");
    return 0;
  }
  const at = built.commits.indexOf(remote.head);
  if (at < 0) throw new ConversionStepError("repository_changed");
  return at + 1;
}

/** The end (exclusive) of the batch starting at `from`: at least one commit. */
export function batchEnd(newBytes: readonly number[], from: number, batchBytes: number): number {
  let total = 0;
  let end = from;
  while (end < newBytes.length) {
    const next = newBytes[end] ?? 0;
    if (end > from && total + next > batchBytes) break;
    total += next;
    end += 1;
  }
  return end;
}

/** Status codes of a receive-pack POST, as step failures. */
function postFailure(status: number): ConversionStepError {
  if (status === 401) return new ConversionStepError("credential_rejected");
  if (status === 403) return new ConversionStepError("credential_forbidden");
  if (status === 404) return new ConversionStepError("repository_gone");
  if (status === 429) return new ConversionStepError("host_rate_limited");
  if (status === 413) return new ConversionStepError("push_rejected", "the host refused the size");
  return new ConversionStepError("host_unreachable");
}

/**
 * Pushes commits `from`.. in batches of about `batchBytes` of new content, oldest first (a commit
 * larger than that goes as its own batch). Each batch is one receive-pack request written to
 * `packFile` and streamed from it (`pack.ts`), updating the branch from the previous batch's
 * commit to this one's: a fast-forward, compare-and-swap on the host, never forced. Memory holds
 * one object at a time whatever the commit's size. `onPushed(n)` after the host took the first `n`.
 */
export async function pushHistory(input: {
  readonly gitdir: string;
  readonly session: () => Promise<GitWireSession>;
  readonly url: string;
  readonly branch: string;
  readonly built: BuiltHistory;
  readonly from: number;
  readonly batchBytes: number;
  readonly packFile: string;
  readonly onPushed: (pushed: number) => Promise<void>;
}): Promise<void> {
  const ref = `refs/heads/${input.branch}`;
  let from = input.from;
  let old = from === 0 ? null : (input.built.commits[from - 1] ?? null);
  try {
    while (from < input.built.commits.length) {
      const end = batchEnd(input.built.newBytes, from, input.batchBytes);
      const oid = input.built.commits[end - 1] as string;
      const size = await writeReceivePack({
        gitdir: input.gitdir,
        ref,
        oldOid: old,
        newOid: oid,
        objects: input.built.introduced.slice(from, end).flat(),
        file: input.packFile,
      });
      const session = await input.session();
      let answer: { status: number; body: Buffer };
      try {
        answer = await session.postFile(
          `${input.url}/git-receive-pack`,
          input.packFile,
          size,
          "application/x-git-receive-pack-request",
        );
      } catch (err) {
        throw pushFailure(err);
      }
      if (answer.status !== 200) throw postFailure(answer.status);
      const report = parseReportStatus(answer.body, ref);
      if (!report.ok) {
        if (report.stale)
          throw new ConversionStepError("repository_changed", hostReason(report.reason));
        throw new ConversionStepError("push_rejected", hostReason(report.reason));
      }
      old = oid;
      from = end;
      await input.onPushed(end);
    }
  } finally {
    await rm(input.packFile, { force: true });
  }
}

/**
 * The host's short reason for a refused push (receive-pack's `unpack`/`ng` status, e.g.
 * "pre-receive hook declined" or an fsck message), kept as one printable line of at most 200
 * characters so the requester sees why (review M1). It never carries Kobe's credential: the host
 * answers about the pack, and the credential travels only in a request header.
 */
export function hostReason(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const line = Array.from(raw)
    .map((c) => {
      const code = c.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f ? " " : c;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return line === "" ? null : line.slice(0, 200);
}

/** A transport or host failure as a step failure (the host's text only as a short reason). */
export function pushFailure(err: unknown): unknown {
  if (err instanceof ConversionStepError) return err;
  if (err instanceof GitHostError) return err;
  if (err instanceof Errors.PushRejectedError) return new ConversionStepError("repository_changed");
  if (err instanceof Errors.HttpError) {
    const status = (err.data as { statusCode?: number } | undefined)?.statusCode ?? 0;
    if (status === 401) return new ConversionStepError("credential_rejected");
    if (status === 403) return new ConversionStepError("credential_forbidden");
    if (status === 404) return new ConversionStepError("repository_gone");
    if (status === 429) return new ConversionStepError("host_rate_limited");
    if (status === 413) return new ConversionStepError("push_rejected");
    return new ConversionStepError("host_unreachable");
  }
  if (err instanceof Errors.GitPushError) {
    const result = (err.data as { result?: { error?: unknown } } | undefined)?.result;
    return new ConversionStepError("push_rejected", hostReason(result?.error ?? err.message));
  }
  if (err instanceof Errors.UnknownTransportError) return new ConversionStepError("push_rejected");
  return err;
}
