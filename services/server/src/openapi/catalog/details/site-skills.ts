import {
  DEFAULT_SYNC_KINDS,
  DEFAULT_SYNC_STATUSES,
  REGISTRY_SKILL_STATUSES,
  createTopicTagSchema,
  moveDefaultMajorSchema,
  putSkillTagsSchema,
  registryMirrorSchema,
  registryScannerSchema,
  registrySettingsUpdateSchema,
  registrySubmissionRulesSchema,
  registryTagSchema,
  registryTeamCreateSchema,
  skillEvalLimitsSchema,
  updateTopicTagSchema,
} from "@kaiju/protocol";
import { skillRescanStatus } from "@kaiju/db";
import { z } from "zod";
import { addSchema } from "../../../routes/site-skill-blocklist.js";
import { noteSchema, skillSchema } from "../../../routes/site-skill-retire.js";
import { named, untyped, type CatalogDetail } from "../build.js";
import { arr, bool, dateTime, int, nullable, obj, oneOfStrings, str, uuid } from "../json.js";
import { siteSkillsReviewDetails } from "./site-skills-review.js";
import { siteSkillsEditDetails } from "./site-skills-edit.js";
import { publisher } from "./site-skills-json.js";

/**
 * Request and response schemas of the "Site: skills" catalog area (KOBE-771): the blocklist and
 * rescans (`routes/site-skill-blocklist.ts`, `site-skill-rescans.ts`), tags and Default syncs
 * (`site-skill-tags.ts`), retirement (`site-skill-retire.ts`), Registry settings, mirror and export
 * (`site-skill-registry.ts`, `site-skill-mirror.ts`); the review console and the catalog editor
 * are in `site-skills-review.ts` and `site-skills-edit.ts`.
 */

const blockedEntry = obj({ contentHash: str, reason: str, addedBy: uuid, addedAt: dateTime });

const rescanSuspension = obj({
  scope: oneOfStrings("team", "personal", "catalog"),
  "teamId?": uuid,
  skillId: uuid,
  version: { anyOf: [int, str], description: "Local version number, or the catalog version id." },
  slug: str,
});

const siteCatalogSkill = obj({
  id: uuid,
  name: str,
  summary: str,
  publisher,
  status: oneOfStrings(...REGISTRY_SKILL_STATUSES),
  latest: nullable(str),
  system: arr(str),
  topic: arr(str),
  defaultMajor: nullable(int),
  optOuts: {
    anyOf: [int, oneOfStrings("few"), { type: "null" }],
    description: "Default skills only; `few` under the minimum-count rule.",
  },
});

const syncCounts = obj({
  installed: int,
  kept: int,
  optedOut: int,
  blocked: int,
  nameConflicts: int,
  converted: int,
  optoutsCleared: int,
  moved: int,
});

const defaultSync = obj({
  id: uuid,
  skillId: uuid,
  name: str,
  kind: oneOfStrings(...DEFAULT_SYNC_KINDS),
  major: nullable(int),
  status: oneOfStrings(...DEFAULT_SYNC_STATUSES),
  createdAt: str,
  startedAt: nullable(str),
  finishedAt: nullable(str),
  teamsTotal: int,
  teamsDone: int,
  counts: nullable(syncCounts),
  attempts: int,
  lastError: nullable(str),
  nextAttemptAt: nullable(str),
});

/** `RegistrySettings` of `@kaiju/protocol` (an interface there): the settings with defaults. */
const registrySettingsSchema = z.object({
  ready: z.boolean(),
  registryTeam: z.object({ id: z.string(), slug: z.string(), name: z.string() }).nullable(),
  judgeAlias: z.string().nullable(),
  submissionRules: registrySubmissionRulesSchema,
  evalLimits: skillEvalLimitsSchema,
  importAllowlist: z.array(z.string()),
  scanner: registryScannerSchema,
  mirror: registryMirrorSchema,
  updatedAt: z.string(),
});
const RegistrySettings = named("RegistrySettings", registrySettingsSchema);

const mirrorFailure = obj({
  registryVersionId: uuid,
  name: str,
  semver: str,
  attempts: int,
  lastError: str,
  lastAttemptAt: str,
  nextAttemptAt: nullable(str),
});

const SkillRetirement = untyped(
  "SkillRetirementResult",
  obj({ state: str, notified: { type: "boolean", description: "Whether notices went out." } }),
);

const TopicTag = named("SiteTopicTagResponse", z.object({ tag: registryTagSchema }));

