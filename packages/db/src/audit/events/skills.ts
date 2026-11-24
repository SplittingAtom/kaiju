import { z } from "zod";
import {
  catalogName,
  count,
  event,
  id,
  modelAlias,
  slug,
  toolCallId,
  version,
  type AuditEventDef,
} from "./fragments.js";

export const SKILLS_EVENTS = {
  // ── skill: uploaded bundles (KOBE-78); team skills in the team view, personal site-only ──
  /** A skill bundle was uploaded as a new immutable version (never the bundle's contents). */
  /**
   * A version was downloaded as an export (KOBE-345, SK30): a portable zip (with or without
   * `evals/`) of a team or personal version, or a catalog version's portable zip or full package;
   * `sha256` names the exact bytes. Team versions in the team view, the rest site-only.
   */
  "skill.exported": event("any", {
    scope: z.enum(["team", "personal", "catalog"]),
    skillId: id,
    /** The catalog version (scope catalog). */
    registryVersionId: id.optional(),
    name: catalogName,
    semver: z.string().max(32),
    format: z.enum(["portable", "portable_evals", "package"]),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  "skill.uploaded": event("any", {
    skillId: id,
    scope: z.enum(["team", "personal"]),
    slug,
    version,
    /** The version's semver (KOBE-308); absent on uploads recorded before. */
    semver: z.string().max(32).optional(),
    bundleHash: z.string().regex(/^[0-9a-f]{64}$/),
    bytes: count,
    files: count,
    source: z.enum(["zip", "skill_md"]),
    /** Scanner findings (KOBE-80); absent on uploads recorded before the scanner ran. */
    findings: count.optional(),
    /** The Workbench draft it was saved from (KOBE-320); absent for uploads. */
    draftId: id.optional(),
  }),
  /** A team admin approved or rejected a team skill version (KOBE-80, D22). */
  "skill.reviewed": event("team", {
    skillId: id,
    slug,
    version,
    decision: z.enum(["approved", "rejected"]),
    previous: z.enum(["pending", "approved", "rejected"]),
    flagged: z.boolean(),
    /** The scan verdict (KOBE-312); absent on decisions recorded before. */
    verdict: z.enum(["pass", "caution", "block"]).optional(),
    /** The reviewer acknowledged the Caution or Block findings when approving (KOBE-312). */
    acknowledged: z.literal(true).optional(),
    /** The digest of exactly the findings acknowledged (KOBE-312 review S7). */
    findingsSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  }),
  /**
   * A Site admin approved a version whose scan is Block (KOBE-312, SK32). The reason is the review
   * note, not recorded here (no free text); its SHA-256 is, so a later decision that rewrites the
   * note can't rewrite the reason this override gave. Counts the blocking findings and names their
   * rule ids (scanner ids, never content).
   */
  "skill.scan.override": event("team", {
    skillId: id,
    slug,
    version,
    bundleHash: z.string().regex(/^[0-9a-f]{64}$/),
    findings: count,
    /** Absent on overrides recorded before the KOBE-312 review. */
    rules: z
      .array(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/))
      .max(16)
      .optional(),
    reasonSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  }),
  /**
   * A rescan on a scanner rule-set change (KOBE-313, SK32) turned a version Block and suspended
   * it pending review: in a team (its review row) or site-wide (a personal version's own scan).
   * `reason: rescan_incomplete`: the rescan kept not finishing past the configured period
   * (KOBE-781 review). Ids, slug and rule set only.
   */
  "skill.rescan.suspended": event("any", {
    skillId: id,
    slug,
    version,
    scope: z.enum(["team", "personal"]),
    ruleSetVersion: z.string().min(1).max(64),
    reason: z.enum(["rescan_incomplete"]).optional(),
  }),
  /** A team admin switched the team's personal skills off or on (KOBE-80, D22). */
  "skill.personal_switch.changed": event("team", { disabled: z.boolean() }),
  /** A team admin turned a team skill's "Offer to all agents" on or off (KOBE-297). */
  "skill.offer.changed": event("team", { skillId: id, slug, offerToAll: z.boolean() }),
  /**
   * A team skill's access mode changed (KOBE-316, SK25): Available, On by default, Required (Team
   * admins only) or Hidden.
   */
  "skill.access.changed": event("team", {
    skillId: id,
    slug,
    access: z.enum(["available", "default_on", "required", "hidden"]),
    previous: z.enum(["available", "default_on", "required", "hidden"]),
  }),
  /**
   * A member turned a skill on or off for themselves in the team (KOBE-316, SK25, SK27): one of
   * their personal skills, a team skill or a catalog install. Names only, never content.
   */
  "skill.enablement.changed": event("team", {
    kind: z.enum(["personal", "team", "catalog"]),
    skillId: id,
    name: slug,
    enabled: z.boolean(),
  }),
  /** A Team admin changed the team's catalog switches (KOBE-316, SK25); only the changed ones. */
  "skill.catalog_switches.changed": event("team", {
    membersMayAddCatalog: z.boolean().optional(),
    buildersMayInstallCatalog: z.boolean().optional(),
    /** "Builders may promote without confirmation" (KOBE-333, SK19). */
    buildersMayPromote: z.boolean().optional(),
  }),
  /**
   * A Team admin chose the team's eval judge (KOBE-326, SK17): one of its enabled models, or null
   * for the team default. Used when the Site's judge is not enabled in the team.
   */
  "skill.eval_judge.changed": event("team", { alias: modelAlias.nullable() }),
  /** A Team admin set or removed the team's monthly eval cap (KOBE-327, SK18). */
  "skill.eval_cap.changed": event("team", {
    cap: z
      .union([
        z.strictObject({ usd: z.number().positive().max(1_000_000) }),
        z.strictObject({ tokens: z.number().int().positive().max(1e12) }),
      ])
      .nullable(),
  }),
  /** A site admin put a bundle hash on the site blocklist (KOBE-81); hash only, no reason. */
  "skill.blocklist.added": event("site", { bundleHash: z.string().regex(/^[0-9a-f]{64}$/) }),
  /** A site admin took a bundle hash off the blocklist (KOBE-81). */
  "skill.blocklist.removed": event("site", { bundleHash: z.string().regex(/^[0-9a-f]{64}$/) }),

  // ── skill: catalog tags and the Default sync (KOBE-314, SK5–SK8); ids, names and counts ──
  // ── promotion to the Site Registry (KOBE-333, SK19): ids, names and counts, never content ──
  /** A Builder asked to promote a team version; it waits for a Team admin (team log). */
  "skill.promotion.requested": event("team", {
    requestId: id,
    skillId: id,
    version,
    semver: z.string().max(32),
  }),
  /** A Team admin confirmed a Builder's request; Kaiju submitted it (team log). */
  "skill.promotion.confirmed": event("team", { requestId: id, registryVersionId: id }),
  /** A Team admin declined a Builder's request (team log). */
  "skill.promotion.declined": event("team", { requestId: id }),
  /**
   * A team or personal version left the team for the Site Registry (team log): what left is
   * counted (payload files, eval fixtures) and whether it started from a conversation.
   */
  "skill.promoted": event("team", {
    skillId: id,
    scope: z.enum(["team", "personal"]),
    version,
    semver: z.string().max(32),
    registryVersionId: id,
    files: count,
    fixtures: count,
    fromConversation: z.boolean(),
    requestId: id.optional(),
  }),
  /**
   * Kaiju drafted a kaiju.skill.yaml for a version without one, with the member's chosen model,
   * into a new Workbench draft of theirs (KOBE-564); `from` says whether the model's reply was
   * used or SKILL.md's description alone. Metadata only: never the manifest's text.
   */
  "skill.manifest.generated": event("team", {
    draftId: id,
    /** The version forked (the Promote panel); absent when written into an open draft. */
    skillId: id.optional(),
    scope: z.enum(["team", "personal"]).optional(),
    version: version.optional(),
    semver: z.string().max(32).optional(),
    /** The catalog alias that answered. */
    model: z.string().max(128),
    from: z.enum(["model", "seed"]),
  }),
  /** A version was submitted to the Site Registry for review (site log). */
  "registry.submitted": event("site", {
    registryVersionId: id,
    skillId: id,
    name: catalogName,
    semver: z.string().max(32),
    newSkill: z.boolean(),
  }),
  // ── the Registry review (KOBE-334, SK23): ids and outcomes; notes stay in the Registry ──
  /** A reviewer claimed a submitted version: it is In review (site log). */
  "registry.claimed": event("site", { registryVersionId: id }),
  /** A reviewer let go of a claim; the version waits in the queue again. */
  "registry.unclaimed": event("site", { registryVersionId: id }),
  /** A reviewer commented on a version under review. */
  "registry.commented": event("site", { registryVersionId: id }),
  /**
   * A reviewer approved a version into the Catalog, with its scan verdict. `selfApproved`: the single admin approved
   * their own submission (SK22); `confirmerApproved`: the single admin approved a promotion they
   * confirmed as Team admin.
   */
  "registry.approved": event("site", {
    registryVersionId: id,
    skillId: id,
    name: catalogName,
    semver: z.string().max(32),
    selfApproved: z.boolean(),
    /** The scan verdict approved: `block` is a Site admin's override (SK32). */
    verdict: z.enum(["pass", "caution", "block"]),
    /** A Site admin approved over a Block verdict, with a note (SK32, review L3). */
    scanOverride: z.literal(true).optional(),
    /** Caution findings acknowledged before approving (review M1). */
    acknowledgedFindings: count.optional(),
    confirmerApproved: z.boolean().optional(),
  }),
  /** A reviewer acknowledged one Caution finding (`rule@file:line`), as Approve needs (SK32). */
  "registry.finding_acknowledged": event("site", {
    registryVersionId: id,
    finding: z.string().min(1).max(700),
  }),
  /** The submitter took back their submission before a decision (KOBE-334 review M3). */
  "registry.retracted": event("site", { registryVersionId: id }),
  /**
   * A Site admin published a version they made in the Site Console straight into the Catalog
   * (KOBE-495): scanned, never reviewed. `publisher` is always `site`; `previousPublisher` and
   * `previousSemver` name the version it follows (Kaiju's, a maintainer's or the Site's own).
   */
  "registry.version_published": event("site", {
    registryVersionId: id,
    skillId: id,
    name: catalogName,
    semver: z.string().max(32),
    publisher: z.literal("site"),
    publishedBy: id,
    verdict: z.enum(["pass", "caution"]),
    runtimeHash: z.string().regex(/^[0-9a-f]{64}$/),
    previousPublisher: z.enum(["kobe", "maintainer", "site"]).nullable(),
    previousSemver: z.string().max(32).nullable(),
  }),
  /**
   * The git mirror pushed an approved version (KOBE-343, SK29): its commit and annotated tag are on
   * the remote (system actor). `existing`: the remote already had exactly this tag and tree.
   */
  "registry.mirror.pushed": event("site", {
    registryVersionId: id,
    name: catalogName,
    semver: z.string().max(32),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    tag: z.string().max(200),
    existing: z.literal(true).optional(),
  }),
  /**
   * The git mirror could not push a version (system actor): recorded on the first failure of a
   * streak only (retries back off silently); `error` is redacted and never holds the token.
   */
  "registry.mirror.failed": event("site", {
    registryVersionId: id,
    name: catalogName,
    semver: z.string().max(32),
    error: z.string().max(500),
  }),
  /** A Site admin asked the mirror to retry its failed versions now (KOBE-343). */
  "registry.mirror.retried": event("site", { versions: count }),
  /** A reviewer started the Registry team's re-run of a version's evals (KOBE-335, SK23). */
  "registry.evals_rerun": event("site", { registryVersionId: id, evalRunId: id, teamId: id }),
  /** A reviewer cancelled a re-run; the version's history keeps it (KOBE-335 review M3). */
  "registry.rerun_cancelled": event("site", { registryVersionId: id, evalRunId: id }),
  /** A re-run completed: its card (numbers only) is the version's authoritative scorecard (system). */
  "registry.authoritative_scorecard": event("site", { registryVersionId: id, evalRunId: id }),
  /** A reviewer sent the version back to its author's Workbench with comments. */
  "registry.changes_requested": event("site", { registryVersionId: id }),
  /** A reviewer rejected the version; `blocked`: a Site admin also blocklisted its runtime hash. */
  "registry.rejected": event("site", { registryVersionId: id, blocked: z.boolean() }),
  /**
   * A published version was retired (KOBE-340, SK31): deprecated (a maintainer or Site admin),
   * withdrawn or revoked (Site admins); `from` is the state it left. Revoke puts the runtime hash on
   * the blocklist (`blocklisted`: this revoke added it); unrevoke returns to `to` and lifts the
   * entry its revoke added (`unblocked`).
   */
  "registry.deprecated": event("site", {
    registryVersionId: id,
    skillId: id,
    name: catalogName,
    semver: z.string().max(32),
    from: z.string().max(32),
  }),
  "registry.withdrawn": event("site", {
    registryVersionId: id,
    skillId: id,
    name: catalogName,
    semver: z.string().max(32),
    from: z.string().max(32),
  }),
  "registry.revoked": event("site", {
    registryVersionId: id,
    skillId: id,
    name: catalogName,
    semver: z.string().max(32),
    from: z.string().max(32),
    blocklisted: z.boolean(),
  }),
  "registry.unrevoked": event("site", {
    registryVersionId: id,
    skillId: id,
    name: catalogName,
    semver: z.string().max(32),
    to: z.string().max(32),
    unblocked: z.boolean(),
    /** The revoke's entry was removed or replaced since: the block stays (review L2). */
    blockReplaced: z.literal(true).optional(),
  }),
  /** A maintainer or Site admin undid a version's deprecation: it is approved again (KOBE-340). */
  "registry.undeprecated": event("site", {
    registryVersionId: id,
    skillId: id,
    name: catalogName,
    semver: z.string().max(32),
    to: z.literal("approved"),
  }),
  /** A maintainer or Site admin undid a skill's deprecation; its replacement is cleared. */
  "skill.catalog.undeprecated": event("site", {
    skillId: id,
    name: catalogName,
    to: z.enum(["active", "unmaintained"]),
  }),
  /** A maintainer or Site admin deprecated a whole catalog skill, naming its replacement or not. */
  "skill.catalog.deprecated": event("site", {
    skillId: id,
    name: catalogName,
    replacementId: id.nullable(),
    /** The status it left, where an undo returns it (review L1). */
    from: z.enum(["active", "unmaintained"]).optional(),
    /** A Site admin deprecated it: only a Site admin undoes it (review-341 L4). */
    byAdmin: z.boolean().optional(),
  }),

  // ── catalog maintainers (KOBE-332, SK24): ids only ──
  /** A maintainer (or a Site admin) added a maintainer to a catalog skill. */
  "skill.maintainer.added": event("site", { skillId: id, userId: id }),
  /** A maintainer (or a Site admin) removed a maintainer; the last one is never removed. */
  "skill.maintainer.removed": event("site", { skillId: id, userId: id }),
  /** A Site admin reassigned a catalog skill's maintainers (SK24). */
  "skill.maintainers.reassigned": event("site", {
    skillId: id,
    userIds: z.array(id).min(1).max(20),
  }),
  /** The skill's last active maintainer was deactivated: it shows Unmaintained (system). */
  "skill.catalog.unmaintained": event("site", { skillId: id, name: catalogName }),
  /** An Unmaintained skill has an active maintainer again (added, reassigned or reactivated). */
  "skill.catalog.maintained": event("site", { skillId: id, name: catalogName }),
  /**
   * A Site admin changed the Registry settings (KOBE-330, SK20, SK21): which settings, and the
   * Registry team and judge alias when they changed (ids and aliases, never URLs or rules).
   */
  "skill.registry.settings_updated": event("site", {
    changed: z
      .array(
        z.enum([
          "registryTeamId",
          "judgeAlias",
          "submissionRules",
          "evalLimits",
          "importAllowlist",
          "scanner",
          "mirror",
        ]),
      )
      .min(1)
      .max(7),
    registryTeamId: id.nullable().optional(),
    judgeAlias: z.string().min(1).max(64).nullable().optional(),
  }),
  /** A Site admin added a topic tag to the vocabulary. */
  "skill.tag.created": event("site", { tagId: id, name: catalogName }),
  /** A Site admin renamed, retired or restored a topic tag. */
  "skill.tag.updated": event("site", {
    tagId: id,
    name: catalogName,
    status: z.enum(["active", "retired"]),
    previousName: catalogName.optional(),
  }),
  /** A Site admin changed a catalog skill's tags; system tag changes are the Default sync's start. */
  "skill.catalog.tags_changed": event("site", {
    skillId: id,
    name: catalogName,
    systemAdded: z.array(catalogName).max(8),
    systemRemoved: z.array(catalogName).max(8),
    topicAdded: z.array(catalogName).max(16),
    topicRemoved: z.array(catalogName).max(64),
  }),
  /** A Site admin moved untouched Default installs of a skill to a new major (SK6). */
  "skill.default.major_moved": event("site", {
    skillId: id,
    name: catalogName,
    fromMajor: z.number().int().min(0),
    toMajor: z.number().int().min(0),
    semver: z.string().max(32),
  }),
  /** A Default sync job finished across every team (counts only, never team names). */
  "skill.default.synced": event("site", {
    skillId: id,
    name: catalogName,
    kind: z.enum(["add", "remove", "move_major"]),
    teams: count,
    /**
     * The per-outcome counts are left out when a team count among them (opted out, opt-outs
     * cleared, blocked) is 1 or 2: the minimum-count rule (SK26) would be undone by subtraction.
     */
    masked: z.boolean(),
    installed: count.optional(),
    kept: count.optional(),
    optedOut: count.optional(),
    blocked: count.optional(),
    /** Teams skipped because they have their own skill of the same name (KOBE-315 review). */
    nameConflicts: count.optional(),
    converted: count.optional(),
    optoutsCleared: count.optional(),
    moved: count.optional(),
  }),
  /**
   * Kaiju published a version of one of its own catalog skills (KOBE-317, SK4) from the package set
   * the server ships, at a server start (system actor). `created`: the skill is new to this Site
   * (it was also tagged Default).
   */
  "skill.kobe.published": event("site", {
    skillId: id,
    name: catalogName,
    semver: z.string().max(32),
    runtimeHash: z.string().regex(/^[0-9a-f]{64}$/),
    created: z.boolean(),
  }),
  /**
   * A Site admin's first edit of a Kaiju-shipped catalog skill detached it (KOBE-495): the Kaiju seed
   * stops publishing it. `fromSemver`: its newest Kaiju version then.
   */
  "skill.detached": event("site", {
    skillId: id,
    name: catalogName,
    fromSemver: z.string().max(32),
  }),
  /**
   * A Site admin re-attached a detached Kaiju skill (KOBE-495): the seed publishes the shipped
   * version (`shippedSemver`, above every Site version) from now on.
   */
  "skill.reset_to_kobe": event("site", {
    skillId: id,
    name: catalogName,
    fromSemver: z.string().max(32),
    shippedSemver: z.string().max(32),
  }),
  /** A Default sync job failed too often and was parked; the queue moved on (error code only). */
  "skill.default.sync_failed": event("site", {
    skillId: id,
    name: catalogName,
    kind: z.enum(["add", "remove", "move_major"]),
    attempts: count,
    error: z.string().regex(/^[a-z0-9_]{1,64}$/),
  }),
  /**
   * A Default sync or the new-team hook changed a team's install of a Default skill (SK8), or
   * skipped the team because it has its own skill of that name (`name_conflict`).
   */
  "skill.default.applied": event("team", {
    skillId: id,
    name: catalogName,
    change: z.enum(["installed", "converted", "optout_cleared", "moved", "name_conflict"]),
    semver: z.string().max(32).optional(),
  }),
  /** A Team admin uninstalled a catalog skill; for a Default skill that records an opt-out (SK7). */
  "skill.catalog.removed": event("team", {
    skillId: id,
    name: catalogName,
    origin: z.enum(["team", "default_tag"]),
    optedOut: z.boolean(),
    /** Whether the opt-out gave a reason (the reason itself is not recorded). */
    reasonGiven: z.boolean(),
  }),
  /**
   * A Team admin set the team's install of a catalog skill (KOBE-315, SK25): its version, pin
   * mode and access (Required is audited here like every change). `previous` when it changed one.
   */
  "skill.catalog.configured": event("team", {
    skillId: id,
    name: catalogName,
    semver: z.string().max(32),
    pinMode: z.enum(["pinned", "within_major", "latest"]),
    access: z.enum(["available", "default_on", "required", "hidden"]),
    /** The version was deprecated: installed with a warning (SK31). */
    deprecated: z.boolean(),
    previous: z
      .strictObject({
        semver: z.string().max(32),
        pinMode: z.enum(["pinned", "within_major", "latest"]),
        access: z.enum(["available", "default_on", "required", "hidden"]),
      })
      .optional(),
  }),
  /** Move pin (KOBE-337, SK25): the install now runs another version (`major`: across majors). */
  "skill.catalog.pin_moved": event("team", {
    skillId: id,
    name: catalogName,
    from: z.string().max(32),
    to: z.string().max(32),
    pinMode: z.enum(["pinned", "within_major", "latest"]),
    /** The tracking mode a move back left for Pinned (review-337 M1). */
    pinModeFrom: z.enum(["within_major", "latest"]).optional(),
    /** The version runs loaded before and after (null: none could run). */
    runningFrom: z.string().max(32).nullable().optional(),
    runningTo: z.string().max(32).nullable().optional(),
    deprecated: z.boolean(),
  }),
  /** Roll back (KOBE-337, SK25): the install returns to the version it ran before its last move. */
  "skill.catalog.rolled_back": event("team", {
    skillId: id,
    name: catalogName,
    from: z.string().max(32),
    to: z.string().max(32),
    pinMode: z.enum(["pinned", "within_major", "latest"]),
    /** The tracking mode a move back left for Pinned (review-337 M1). */
    pinModeFrom: z.enum(["within_major", "latest"]).optional(),
    /** The version runs loaded before and after (null: none could run). */
    runningFrom: z.string().max(32).nullable().optional(),
    runningTo: z.string().max(32).nullable().optional(),
    deprecated: z.boolean(),
  }),
  /** A Team admin reinstalled a removed Default skill, clearing the team's opt-out (SK7). */
  "skill.default.restored": event("team", {
    skillId: id,
    name: catalogName,
    semver: z.string().max(32),
  }),
  /** A member added a catalog skill for themselves in the team (KOBE-338, SK25): Add for me. */
  "skill.member_add.added": event("team", {
    skillId: id,
    name: catalogName,
    semver: z.string().max(32),
    pinMode: z.enum(["pinned", "within_major", "latest"]),
  }),
  /** A member changed the version or pin mode of their own add (KOBE-338). */
  "skill.member_add.changed": event("team", {
    skillId: id,
    name: catalogName,
    semver: z.string().max(32),
    pinMode: z.enum(["pinned", "within_major", "latest"]),
    previous: z.strictObject({
      semver: z.string().max(32),
      pinMode: z.enum(["pinned", "within_major", "latest"]),
    }),
  }),
  /** A member removed their own add (KOBE-338). A block's removals are counted on the block. */
  "skill.member_add.removed": event("team", { skillId: id, name: catalogName }),
  /**
   * A Team admin blocked a catalog skill in the team (KOBE-338, SK25): members' adds of it were
   * removed (`addsRemoved`) and new ones are refused.
   */
  "skill.catalog.blocked": event("team", {
    skillId: id,
    name: catalogName,
    addsRemoved: z.number().int().min(0),
  }),
  /** A Team admin lifted the team's block of a catalog skill (KOBE-338). */
  "skill.catalog.unblocked": event("team", { skillId: id, name: catalogName }),
  /** A member asked the Team admins to install a catalog skill: Request for team (KOBE-338). */
  "skill.catalog.team_requested": event("team", { skillId: id, name: catalogName }),
  /** A Team admin dismissed the open requests for a catalog skill (KOBE-338). */
  "skill.catalog.team_request_dismissed": event("team", {
    skillId: id,
    name: catalogName,
    requests: z.number().int().min(0),
  }),

  // ── skill drafts: the Workbench (KOBE-320, SK11); ids and names, never file contents ──
  /** A member started a draft in the team (private to them until shared). */
  "skill.draft.created": event("team", {
    draftId: id,
    name: catalogName,
    startedFrom: z.enum(["blank", "template", "thread", "fork", "upload", "git"]),
    /** A fork's parent: the version copied (KOBE-322 review N3). */
    parent: z
      .strictObject({
        kind: z.enum(["team", "personal", "catalog"]),
        skillId: id,
        semver: z.string().max(32),
      })
      .optional(),
    /** Save to Workbench: the conversation the files came from. */
    fromThreadId: id.optional(),
    /** A governed import (KOBE-344, SK30): where it came from and Kaiju's hash of what it got. */
    origin: z
      .strictObject({
        kind: z.enum(["git", "zip"]),
        url: z.string().max(2048),
        commit: z
          .string()
          .regex(/^([0-9a-f]{40}|[0-9a-f]{64})$/)
          .optional(),
        path: z.string().max(200).optional(),
        fetchedSha256: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .optional(),
    /** `tool`: the agent's `save_skill_draft` (KOBE-442); absent: the member in the web app. */
    via: z.enum(["tool"]).optional(),
    /** The agent's call behind a `via: tool` save (KOBE-442 review L3). */
    runId: id.optional(),
    toolCallId: toolCallId.optional(),
  }),
  /**
   * Save to Workbench again from the same conversation (KOBE-322) or `save_skill_draft`
   * (KOBE-442, `via: tool`): the draft's files were replaced by the folder's, one new revision.
   */
  "skill.draft.updated": event("team", {
    draftId: id,
    fromThreadId: id.optional(),
    via: z.enum(["tool"]).optional(),
    runId: id.optional(),
    toolCallId: toolCallId.optional(),
  }),
  /** A draft's author shared it with the team's Builders and Team admins, or stopped sharing. */
  "skill.draft.shared": event("team", { draftId: id, shared: z.boolean() }),
  /** A draft's author deleted it (its saved versions stay). */
  "skill.draft.deleted": event("team", { draftId: id }),
  /**
   * A draft was saved as its author's personal skill, which goes with them to every team (SK11):
   * recorded in the draft's team for every personal save. `fromConversation` / `coEdited`: the
   * author confirmed it although it was started from a team conversation or changed by others.
   */
  "skill.draft.personalized": event("team", {
    draftId: id,
    skillId: id,
    slug,
    semver: z.string().max(32),
    fromConversation: z.boolean(),
    coEdited: z.boolean(),
  }),
} as const satisfies Record<string, AuditEventDef>;
