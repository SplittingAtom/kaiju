import * as fs from "node:fs";
import git, { Errors, type HttpClient } from "isomorphic-git";
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

/** Pushes commits `from`.. in batches; `onPushed(n)` after the host took the first `n`. */
export async function pushHistory(input: {
  readonly gitdir: string;
  readonly http: () => Promise<HttpClient>;
  readonly url: string;
  readonly branch: string;
  readonly built: BuiltHistory;
  readonly from: number;
  readonly batchBytes: number;
  readonly onPushed: (pushed: number) => Promise<void>;
}): Promise<void> {
  const ref = `refs/heads/${input.branch}`;
  let from = input.from;
  while (from < input.built.commits.length) {
    const end = batchEnd(input.built.newBytes, from, input.batchBytes);
    const oid = input.built.commits[end - 1] as string;
    await git.writeRef({ fs, gitdir: input.gitdir, ref, value: oid, force: true });
    let result: Awaited<ReturnType<typeof git.push>>;
    try {
      result = await git.push({
        fs,
        http: await input.http(),
        gitdir: input.gitdir,
        url: input.url,
        ref,
        remoteRef: ref,
        force: false,
      });
    } catch (err) {
      throw pushFailure(err);
    }
    const status = result.refs?.[ref];
    if (!result.ok || (status && !status.ok)) throw new ConversionStepError("push_rejected");
    from = end;
    await input.onPushed(end);
  }
}

/** A transport or host failure as a step failure (never the host's text). */
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
  if (err instanceof Errors.GitPushError || err instanceof Errors.UnknownTransportError) {
    return new ConversionStepError("push_rejected");
  }
  return err;
}
