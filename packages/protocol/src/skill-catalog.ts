import { z } from "zod";
import { SEMVER_PATTERN, SKILL_NAME_PATTERN, UUID_PATTERN } from "./skill-package/layout.js";
import type { SCAN_VERDICTS } from "./skill-package/provenance.js";

/**
 * The Site Skills Catalog contract (KOBE-311, spec SK5–SK8, SK22–SK25, SK31): the closed sets the
 * registry, installs and tags use, and the shapes the API and web share. The database enums of
 * `@kaiju/db` (schema/registry.ts, schema/installs.ts) mirror these lists; a server test keeps the
 * two equal.
 */

/** How an install follows new versions (SK25): never, within its major, or always. */
export const SKILL_PIN_MODES = ["pinned", "within_major", "latest"] as const;
export type SkillPinMode = (typeof SKILL_PIN_MODES)[number];

/**
 * How members get a skill (SK25): opt in, on unless turned off, always loaded (Team admins only,
 * audited; loads even for `skills: exclusive` agents, SK27) or only for agents that name it.
 */
export const SKILL_ACCESS_MODES = ["available", "default_on", "required", "hidden"] as const;
export type SkillAccessMode = (typeof SKILL_ACCESS_MODES)[number];

/** Why a team has an install: a Team admin or Builder chose it, or the Default tag put it there. */
export const SKILL_INSTALL_ORIGINS = ["team", "default_tag"] as const;
export type SkillInstallOrigin = (typeof SKILL_INSTALL_ORIGINS)[number];

/** Tags (SK5): system tags are a fixed, code-defined set; topic tags a Site-managed vocabulary. */
export const REGISTRY_TAG_KINDS = ["system", "topic"] as const;
export type RegistryTagKind = (typeof REGISTRY_TAG_KINDS)[number];
/** The code-defined system tags; v1.2 has Default only (SK5, SK6). */
export const SYSTEM_TAGS = ["default"] as const;
export type SystemTag = (typeof SYSTEM_TAGS)[number];
export const REGISTRY_TAG_STATUSES = ["active", "retired"] as const;
export type RegistryTagStatus = (typeof REGISTRY_TAG_STATUSES)[number];
/** A tag name: a lowercase slug (the topic tags of `kaiju.skill.yaml` use the same pattern). */
export const REGISTRY_TAG_PATTERN = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;

/**
 * Who publishes a catalog skill: Kaiju (built-ins, reserved names) or its maintainers (SK24); and,
 * for a version only, the Site (`site`: a Site admin's edit in the Site Console, KOBE-495).
 */
export const REGISTRY_PUBLISHERS = ["kaiju", "maintainer", "site"] as const;
export type RegistryPublisher = (typeof REGISTRY_PUBLISHERS)[number];

/**
 * Values stored before the rename (KOBE-831): Kaiju's publisher was `kobe`, and so were the gallery
 * agent's key and slug. Migration 0262 renamed them in place, but audit rows are append-only and
 * keep them, so the audit views explain them, by field (permanent).
 */
export const PRE_RENAME_STORED_VALUE = "kobe";

/**
 * What a value an audit row recorded before the rename is called now (KOBE-831), or undefined:
 * `publisher` / `previousPublisher` `kobe`, and the `slug` / `key` `kobe` of a gallery agent.
 */
export function renamedStoredValue(
  field: string,
  value: unknown,
  target: Readonly<Record<string, unknown>>,
): string | undefined {
  if (value !== PRE_RENAME_STORED_VALUE) return undefined;
  if (field === "publisher" || field === "previousPublisher") return "kaiju";
  if ((field === "slug" || field === "key") && target["scope"] === "gallery") return "kaiju";
  return undefined;
}

/**
 * The skills Kaiju publishes (KOBE-317, SK4): the former built-ins, from the package set the
 * server ships. Their catalog names are reserved for publisher `kaiju` (SK24; a database check
 * mirrors this list), and an agent naming one always gets the Kaiju skill, never a team or
 * personal skill of that name.
 */
export const KAIJU_SKILL_NAMES = [
  "data-analysis",
  "charts",
  "docx",
  "pdf",
  "xlsx",
  "code-review",
  "skill-creator",
  "kaiju-guide",
] as const;
export type KaijuSkillName = (typeof KAIJU_SKILL_NAMES)[number];

