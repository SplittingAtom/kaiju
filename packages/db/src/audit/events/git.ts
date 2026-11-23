import { z } from "zod";
import {
  GIT_ACCESS_LEVEL_VALUES,
  GIT_CREDENTIAL_KIND_VALUES,
  GIT_ORGANIZATION_MAX,
  GIT_ORGANIZATION_PATTERN,
  GIT_PROVIDER_VALUES,
} from "../../git/types.js";
import { count, event, id, reasonCode, type AuditEventDef } from "./fragments.js";
import { GIT_REPOSITORY_NAME_MAX, GIT_REPOSITORY_NAME_PATTERN } from "../../git/types.js";

/** The connection's host name (`parseGitBaseUrl().host`): lowercase, no scheme, port or path. */
const gitHost = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9.-]+$/);
const organization = z
  .string()
  .min(1)
  .max(GIT_ORGANIZATION_MAX)
  .regex(new RegExp(GIT_ORGANIZATION_PATTERN));
const provider = z.enum(GIT_PROVIDER_VALUES);
const credentialKind = z.enum(GIT_CREDENTIAL_KIND_VALUES);
const accessLevel = z.enum(GIT_ACCESS_LEVEL_VALUES);
/** A permission name a host reported beyond the connection's needs (G4), never host prose. */
const permissionName = z.string().regex(/^[A-Za-z0-9_.:=-]{1,100}$/);
/** The settings a Workspace admin can change on a connection (G1 defaults, G11, GQ8, GQ11). */
const settingField = z.enum([
  "display_name",
  "access_level",
  "repo_visibility",
  "repo_name_prefix",
  "default_branch",
  "push_limit_bytes",
  "direct_commits",
  "agent_ids",
]);

/**
 * What every git host tool write records (KOBE-762, spec workspace-git §8): the connection, the
 * agent of the named run (absent for a run without an agent), host and organization, the
 * repository, the host's ids and number, the host's web link (same origin as the connection, as
 * the adapters guarantee), and `callDigest`, the call's idempotency key. The member is the actor; run, thread
 * and tool call are in `viaAgent`. Never a title, body, branch name or credential.
 */
const repository = z
  .string()
  .min(1)
  .max(GIT_REPOSITORY_NAME_MAX)
  .regex(new RegExp(GIT_REPOSITORY_NAME_PATTERN));
const hostId = z.string().regex(/^[A-Za-z0-9_=-]{1,64}$/);
const webUrl = z.url({ protocol: /^https$/ }).max(2048);
const toolWrite = {
  connectionId: id,
  agentId: id.optional(),
  host: gitHost,
  organization,
  repository,
  hostRepoId: hostId,
  callDigest: z.string().regex(/^[0-9a-f]{32}$/),
};

/** The commit author email choice (`teams.settings.git_commit_email`, KOBE-764). */
const commitEmail = z.enum(["member", "noreply"]);

export const GIT_EVENTS = {
  // ── Workspace git connections (KOBE-760, spec workspace-git §3, §4, §8): ids, names and codes;
  // never a credential, its hint, a host's message or a URL query ──
  /** A Workspace admin connected an organization on a git host after a passing test (G4). */
  "git.connection.created": event("team", {
    connectionId: id,
    provider,
    host: gitHost,
    organization,
    credentialKind,
    accessLevel,
    excessPermissions: z.array(permissionName).max(50),
  }),
  /** A Workspace admin changed a connection's settings (`fields`; the access level's step). */
  "git.connection.updated": event("team", {
    connectionId: id,
    fields: z.array(settingField).min(1).max(8),
    accessLevel: accessLevel.optional(),
    previousAccessLevel: accessLevel.optional(),
  }),
  /** A Workspace admin replaced the credential after a passing test (G8); the old one is gone. */
  "git.connection.credential_replaced": event("team", {
    connectionId: id,
    credentialKind,
    previousCredentialKind: credentialKind,
  }),
  /**
   * A Workspace admin disconnected; the credential was deleted. Nothing on the host changed;
   * `repositories`: the Workspace's repository records kept, now without a connection (G20).
   */
  "git.connection.removed": event("team", {
    connectionId: id,
    provider,
    host: gitHost,
    organization,
    repositories: count,
  }),
  /**
   * A connection test failed (G4): a test without saving, a create or credential replacement
   * that was refused, or an admin's Check now. `failure` is the adapter's error code (or
   * `credential_insufficient`), `reason` its finer reason where it has one; never the host's answer.
   */
  "git.connection.test_failed": event("team", {
    connectionId: id.optional(),
    stage: z.enum(["test", "create", "replace", "check"]),
    provider,
    host: gitHost,
    organization,
    failure: reasonCode,
    reason: reasonCode.optional(),
  }),
  /** The token lapses within 14 days (G6): the Workspace admins were emailed (system). */
  "git.connection.expiry_notified": event("team", {
    connectionId: id,
    expiresAt: z.iso.datetime({ offset: true }),
    notified: count,
  }),
  /**
   * A Workspace admin changed the Workspace's git settings (KOBE-761): today the commit author
   * email of sandbox commits (G13, GQ10), member's Kobe email or the no-reply form.
   */
  // ── Git host tool writes (KOBE-762, spec workspace-git G9, §8) ──
  /** An agent created a branch in a repository of the connected organization (`git_create_branch`). */
  "git.branch.created": event("team", toolWrite),
  /** An agent commented on an issue or pull request (`git_comment`). */
  "git.comment.created": event("team", {
    ...toolWrite,
    on: z.enum(["issue", "pull_request"]),
    number: z.number().int().positive(),
    hostId,
    url: webUrl.optional(),
  }),
  /** An agent created an issue (`git_create_issue`). */
  "git.issue.created": event("team", {
    ...toolWrite,
    number: z.number().int().positive().optional(),
    hostId,
    url: webUrl.optional(),
  }),
  /** An agent opened a pull request (`git_open_pull_request`). */
  "git.pull_request.opened": event("team", {
    ...toolWrite,
    number: z.number().int().positive().optional(),
    hostId,
    url: webUrl.optional(),
  }),
  /** An agent created a repository (`git_create_repository`; G10: private or internal only). */
  "git.repository.created": event("team", {
    ...toolWrite,
    hostId,
    visibility: z.enum(["private", "internal"]),
    url: webUrl.optional(),
  }),
  "git.settings.updated": event("team", {
    setting: z.literal("commit_email"),
    value: commitEmail,
    previous: commitEmail,
  }),
} as const satisfies Record<string, AuditEventDef>;
