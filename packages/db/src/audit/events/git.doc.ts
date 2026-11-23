import type { AuditEventDoc } from "./fragments.js";
import type { GIT_EVENTS } from "./git.js";

/**
 * The docs/audit-log.md rows of the Workspace git area's events (KOBE-760), in name order; the
 * table is generated from these (`pnpm --filter @kobe/db audit:doc`). Add an event's row here in
 * name order.
 */
export const GIT_EVENT_DOCS = {
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
  "git.project.conversion_abandoned": {
    fields: "`conversionId`, `projectId`, `leftOnHost`, `repositoryId?`",
    when: "The project's owner or a Workspace admin abandoned a failed Convert to repo; the project stays an ordinary project and a repository created for it stays on the host (`leftOnHost`), listed in the Git section (KOBE-765)",
  },
  "git.project.conversion_failed": {
    fields:
      "`conversionId`, `projectId`, `step` (`create`, `push`, `finish`), `failure`, `attempts`, `repositoryCreated`",
    when: "A Convert to repo step failed (system); the project stays an ordinary project until it is retried or abandoned. Codes only, never the host's answer",
  },
  "git.project.conversion_requested": {
    fields:
      "`conversionId`, `projectId`, `connectionId`, `provider`, `host`, `organization`, `visibility`, `carryHistory`, `useExisting`",
    when: "The project's owner or a Workspace admin started converting a project to a Repo (KOBE-765). Never the project's or repository's name",
  },
  "git.project.conversion_retried": {
    fields: "`conversionId`, `projectId`, `step`",
    when: "The project's owner or a Workspace admin retried a failed Convert to repo; it resumes at `step`",
  },
  "git.project.converted": {
    fields:
      "`conversionId`, `projectId`, `connectionId?`, `repositoryId`, `hostRepoId`, `commits`, `headSha`, `attempts`",
    when: "Convert to repo finished (system, on behalf of the requester): the project's commits are on the host's default branch and the project is now a Repo linked to the repository record",
  },
  "git.settings.updated": {
    fields: "`setting` (`commit_email`), `value`, `previous` (`member` or `noreply`)",
    when: "A Workspace admin changed the Workspace's git settings: the author email of commits made in sandboxes, the member's Kobe email or the no-reply form (KOBE-761)",
  },
} satisfies Record<keyof typeof GIT_EVENTS, AuditEventDoc>;