/**
 * Kaiju's skills that were renamed (KOBE-833, spec §11 A12), old name to new. Migration 0263
 * renamed the catalog skill in place (its installs, tags and old versions follow it); the old name
 * stays reserved for Kaiju, and an agent that still names it gets the new skill
 * (`currentSkillNames`, server), unless a catalog skill holds the old name. Permanent: published
 * agent versions keep their skill list forever.
 */
export const PRE_RENAME_KAIJU_SKILL_NAMES: Readonly<Record<string, KaijuSkillName>> = {
  "kobe-guide": "kaiju-guide",
};

/** Names reserved for Kaiju: the skills it ships and the names they had before (KOBE-833). */
export const KAIJU_RESERVED_SKILL_NAMES: readonly string[] = [
  ...KAIJU_SKILL_NAMES,
  ...Object.keys(PRE_RENAME_KAIJU_SKILL_NAMES),
];

/** A name reserved for Kaiju's own skills: one it ships, or a pre-rename one (KOBE-833). */
export function isKaijuSkillName(name: string): boolean {
  return KAIJU_RESERVED_SKILL_NAMES.includes(name);
}
export const REGISTRY_SKILL_STATUSES = [
  "active",
  "deprecated",
  "unmaintained",
  "archived",
] as const;
export type RegistrySkillStatus = (typeof REGISTRY_SKILL_STATUSES)[number];

/**
 * A catalog version's life (SK23, SK31). Only an approved-or-later version was ever published, and
 * a published one never goes back into review. Nobody reviews their own submission.
 *
 * Team-private data in catalog rows: a version's `source` (the originating team's ids) is shown
 * only to site reviewers and the submitting team, never to catalog browsers; its scorecards hold
 * aggregate numbers only, never eval case inputs, outputs or transcripts.
 */
export const REGISTRY_VERSION_STATES = [
  "submitted",
  "in_review",
  "changes_requested",
  "approved",
  "rejected",
  "deprecated",
  "withdrawn",
  "revoked",
  /** The submitter took the submission back before a decision (KOBE-334). */
  "retracted",
] as const;
export type RegistryVersionState = (typeof REGISTRY_VERSION_STATES)[number];
/** States of a version that was approved (published) at some point. */
export const PUBLISHED_VERSION_STATES = ["approved", "deprecated", "withdrawn", "revoked"] as const;
/** States in which a version may be newly installed (a deprecated one only with a warning). */
export const INSTALLABLE_VERSION_STATES = ["approved", "deprecated"] as const;

/** Scanner verdict tiers (SK32), as provenance.json records them. */
export type ScanVerdict = (typeof SCAN_VERDICTS)[number];

/** What a review event records (SK23, SK31); events are append-only. */
export const REGISTRY_REVIEW_ACTIONS = [
  "submitted",
  "claimed",
  "unclaimed",
  "commented",
  "approved",
  "changes_requested",
  "rejected",
  "rejected_and_blocked",
  "evals_rerun",
  "deprecated",
  "withdrawn",
  "revoked",
  "unrevoked",
  /** A maintainer or Site admin undid a version's deprecation (KOBE-340). */
  "undeprecated",
  /** A reviewer acknowledged one Caution finding before approving (SK32). */
  "finding_acknowledged",
  "retracted",
] as const;
export type RegistryReviewAction = (typeof REGISTRY_REVIEW_ACTIONS)[number];

/**
 * Site grants beside the role ladder (SK22): the smallest step toward custom roles.
 * `memory_steward` (KOBE-380, SM19) = a Site memory steward (`MEMORY_STEWARD_SITE_GRANT`).
 */
export const SITE_GRANTS = ["skill_reviewer", "memory_steward"] as const;
export type SiteGrant = (typeof SITE_GRANTS)[number];

const uuid = z.string().regex(UUID_PATTERN);

/**
 * Which skill a member enablement is about, on the wire: a catalog skill (a member's Add for me,
 * SK25) or a team skill (a member turning an On by default one off). Stored as two typed columns
 * with real foreign keys (`member_skill_enablements.catalog_skill_id` / `team_skill_id`).
 */
