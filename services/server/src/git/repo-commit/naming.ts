import { assertBranch } from "../../git-hosts/adapter.js";
import { conversationLink, markdownName } from "../../git-tools/posted.js";
import { gitNoReplySlug } from "../sandbox-git.js";

/**
 * Names and text of a commit to a Repo (KOBE-767, G13, G18): the branch Kaiju pushes a pull
 * request's commits to, and the pull request's title and body. Built by the server only.
 */

const TITLE_MAX = 256;
const BODY_MAX = 20_000;
const MESSAGE_SLUG_MAX = 40;

/** Lowercase `[a-z0-9-]` from a commit message's first line, at most 40 characters. */
export function messageSlug(message: string): string {
  const first = message.split("\n", 1)[0] ?? "";
  const slug = first
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MESSAGE_SLUG_MAX)
    .replace(/-+$/, "");
  return slug === "" ? "changes" : slug;
}

/**
 * `kobe/<member>/<message>-<7 hex of the commit>`: readable on the host, one branch per pull
 * request, never a name the member or the model chose verbatim.
 */
export function pullRequestBranch(memberName: string, message: string, commitSha: string): string {
  return assertBranch(
    `kobe/${gitNoReplySlug(memberName)}/${messageSlug(message)}-${commitSha.slice(0, 7)}`,
  );
}

/** The pull request's title: the message's first line, at most 256 characters. */
export function pullRequestTitle(message: string): string {
  const first = (message.split("\n", 1)[0] ?? "").trim();
  return (first === "" ? "Changes from Kaiju" : first).slice(0, TITLE_MAX);
}

/**
 * The pull request's body: the rest of the message, then a last line naming the member (and, for
 * an agent's commit, the conversation), as the git host tools do (G13).
 */
export function pullRequestBody(input: {
  readonly message: string;
  readonly memberName: string;
  readonly publicUrl: string;
  readonly threadId?: string | undefined;
}): string {
  const rest = input.message.split("\n").slice(1).join("\n").trim();
  const via =
    input.threadId === undefined
      ? `Committed by ${markdownName(input.memberName)} with Kaiju's commit dialog`
      : `Committed by ${markdownName(input.memberName)} via Kaiju, from conversation ${conversationLink(input.publicUrl, input.threadId)}`;
  // The message is cut, never the last line.
  const kept = rest.slice(0, Math.max(0, BODY_MAX - via.length - 6));
  return kept === "" ? via : `${kept}\n\n---\n${via}`;
}
