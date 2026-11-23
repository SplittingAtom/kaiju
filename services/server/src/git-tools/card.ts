import { parseMcpToolName, type GitApproval, type GitApprovalAction } from "@kobe/protocol";
import { readGitConnection, sql, type KobeTx } from "@kobe/db";
import { gitToolByName, type GitToolInput } from "./catalog.js";
import { footerLine, memberName, postedBody } from "./posted.js";

/**
 * The approval card of a git host write (KOBE-762, spec workspace-git G9): what will happen, on
 * which host, organization and repository, built in the approval's own team transaction from the
 * approved input and the connection it names; the text to be posted is built exactly as the
 * executor builds it (footer included). Undefined for anything else (a read, an unknown tool, an
 * input the schema refuses, a connection that is not this Workspace's): the ordinary card with the
 * raw input is shown, and the call is refused anyway.
 */

const ACTIONS: Readonly<Record<string, GitApprovalAction>> = {
  git_create_repository: "create_repository",
  git_create_branch: "create_branch",
  git_open_pull_request: "open_pull_request",
  git_comment: "comment",
  git_create_issue: "create_issue",
};

export interface GitCardContext {
  readonly teamId: string;
  readonly userId: string;
  readonly threadId: string;
  /** The deployment's public origin, for the conversation link in the footer (G13). */
  readonly publicUrl: string;
}

export async function gitApprovalCard(
  tx: KobeTx,
  ctx: GitCardContext,
  piName: string,
  input: Readonly<Record<string, unknown>>,
): Promise<GitApproval | undefined> {
  const name = parseMcpToolName(piName)?.tool_segment;
  const tool = name === undefined ? undefined : gitToolByName(name);
  const action = name === undefined ? undefined : ACTIONS[name];
  if (tool === undefined || action === undefined) return undefined;
  const parsed = tool.input.safeParse(input);
  if (!parsed.success) return undefined;
  const i = parsed.data as GitToolInput;
  if (i.connection === undefined) return undefined;
  const connection = await readGitConnection(tx, ctx.teamId, i.connection.toLowerCase());
  if (connection === undefined) return undefined;
  const base = {
    action,
    provider: connection.provider,
    host: new URL(connection.baseUrl).host,
    organization: connection.organization,
    connection_name: connection.displayName,
  } as const;
  const body = async (kind: "opened" | "posted") =>
    postedBody(
      i.body ?? "",
      footerLine(kind, await memberName(tx, ctx.userId), ctx.publicUrl, ctx.threadId),
    );
  switch (action) {
    case "create_repository":
      return {
        ...base,
        repository: i.name ?? "",
        visibility: i.visibility ?? "private",
        ...(i.description === undefined ? {} : { description: i.description }),
      };
    case "create_branch":
      return { ...base, repository: i.repository ?? "", branch: i.name ?? "", from: i.from ?? "" };
    case "open_pull_request":
      return {
        ...base,
        repository: i.repository ?? "",
        title: i.title ?? "",
        body: await body("opened"),
        head: i.head ?? "",
        base: i.base ?? "",
        draft: i.draft === true,
      };
    case "comment":
      return {
        ...base,
        repository: i.repository ?? "",
        number: i.number ?? 1,
        on: i.on ?? "issue",
        body: await body("posted"),
      };
    case "create_issue":
      return {
        ...base,
        repository: i.repository ?? "",
        title: i.title ?? "",
        body: await body("opened"),
      };
  }
}

/**
 * The card for an approval request of the built-in git connector's tool `piName`, or undefined
 * (any other tool, including a connector that merely uses a git tool's name: the Pi name's server
 * segment must be the built-in git connector's).
 */
export async function kobeGitApprovalCard(
  tx: KobeTx,
  req: GitCardContext & {
    readonly piName: string;
    readonly input: Readonly<Record<string, unknown>>;
  },
): Promise<GitApproval | undefined> {
  const parsed = parseMcpToolName(req.piName);
  if (parsed === undefined || ACTIONS[parsed.tool_segment] === undefined) return undefined;
  const res = await tx.execute<{ name: string }>(
    sql`SELECT name FROM public.connectors WHERE builtin = 'git'`,
  );
  const builtin = res.rows[0]?.name;
  if (builtin === undefined || builtin.replace(/[^A-Za-z0-9_]/g, "_") !== parsed.server_segment) {
    return undefined;
  }
  return gitApprovalCard(tx, req, req.piName, req.input);
}
