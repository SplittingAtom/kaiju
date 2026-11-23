import { z } from "zod";
import {
  GIT_ACCESS_LEVEL_VALUES,
  GIT_CONVERSION_STEP_VALUES,
  GIT_CREDENTIAL_KIND_VALUES,
  GIT_ORGANIZATION_MAX,
  GIT_ORGANIZATION_PATTERN,
  GIT_PROVIDER_VALUES,
  GIT_REPO_VISIBILITY_VALUES,
} from "../../git/types.js";
import { count, event, id, reasonCode, type AuditEventDef } from "./fragments.js";

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

/** A repository's id on its host (G20), as `git_repositories.host_repo_id` stores it. */
const hostRepoId = z.string().regex(/^[A-Za-z0-9_=-]{1,64}$/);
const gitSha = z.string().regex(/^([0-9a-f]{40}|[0-9a-f]{64})$/);
const conversionRef = { conversionId: id, projectId: id };

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
  "git.settings.updated": event("team", {
    setting: z.literal("commit_email"),
    value: commitEmail,
    previous: commitEmail,
  }),

  // ── Convert to repo (KOBE-765, spec workspace-git G16): ids, counts and codes; never the
  // project's name, paths, commit messages or the repository's name ──
  /** The project's owner or a Workspace admin started converting the project to a Repo. */
  "git.project.conversion_requested": event("team", {
    ...conversionRef,
    connectionId: id,
    provider,
    host: gitHost,
    organization,
    visibility: z.enum(GIT_REPO_VISIBILITY_VALUES),
    carryHistory: z.boolean(),
    useExisting: z.boolean(),
  }),
  /**
   * The history is on the host and the project is now a Repo, linked to `repositoryId` (system:
   * the job finished it; `actor` stays the person who asked).
   */
  "git.project.converted": event("team", {
    ...conversionRef,
    connectionId: id.optional(),
    repositoryId: id,
    hostRepoId,
    commits: count,
    headSha: gitSha,
    attempts: count,
  }),
  /** A step failed; the project stays an ordinary project until a retry or an abandon. */
  "git.project.conversion_failed": event("team", {
    ...conversionRef,
    step: z.enum(GIT_CONVERSION_STEP_VALUES),
    failure: reasonCode,
    attempts: count,
    repositoryCreated: z.boolean(),
  }),
  /** The project's owner or a Workspace admin retried a failed conversion (it resumes at `step`). */
  "git.project.conversion_retried": event("team", {
    ...conversionRef,
    step: z.enum(GIT_CONVERSION_STEP_VALUES),
  }),
  /**
   * The project's owner or a Workspace admin gave up on a failed conversion. A repository the
   * host created for it stays there (`leftOnHost`, its record `repositoryId`); Kobe deletes
   * nothing on a git host (§9).
   */
  "git.project.conversion_abandoned": event("team", {
    ...conversionRef,
    leftOnHost: z.boolean(),
    repositoryId: id.optional(),
  }),
} as const satisfies Record<string, AuditEventDef>;
