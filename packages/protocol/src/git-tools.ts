import { z } from "zod";

/**
 * The approval card of a git host write (KOBE-762, spec workspace-git G9, G10, G13): built by the
 * server from the approved input and the Workspace's connection, never from anything else the
 * model said. It names the host, organization and repository and shows exactly what will be
 * created or posted: titles and bodies as plain text (the body with the line Kaiju adds naming the
 * member and the conversation), the branches of a pull request, and a new repository's
 * visibility. Clients render every string as text, never as HTML or Markdown. Additive: clients
 * that predate it show the ordinary card with the raw input.
 */
export const GIT_APPROVAL_ACTIONS = [
  "create_repository",
  "create_branch",
  "open_pull_request",
  "comment",
  "create_issue",
] as const;
export type GitApprovalAction = (typeof GIT_APPROVAL_ACTIONS)[number];

/** Longest posted text a card carries (the tools' body cap plus Kaiju's footer line). */
export const GIT_APPROVAL_TEXT_MAX = 21_000;

export const gitApprovalSchema = z.strictObject({
  action: z.enum(GIT_APPROVAL_ACTIONS),
  provider: z.enum(["github", "gitea", "forgejo"]),
  /** The connection's host (`github.com`, `git.example.com:8443`). */
  host: z.string().min(1).max(300),
  organization: z.string().min(1).max(100),
  connection_name: z.string().min(1).max(100),
  repository: z.string().min(1).max(100),
  /** A new repository's visibility (never public). */
  visibility: z.enum(["private", "internal"]).optional(),
  description: z.string().max(400).optional(),
  title: z.string().max(300).optional(),
  /** The full text that will be posted, Kaiju's footer included. */
  body: z.string().max(GIT_APPROVAL_TEXT_MAX).optional(),
  head: z.string().max(300).optional(),
  base: z.string().max(300).optional(),
  draft: z.boolean().optional(),
  /** A new branch and where it starts. */
  branch: z.string().max(300).optional(),
  from: z.string().max(300).optional(),
  /** The issue or pull request a comment goes on. */
  number: z.number().int().positive().optional(),
  on: z.enum(["issue", "pull_request"]).optional(),
});
export type GitApproval = z.infer<typeof gitApprovalSchema>;

/**
 * The built-in git connector (KOBE-762, owner decision 2026-11-22): the git host tools as their own
 * connector, apart from the Kaiju MCP connector, with a fixed id the same on every site (`@kobe/db`
 * `GIT_BUILTIN_CONNECTOR_ID`). The MCP proxy routes `POST /v1/mcp/<this id>` to the server's
 * internal listener (`/internal/v1/mcp/git/*`).
 */
export const GIT_BUILTIN_CONNECTOR_ID = "6b6f6265-0000-4000-8000-000000000002";