export const skillRefSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("catalog"), skillId: uuid }),
  z.strictObject({ kind: z.literal("team"), skillId: uuid }),
]);
export type SkillRef = z.infer<typeof skillRefSchema>;

/** A team install of a catalog skill as the API returns it (SK25). */
export const teamSkillInstallSchema = z.strictObject({
  skillId: uuid,
  name: z.string().regex(SKILL_NAME_PATTERN),
  versionId: uuid,
  semver: z.string().regex(SEMVER_PATTERN),
  pinMode: z.enum(SKILL_PIN_MODES),
  access: z.enum(SKILL_ACCESS_MODES),
  origin: z.enum(SKILL_INSTALL_ORIGINS),
  /** Who installed it; null when Kaiju's own Default sync did (a Kaiju-published skill, KOBE-317). */
  installedBy: uuid.nullable(),
  updatedAt: z.string(),
  /** The skill carries the Default tag: the "Site default" badge (KOBE-314). */
  isDefault: z.boolean(),
});
export type TeamSkillInstall = z.infer<typeof teamSkillInstallSchema>;

/** `PUT /v1/team/skills/installs/{skillId}` (spec §8): a version by semver, pin and access. */
export const putTeamSkillInstallSchema = z.strictObject({
  version: z.string().regex(SEMVER_PATTERN),
  pinMode: z.enum(SKILL_PIN_MODES),
  access: z.enum(SKILL_ACCESS_MODES),
});

/** `PUT /v1/me/skills/adds/{skillId}` (spec §8): a member's own add, at a version and pin. */
export const putMemberSkillAddSchema = z.strictObject({
  version: z.string().regex(SEMVER_PATTERN),
  pinMode: z.enum(SKILL_PIN_MODES),
});

/** A tag as the API returns it. */
export const registryTagSchema = z.strictObject({
  id: uuid,
  name: z.string().regex(REGISTRY_TAG_PATTERN),
  kind: z.enum(REGISTRY_TAG_KINDS),
  status: z.enum(REGISTRY_TAG_STATUSES),
});
export type RegistryTag = z.infer<typeof registryTagSchema>;

/** `PUT /v1/site/skills/catalog/{skillId}/tags` (spec §8). */
export const putSkillTagsSchema = z.strictObject({
  system: z.array(z.enum(SYSTEM_TAGS)).max(SYSTEM_TAGS.length),
  topic: z.array(z.string().regex(REGISTRY_TAG_PATTERN)).max(10),
});

/** `POST /v1/site/skills/tags`: a new topic tag (KOBE-314, SK5). */
export const createTopicTagSchema = z.strictObject({
  name: z.string().regex(REGISTRY_TAG_PATTERN),
});

/** `PATCH /v1/site/skills/tags/{id}`: rename, retire or restore a topic tag. */
export const updateTopicTagSchema = z
  .strictObject({
    name: z.string().regex(REGISTRY_TAG_PATTERN).optional(),
    status: z.enum(REGISTRY_TAG_STATUSES).optional(),
  })
  .refine((b) => b.name !== undefined || b.status !== undefined, {
    message: "Send a name, a status or both.",
  });

/** `POST /v1/site/skills/catalog/{skillId}/default/move-major` (spec §8, SK6). */
export const moveDefaultMajorSchema = z.strictObject({
  to: z.number().int().min(0).max(999_999_999),
});

/** `DELETE /v1/team/skills/installs/{skillId}`: an optional reason for a Default opt-out (SK7). */
export const uninstallSkillSchema = z.strictObject({
  reason: z.string().trim().min(1).max(500).optional(),
});

/**
 * Default sync jobs (KOBE-314, SK8): `add` puts a skill in every team, `remove` turns tag-made
 * installs into team installs and clears opt-outs, `move_major` moves untouched Default installs.
 * Mirrors `@kaiju/db` schema/skill-default-syncs.ts.
 */
export const DEFAULT_SYNC_KINDS = ["add", "remove", "move_major"] as const;
export type DefaultSyncKind = (typeof DEFAULT_SYNC_KINDS)[number];
export const DEFAULT_SYNC_STATUSES = ["queued", "running", "done", "failed"] as const;
export type DefaultSyncStatus = (typeof DEFAULT_SYNC_STATUSES)[number];
