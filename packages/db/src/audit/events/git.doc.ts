import type { AuditEventDoc } from "./fragments.js";
import type { GIT_EVENTS } from "./git.js";

/**
 * The docs/audit-log.md rows of the Workspace git area's events (KOBE-760), in name order; the
 * table is generated from these (`pnpm --filter @kobe/db audit:doc`). Add an event's row here in
 * name order.
 */
export const GIT_EVENT_DOCS = {
  "git.branch.created": {
    fields:
      "`connectionId`, `agentId?`, `host`, `organization`, `repository`, `hostRepoId`, `callDigest`",
    when: "An agent created a branch with the git host tool `git_create_branch` (KOBE-762); the member is the actor, run and tool call in `viaAgent`. Never the branch name",
  },
  "git.comment.created": {
    fields:
      "`connectionId`, `agentId?`, `host`, `organization`, `repository`, `hostRepoId`, `callDigest`, `on`, `number`, `hostId`, `url?`",
    when: "An agent commented on an issue or pull request with `git_comment` (KOBE-762). Never the comment text",
  },
  "git.connection.created": {
    fields:
      "`connectionId`, `provider`, `host`, `organization`, `credentialKind`, `accessLevel`, `excessPermissions`",
    when: "A Workspace admin connected an organization on a git host after the credential passed its test (KOBE-760). Never records the credential or its hint",
  },
  "git.connection.credential_replaced": {
    fields: "`connectionId`, `credentialKind`, `previousCredentialKind`",
    when: "A Workspace admin replaced a git connection's credential after the new one passed its test; the old one is deleted. Never records either",
  },
  "git.connection.expiry_notified": {
    fields: "`connectionId`, `expiresAt`, `notified`",
    when: "A git connection's access token lapses within 14 days: its Workspace admins were emailed once for that credential (system)",
  },
  "git.connection.removed": {
    fields: "`connectionId`, `provider`, `host`, `organization`, `repositories`",
    when: "A Workspace admin disconnected a git organization; the credential was deleted, nothing on the host changed, `repositories` repository records were kept without a connection",
  },
  "git.connection.test_failed": {
    fields:
      "`connectionId?`, `stage` (`test`, `create`, `replace`, `check`), `provider`, `host`, `organization`, `failure`, `reason?`",
    when: "A git connection test failed: a test without saving, a refused create or credential replacement, or a Check now. Codes only, never the host's answer",
  },
  "git.connection.updated": {
    fields: "`connectionId`, `fields`, `accessLevel?`, `previousAccessLevel?`",
    when: "A Workspace admin changed a git connection's settings (access level, repository defaults, push limit, direct commits, agents, display name)",
  },
  "git.issue.created": {
    fields:
      "`connectionId`, `agentId?`, `host`, `organization`, `repository`, `hostRepoId`, `callDigest`, `number?`, `hostId`, `url?`",
    when: "An agent created an issue with `git_create_issue` (KOBE-762). Never the title or text",
  },
  "git.pull_request.opened": {
    fields:
      "`connectionId`, `agentId?`, `host`, `organization`, `repository`, `hostRepoId`, `callDigest`, `number?`, `hostId`, `url?`",
    when: "An agent opened a pull request with `git_open_pull_request` (KOBE-762). Never the title, text or branch names",
  },
  "git.repository.created": {
    fields:
      "`connectionId`, `agentId?`, `host`, `organization`, `repository`, `hostRepoId`, `callDigest`, `hostId`, `visibility` (`private`, `internal`), `url?`",
    when: "An agent created a repository with `git_create_repository` (KOBE-762); Kobe also records it among the Workspace's repositories",
  },
  "git.settings.updated": {
    fields: "`setting` (`commit_email`), `value`, `previous` (`member` or `noreply`)",
    when: "A Workspace admin changed the Workspace's git settings: the author email of commits made in sandboxes, the member's Kobe email or the no-reply form (KOBE-761)",
  },
} satisfies Record<keyof typeof GIT_EVENTS, AuditEventDoc>;