const baseDetails: Readonly<Record<string, CatalogDetail>> = {
  "get /v1/site/skill-blocklist": {
    query: {
      limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      cursor: { type: "string", description: "`nextCursor` of the previous page." },
    },
    response: untyped(
      "SkillBlocklistPage",
      obj({ entries: arr(blockedEntry), nextCursor: nullable(str) }),
    ),
  },
  "post /v1/site/skill-blocklist": {
    body: named("BlockSkillHashBody", addSchema),
    status: 201,
    response: untyped("SkillBlocklistEntryResponse", obj({ entry: blockedEntry })),
    errors: ["409"],
  },
  "delete /v1/site/skill-blocklist/{hash}": { status: 204, errors: ["404"] },
  "get /v1/site/skill-rescans": {
    response: untyped(
      "SkillRescanList",
      obj({
        current: { type: "string", description: "The scanner rule set version (name)." },
        currentRuleSet: { type: "integer", description: "The rule set's ordinal." },
        rescans: arr(
          obj({
            ruleSet: int,
            ruleSetVersion: str,
            status: oneOfStrings(...skillRescanStatus),
            startedAt: dateTime,
            finishedAt: nullable(dateTime),
            scanned: int,
            changed: int,
            suspended: int,
            failed: int,
            suspensions: arr(rescanSuspension),
          }),
        ),
      }),
    ),
  },
  "get /v1/site/skills/catalog": {
    response: untyped("SiteSkillCatalog", obj({ skills: arr(siteCatalogSkill) })),
  },
  "post /v1/site/skills/catalog/{skillId}/default/move-major": {
    body: named("MoveDefaultMajorBody", moveDefaultMajorSchema),
    status: 202,
    response: untyped("DefaultMajorMoveQueued", obj({ syncId: uuid, semver: str })),
    errors: ["404", "409"],
  },
  "post /v1/site/skills/catalog/{skillId}/deprecate": {
    body: named("DeprecateCatalogSkillBody", skillSchema),
    response: SkillRetirement,
    errors: ["404", "409", "422"],
  },
  "put /v1/site/skills/catalog/{skillId}/tags": {
    body: named("PutSkillTagsBody", putSkillTagsSchema),
    response: untyped(
      "SkillTagsSet",
      obj({ system: arr(str), topic: arr(str), syncId: nullable(uuid) }),
    ),
    responseDescription: "The skill's tags; `syncId` is the Default sync this change queued.",
    errors: ["404", "409"],
  },
  "post /v1/site/skills/catalog/{skillId}/undeprecate": {
    body: null,
    response: SkillRetirement,
    errors: ["404", "409"],
  },
  "get /v1/site/skills/catalog/{skillId}/versions": {
    response: untyped(
      "CatalogSkillPublishedVersions",
      obj({
        status: str,
        mayRetire: bool,
        versions: arr(obj({ semver: str, state: str, suspended: bool })),
      }),
    ),
    errors: ["404"],
  },
  "post /v1/site/skills/catalog/{skillId}/versions/{semver}/{act}": {
    body: named("RetireCatalogVersionBody", noteSchema),
    response: SkillRetirement,
    responseDescription:
      "`act` is deprecate, undeprecate, withdraw, revoke or unrevoke; the state it left.",
    errors: ["404", "409", "422"],
  },
  "get /v1/site/skills/default-syncs": {
    response: untyped("DefaultSyncList", obj({ syncs: arr(defaultSync) })),
  },
  "get /v1/site/skills/registry/mirror": {
    response: untyped(
      "SkillMirrorStatus",
      obj({
        enabled: bool,
        url: nullable(str),
        branch: str,
        ready: bool,
        missing: arr(oneOfStrings("token", "egress_proxy")),
        hostInCeiling: nullable(bool),
        pushed: int,
        withdrawn: int,
        pending: int,
        failed: int,
        lastPushedAt: nullable(str),
        failures: arr(mirrorFailure),
      }),
    ),
  },
  "post /v1/site/skills/registry/mirror/retry": {
    body: null,
    response: untyped(
      "SkillMirrorRetry",
      obj({ versions: { type: "integer", description: "Failed versions made due now." } }),
    ),
    errors: ["409"],
  },
  "get /v1/site/skills/registry/settings": { response: RegistrySettings },
  "put /v1/site/skills/registry/settings": {
    body: named("RegistrySettingsUpdateBody", registrySettingsUpdateSchema),
    response: RegistrySettings,
  },
  "get /v1/site/skills/registry/similar": {
    query: { name: { type: "string", description: "The submitted skill name." } },
    requiredQuery: ["name"],
    response: untyped("SimilarCatalogNames", obj({ similar: arr(str) })),
  },
  "get /v1/site/skills/registry/status": {
    response: untyped(
      "RegistryStatus",
      obj({ ready: bool, registryTeam: nullable(obj({ id: uuid, slug: str, name: str })) }),
    ),
  },
  "post /v1/site/skills/registry/team": {
    body: named("RegistryTeamCreateBody", registryTeamCreateSchema),
    status: 201,
    response: RegistrySettings,
    errors: ["409"],
  },
  "get /v1/site/skills/registry/versions/{id}/export": {
    query: {
      format: {
        type: "string",
        enum: ["package", "portable", "portable_evals"],
        default: "package",
      },
    },
    produces: "application/zip",
    responseDescription: "The zip as an attachment; `X-Kobe-Sha256` carries its hash.",
    errors: ["404", "413", "422", "429", "503"],
  },
  "get /v1/site/skills/tags": {
    response: named("SiteTopicTagList", z.object({ tags: z.array(registryTagSchema) })),
  },
  "post /v1/site/skills/tags": {
    body: named("CreateTopicTagBody", createTopicTagSchema),
    status: 201,
    response: TopicTag,
    errors: ["409"],
  },
  "patch /v1/site/skills/tags/{id}": {
    body: named("UpdateTopicTagBody", updateTopicTagSchema),
    response: TopicTag,
    errors: ["404", "409"],
  },
};

/** Every operation of the "Site: skills" area. */
export const siteSkillsDetails: Readonly<Record<string, CatalogDetail>> = {
  ...baseDetails,
  ...siteSkillsReviewDetails,
  ...siteSkillsEditDetails,
};
