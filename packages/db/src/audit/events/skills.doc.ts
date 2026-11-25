import type { AuditEventDoc } from "./fragments.js";
import type { SKILLS_EVENTS } from "./skills.js";

/**
 * The docs/audit-log.md rows of the skills area's events (KOBE-815), in name order; the table is
 * generated from these (`pnpm --filter @kaiju/db audit:doc`). Add an event's row here in name order.
 */
export const SKILLS_EVENT_DOCS = {
  "registry.approved": {
    fields:
      "`registryVersionId`, `skillId`, `name`, `semver`, `selfApproved`, `verdict`, `scanOverride?`, `acknowledgedFindings?`, `confirmerApproved?`",
    when: "A reviewer approved a version into the Catalog; `verdict` block is a Site admin's override; the flags mark a single-admin Site's own approval (KOBE-334, SK22)",
  },
  "registry.authoritative_scorecard": {
    fields: "`registryVersionId`, `evalRunId`",
    when: "A re-run completed; its card (numbers only) is the version's authoritative scorecard (system, KOBE-335)",
  },
  "registry.changes_requested": {
    fields: "`registryVersionId`",
    when: "A reviewer sent the version back to its author's Workbench with comments (KOBE-334)",
  },
  "registry.claimed": {
    fields: "`registryVersionId`",
    when: "A reviewer claimed a submitted version; it is In review (KOBE-334, SK23)",
  },
  "registry.commented": {
    fields: "`registryVersionId`",
    when: "A reviewer commented on a version; the note stays in the Registry (KOBE-334)",
  },
  "registry.deprecated": {
    fields: "`registryVersionId`, `skillId`, `name`, `semver`, `from`",
    when: "A maintainer or Site admin deprecated a published version: new installs need a Team admin's override (KOBE-340, SK31)",
  },
  "registry.evals_rerun": {
    fields: "`registryVersionId`, `evalRunId`, `teamId`",
    when: "A reviewer started the Registry team's re-run of a version's evals (KOBE-335, SK23)",
  },
  "registry.finding_acknowledged": {
    fields: "`registryVersionId`, `finding` (`rule@file:line`)",
    when: "A reviewer acknowledged one Caution finding; Approve needs all of them (KOBE-334, SK32)",
  },
  "registry.mirror.failed": {
    fields: "`registryVersionId`, `name`, `semver`, `error`",
    when: "The git mirror could not push a version; recorded on the first failure of a streak, retries back off silently; the error never holds the token (system; KOBE-343)",
  },
  "registry.mirror.pushed": {
    fields: "`registryVersionId`, `name`, `semver`, `commit`, `tag`, `existing?`",
    when: "The git mirror pushed an approved version: its commit and annotated tag are on the remote; `existing` when the remote already had exactly that tag and tree (system; KOBE-343, SK29)",
  },
  "registry.mirror.retried": {
    fields: "`versions`",
    when: "A Site admin asked the mirror to retry its failed versions now (KOBE-343)",
  },
  "registry.rejected": {
    fields: "`registryVersionId`, `blocked`",
    when: "A reviewer rejected the version; `blocked`: a Site admin also blocklisted its runtime hash (KOBE-334)",
  },
  "registry.rerun_cancelled": {
    fields: "`registryVersionId`, `evalRunId`",
    when: "A reviewer cancelled a re-run; the version's history keeps it (KOBE-335)",
  },
  "registry.retracted": {
    fields: "`registryVersionId`",
    when: "The submitter took back their submission before a decision (KOBE-334)",
  },
  "registry.revoked": {
    fields: "`registryVersionId`, `skillId`, `name`, `semver`, `from`, `blocklisted`",
    when: "A Site admin revoked a version: its runtime hash is blocklisted, it stops at the next fetch everywhere (KOBE-340, SK31)",
  },
  "registry.submitted": {
    fields: "`registryVersionId`, `skillId`, `name`, `semver`, `newSkill`",
    when: "A version was submitted to the Site Registry for review (KOBE-333)",
  },
  "registry.unclaimed": {
    fields: "`registryVersionId`",
    when: "A reviewer let go of a claim; the version waits in the queue again (KOBE-334)",
  },
  "registry.undeprecated": {
    fields: "`registryVersionId`, `skillId`, `name`, `semver`, `to` (approved)",
    when: "A maintainer or Site admin undid a version's deprecation (KOBE-340)",
  },
  "registry.unrevoked": {
    fields: "`registryVersionId`, `skillId`, `name`, `semver`, `to`, `unblocked`, `blockReplaced?`",
    when: "A Site admin undid a revoke: the version returns to the state it had, the entry its revoke added is lifted (KOBE-340)",
  },
  "registry.version_published": {
    fields:
      "`registryVersionId`, `skillId`, `name`, `semver`, `publisher` (site), `publishedBy`, `verdict`, `runtimeHash`, `previousPublisher` (kaiju, maintainer or site; rows from before the rename say kobe for kaiju), `previousSemver`",
    when: "A Site admin published a version they made in the Site Console straight into the Catalog: scanned, never reviewed (a Block stops it); the previous version's publisher and semver are recorded (KOBE-495)",
  },
  "registry.withdrawn": {
    fields: "`registryVersionId`, `skillId`, `name`, `semver`, `from`",
    when: "A Site admin withdrew a version: no new installs or pins; tracking installs move within their range (KOBE-340, SK31)",
  },
  "skill.access.changed": {
    fields: "`skillId`, `slug`, `access`, `previous`",
    when: "A team skill's access mode changed: Available, On by default, Required (Team admins only) or Hidden (KOBE-316)",
  },
  "skill.blocklist.added": {
    fields: "`bundleHash`",
    when: "Bundle hash put on the site skill blocklist (KOBE-81); the reason is stored with the entry, not here",
  },
  "skill.blocklist.removed": {
    fields: "`bundleHash`",
    when: "Bundle hash taken off the blocklist (KOBE-81)",
  },
  "skill.catalog.blocked": {
    fields: "`skillId`, `name`, `addsRemoved`",
    when: "A Team admin blocked a catalog skill in the team: members' adds removed, new ones refused (KOBE-338, SK25)",
  },
  "skill.catalog.configured": {
    fields:
      "`skillId`, `name`, `semver`, `pinMode`, `access`, `deprecated`, `previous?` (`semver`, `pinMode`, `access`)",
    when: "A Team admin installed a catalog skill or changed its version, pin mode or access (KOBE-315, SK25); Required included",
  },
  "skill.catalog.deprecated": {
    fields: "`skillId`, `name`, `replacementId`, `from?`, `byAdmin?`",
    when: "A maintainer or Site admin deprecated a whole catalog skill, optionally naming its replacement (KOBE-340, SK31)",
  },
  "skill.catalog.maintained": {
    fields: "`skillId`, `name`",
    when: "An Unmaintained skill has an active maintainer again (KOBE-332)",
  },
  "skill.catalog.pin_moved": {
    fields:
      "`skillId`, `name`, `from`, `to`, `pinMode`, `pinModeFrom?`, `runningFrom?`, `runningTo?`, `deprecated`",
    when: "Move pin: the install now runs another version of the catalog skill (KOBE-337, SK25)",
  },
  "skill.catalog.removed": {
    fields: "`skillId`, `name`, `origin` (team, default_tag), `optedOut`, `reasonGiven`",
    when: "A Team admin uninstalled a catalog skill; on a Default skill that records a sticky opt-out (KOBE-314, SK7); the reason is stored, not here",
  },
  "skill.catalog.rolled_back": {
    fields:
      "`skillId`, `name`, `from`, `to`, `pinMode`, `pinModeFrom?`, `runningFrom?`, `runningTo?`, `deprecated`",
    when: "Roll back: the install returns to the version it ran before its last change (KOBE-337, SK25)",
  },
  "skill.catalog.tags_changed": {
    fields: "`skillId`, `name`, `systemAdded`, `systemRemoved`, `topicAdded`, `topicRemoved`",
    when: "A Site admin changed a catalog skill's tags; adding or removing Default queues a Default sync (KOBE-314, SK8)",
  },
  "skill.catalog.team_request_dismissed": {
    fields: "`skillId`, `name`, `requests`",
    when: "A Team admin dismissed the open requests for a catalog skill (KOBE-338)",
  },
  "skill.catalog.team_requested": {
    fields: "`skillId`, `name`",
    when: "A member asked the Team admins to install a catalog skill (Request for team, KOBE-338); the admins are emailed",
  },
  "skill.catalog.unblocked": {
    fields: "`skillId`, `name`",
    when: "A Team admin lifted the team's block of a catalog skill (KOBE-338)",
  },
  "skill.catalog.undeprecated": {
    fields: "`skillId`, `name`, `to` (active, unmaintained)",
    when: "A maintainer or Site admin undid a skill's deprecation; its replacement is cleared (KOBE-340)",
  },
  "skill.catalog.unmaintained": {
    fields: "`skillId`, `name`",
    when: "The last active maintainer was deactivated; Site admins are emailed (KOBE-332, system)",
  },
  "skill.catalog_switches.changed": {
    fields: "`membersMayAddCatalog?`, `buildersMayInstallCatalog?`, `buildersMayPromote?`",
    when: "A Team admin changed the team's catalog switches; only the changed ones (KOBE-316)",
  },
  "skill.default.applied": {
    fields:
      "`skillId`, `name`, `change` (installed, converted, optout_cleared, moved, name_conflict), `semver?`",
    when: "A Default sync or the new-team hook changed the team's install of a Default skill (system actor, KOBE-314)",
  },
  "skill.default.major_moved": {
    fields: "`skillId`, `name`, `fromMajor`, `toMajor`, `semver`",
    when: "A Site admin moved untouched Default installs to a new major (KOBE-314, SK6)",
  },
  "skill.default.restored": {
    fields: "`skillId`, `name`, `semver`",
    when: "A Team admin reinstalled a removed default, clearing the team's opt-out (KOBE-314, SK7)",
  },
  "skill.default.sync_failed": {
    fields: "`skillId`, `name`, `kind`, `attempts`, `error` (code)",
    when: "A Default sync job failed on every retry and was parked as failed; the queue moved on (KOBE-314)",
  },
  "skill.default.synced": {
    fields:
      "`skillId`, `name`, `kind` (add, remove, move_major), `teams`, `masked`, `installed?`, `kept?`, `optedOut?`, `blocked?`, `nameConflicts?`, `converted?`, `optoutsCleared?`, `moved?`",
    when: "A Default sync job finished across every team (system actor; counts only, left out when a team count among them is 1 or 2, SK26)",
  },
  "skill.detached": {
    fields: "`skillId`, `name`, `fromSemver`",
    when: "A Site admin's first edit of a Kaiju-shipped catalog skill detached it: the Kaiju seed stops publishing it and only records the shipped version (KOBE-495)",
  },
  "skill.draft.created": {
    fields:
      "`draftId`, `name`, `startedFrom` (blank, template, thread, fork, upload, git), `parent?`, `fromThreadId?`, `via?` (tool), `runId?`, `toolCallId?`, `origin?` (kind, url, commit?, path?, fetchedSha256)",
    when: "A member started a Workbench draft in the team, private to them until shared (KOBE-320, SK10)",
  },
  "skill.draft.deleted": {
    fields: "`draftId`",
    when: "A draft's author deleted it; its saved versions stay (KOBE-320)",
  },
  "skill.draft.personalized": {
    fields: "`draftId`, `skillId`, `slug`, `semver`, `fromConversation`, `coEdited`",
    when: "A draft was saved as its author's personal skill (every personal save, in the draft's team); the flags say what the author confirmed (KOBE-320, SK11)",
  },
  "skill.draft.shared": {
    fields: "`draftId`, `shared`",
    when: "A draft's author shared it with the team's Builders and Team admins, or stopped sharing (KOBE-320, SK11)",
  },
  "skill.draft.updated": {
    fields: "`draftId`, `fromThreadId?`, `via?` (tool), `runId?`, `toolCallId?`",
    when: "The draft's files were replaced from `/workspace/skills/<folder>/`: Save to Workbench again or `save_skill_draft` (KOBE-322, KOBE-442)",
  },
  "skill.enablement.changed": {
    fields: "`kind` (personal, team, catalog), `skillId`, `name`, `enabled`",
    when: "A member turned a skill on or off for themselves in the team (KOBE-316)",
  },
  "skill.eval_cap.changed": {
    fields: "`cap` (`{usd}`, `{tokens}` or null)",
    when: "A Team admin set or removed the team's monthly eval cap (KOBE-327)",
  },
  "skill.eval_judge.changed": {
    fields: "`alias` (null: the team default)",
    when: "A Team admin chose the team's eval judge, one of its enabled models; used when the Site's judge isn't enabled in the team (KOBE-326)",
  },
  "skill.exported": {
    fields:
      "`scope` (team, personal, catalog), `skillId`, `registryVersionId?`, `name`, `semver`, `format` (portable, portable_evals, package), `sha256`",
    when: "A version was downloaded as an export: a portable zip (with or without `evals/`) or a catalog version's full package; `sha256` names the exact bytes; team versions in the team view (KOBE-345, SK30)",
  },
  "skill.kobe.published": {
    fields: "`skillId`, `name`, `semver`, `runtimeHash`, `created`",
    when: "Kaiju published a version of one of its own catalog skills (the former built-ins) from the package set the server ships, at a server start (system actor, KOBE-317); `created`: new to this Site and tagged Default",
  },
  "skill.maintainer.added": {
    fields: "`skillId`, `userId`",
    when: "A maintainer or Site admin added a catalog skill maintainer (KOBE-332, SK24)",
  },
  "skill.maintainer.removed": {
    fields: "`skillId`, `userId`",
    when: "A maintainer or Site admin removed a maintainer; never the last (KOBE-332)",
  },
  "skill.maintainers.reassigned": {
    fields: "`skillId`, `userIds`",
    when: "A Site admin reassigned the maintainers (KOBE-332, SK24)",
  },
  "skill.manifest.generated": {
    fields: "`draftId`, `skillId?`, `scope?`, `version?`, `semver?`, `model`, `from` (model, seed)",
    when: "Kaiju drafted a kaiju.skill.yaml for a version without one, with the member's chosen model, into a new Workbench draft of theirs; metadata only, never the file's text (KOBE-564)",
  },
  "skill.member_add.added": {
    fields: "`skillId`, `name`, `semver`, `pinMode`",
    when: "A member added a catalog skill for themselves in the team: it loads only in their runs there (KOBE-338, SK25)",
  },
  "skill.member_add.changed": {
    fields: "`skillId`, `name`, `semver`, `pinMode`, `previous` (`semver`, `pinMode`)",
    when: "A member changed the version or pin mode of their own add (KOBE-338)",
  },
  "skill.member_add.removed": {
    fields: "`skillId`, `name`",
    when: "A member removed their own add (KOBE-338); adds a block removes are counted on `skill.catalog.blocked`",
  },
  "skill.offer.changed": {
    fields: "`skillId`, `slug`, `offerToAll`",
    when: 'A team admin turned a team skill\'s "Offer to all agents" on or off (KOBE-297)',
  },
  "skill.personal_switch.changed": {
    fields: "`disabled`",
    when: "A team admin turned the team's personal skills off or on (KOBE-80)",
  },
  "skill.promoted": {
    fields:
      "`skillId`, `scope`, `version`, `semver`, `registryVersionId`, `files`, `fixtures`, `fromConversation`, `requestId?`",
    when: "A version left the team for the Site Registry (KOBE-333, SK19)",
  },
  "skill.promotion.confirmed": {
    fields: "`requestId`, `registryVersionId`",
    when: "A Team admin confirmed a Builder's promotion; Kaiju submitted it (KOBE-333)",
  },
  "skill.promotion.declined": {
    fields: "`requestId`",
    when: "A Team admin declined a Builder's promotion (KOBE-333)",
  },
  "skill.promotion.requested": {
    fields: "`requestId`, `skillId`, `version`, `semver`",
    when: "A Builder asked to promote a team version; it waits for a Team admin (KOBE-333, SK19)",
  },
  "skill.registry.settings_updated": {
    fields:
      "`changed` (registryTeamId, judgeAlias, submissionRules, evalLimits, importAllowlist, scanner, mirror), `registryTeamId?`, `judgeAlias?`",
    when: "A Site admin changed the Registry settings (KOBE-330, SK20, SK21); never URLs or rule values",
  },
  "skill.rescan.suspended": {
    fields: "`skillId`, `slug`, `version`, `scope` (team, personal), `ruleSetVersion`, `reason`?",
    when: "A rescan on a scanner rule-set change turned a version Block and suspended it pending review (KOBE-313, SK32); `reason: rescan_incomplete` when the rescan kept not finishing past the configured period (KOBE-781)",
  },
  "skill.reset_to_kobe": {
    fields: "`skillId`, `name`, `fromSemver`, `shippedSemver`",
    when: "A Site admin re-attached a detached Kaiju skill; the seed publishes the shipped version, which must be above every Site version (KOBE-495)",
  },
  "skill.reviewed": {
    fields:
      "`skillId`, `slug`, `version`, `decision` (approved, rejected), `previous`, `flagged`, `verdict?` (pass, caution, block; KOBE-312), `acknowledged?`",
    when: "A team admin decided a team skill version (KOBE-80); approving a Caution or Block scan needs its findings acknowledged",
  },
  "skill.scan.override": {
    fields: "`skillId`, `slug`, `version`, `bundleHash`, `findings` (blocking count)",
    when: "A Site admin approved a version the scan blocks (KOBE-312, SK32); the reason is the review note",
  },
  "skill.tag.created": {
    fields: "`tagId`, `name`",
    when: "A Site admin added a topic tag to the catalog vocabulary (KOBE-314, SK5)",
  },
  "skill.tag.updated": {
    fields: "`tagId`, `name`, `status` (active, retired), `previousName?`",
    when: "A Site admin renamed, retired or restored a topic tag (KOBE-314)",
  },
  "skill.uploaded": {
    fields:
      "`skillId`, `scope` (team, personal), `slug`, `version`, `semver?` (KOBE-308), `bundleHash`, `bytes`, `files`, `source` (zip, skill_md), `findings?` (scanner finding count), `draftId?` (KOBE-320)",
    when: "Skill bundle uploaded as a new immutable version (never its contents)",
  },
} satisfies Record<keyof typeof SKILLS_EVENTS, AuditEventDoc>;
