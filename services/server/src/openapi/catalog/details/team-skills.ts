import {
  catalogSkillEvalScorecardSchema,
  putTeamSkillInstallSchema,
  SCAN_VERDICTS,
  SKILL_PIN_MODES,
  teamEvalCapSchema,
  teamSkillInstallSchema,
  uninstallSkillSchema,
} from "@kaiju/protocol";
import { z } from "zod";
import { declineSchema } from "../../../routes/skill-promotions.js";
import { decisionSchema, settingsSchema } from "../../../routes/team-skill-review.js";
import { semverSchema } from "../../../skills/semver.js";
import { named, untyped, type CatalogDetail } from "../build.js";
import { arr, bool, dateTime, int, nullable, num, obj, oneOfStrings, str, uuid } from "../json.js";

/**
 * Request and response schemas of the "Team: skills" catalog area (KOBE-771): review queue and
 * switches, catalog installs, blocks, install requests, member adds, usage and Promote to Site
 * requests. Bodies come from the zod schemas the routes validate with; answers the routes build
 * without a schema are `untyped(...)` (fields read from the handlers and their helpers).
 */

type JsonSchema = Record<string, unknown>;

const RETIREMENT_KINDS = ["revoked", "withdrawn", "deprecated", "suspended"] as const;
const retirementZod = z
  .strictObject({
    kind: z.enum(RETIREMENT_KINDS),
    semver: z.string(),
    replacement: z.strictObject({ id: z.string(), name: z.string() }).nullable(),
  })
  .nullable();
const retirementJson = nullable(
  obj({
    kind: oneOfStrings(...RETIREMENT_KINDS),
    semver: str,
    replacement: nullable(obj({ id: uuid, name: str })),
  }),
);

/** A count, or "few" under the minimum-count rule. */
const shown: JsonSchema = { anyOf: [int, oneOfStrings("few")] };
const thumbs: JsonSchema = {
  oneOf: [
    obj({ enough: { type: "boolean", const: true }, up: int, down: int }),
    obj({ enough: { type: "boolean", const: false } }),
  ],
};

// --- Review queue and switches (`routes/team-skill-review.ts`) ---

const storedFinding = obj({
  category: str,
  rule: str,
  file: str,
  line: int,
  excerpt: str,
  "severity?": str,
});
const review = obj({
  skillId: uuid,
  slug: str,
  version: int,
  semver: str,
  contentHash: str,
  scope: oneOfStrings("team", "personal"),
  unscanned: bool,
  status: oneOfStrings("pending", "approved", "rejected"),
  flagged: bool,
  verdict: oneOfStrings(...SCAN_VERDICTS),
  findingsDigest: str,
  findings: arr(storedFinding),
  scripts: arr(str),
  skipped: arr(str),
  scannedAt: dateTime,
  blocked: bool,
  suspended: bool,
  reviewedBy: nullable(uuid),
  reviewedAt: nullable(dateTime),
  reviewNote: nullable(str),
});
const Settings = named(
  "TeamSkillSettings",
  z.object({
    personalSkillsDisabled: z.boolean(),
    membersMayAddCatalog: z.boolean(),
    buildersMayInstallCatalog: z.boolean(),
    buildersMayPromote: z.boolean(),
    evalJudgeAlias: z.string().nullable(),
    evalCap: teamEvalCapSchema,
  }),
);

// --- Installs (`routes/team-skill-installs.ts`) ---

const skillInstallResult = untyped(
  "TeamSkillInstallResult",
  obj({
    semver: str,
    pinMode: oneOfStrings(...SKILL_PIN_MODES),
    deprecated: bool,
    requiredCount: int,
    "warning?": oneOfStrings("many_required"),
  }),
);
const skillInstallList = named(
  "TeamSkillInstallList",
  z.object({
    installs: z.array(
      teamSkillInstallSchema.extend({
        pinnedBy: z.enum(["rollback", "move"]).nullable(),
        retirement: retirementZod,
      }),
    ),
    removedDefaults: z.array(
      z.object({
        skillId: z.string(),
        name: z.string(),
        optedOutBy: z.string(),
        reason: z.string().nullable(),
        at: z.string(),
      }),
    ),
  }),
);
const versionRef = obj({ versionId: uuid, semver: str });
const cardScore = obj({ passRate: nullable(num), lift: nullable(num), cases: nullable(num) });
const skillInstallUpdates = untyped(
  "TeamSkillInstallUpdates",
  obj({
    skillId: uuid,
    name: str,
    pinMode: oneOfStrings(...SKILL_PIN_MODES),
    pinned: versionRef,
    running: nullable(versionRef),
    updates: arr(
      obj({
        versionId: uuid,
        semver: str,
        changelog: nullable(str),
        deprecated: bool,
        major: bool,
        automatic: bool,
        evalDelta: obj({ passRate: nullable(num), lift: nullable(num) }),
        score: nullable(cardScore),
      }),
    ),
    rollbackTo: nullable(str),
  }),
);
const hunk = obj({ oldStart: int, oldLines: int, newStart: int, newLines: int, lines: arr(str) });
const skillInstallDiff = untyped(
  "TeamSkillInstallDiff",
  obj({
    files: arr(
      obj({
        path: str,
        status: oneOfStrings("added", "removed", "changed", "unchanged"),
        size: int,
        binary: bool,
        "notUtf8?": { type: "boolean", const: true },
        "notDiffed?": oneOfStrings("too_large", "too_different", "skipped"),
        hunks: arr(hunk),
      }),
    ),
    changedFiles: int,
    truncated: bool,
  }),
);

// --- Usage (`routes/skill-usage.ts`) ---

const usage = untyped(
  "TeamSkillUsage",
  obj({
    skills: arr(
      obj({
        skillId: uuid,
        name: str,
        runs: shown,
        members: shown,
        thumbs,
        versions: nullable(arr(obj({ semver: str, runs: shown, members: shown }))),
        versionThumbs: nullable(arr(obj({ semver: str, thumbs }))),
      }),
    ),
    window: obj({ from: dateTime, to: dateTime }),
    refreshedAt: dateTime,
  }),
);

// --- Promote to Site requests (`routes/skill-promotions.ts`) ---

const pendingRequestZod = z.object({
  id: z.string(),
  skillId: z.string(),
  version: z.number().int(),
  semver: z.string(),
  requestedBy: z.string(),
  createdAt: z.string(),
});
const packageFile = z.object({ path: z.string(), size: z.number().int() });
const promotionPreview = named(
  "TeamSkillPromotionPreview",
  z.union([
    z.object({
      request: pendingRequestZod,
      name: z.string(),
      semver: z.string(),
      packageHash: z.string(),
      files: z.array(packageFile),
      fixtures: z.array(packageFile),
      fromConversation: z.boolean(),
      newSkill: z.boolean(),
      scorecard: catalogSkillEvalScorecardSchema.nullable(),
      verdict: z.enum(SCAN_VERDICTS),
      refusals: z.array(z.object({ code: z.string(), message: z.string() })),
    }),
    z.object({
      request: pendingRequestZod,
      code: z.enum(["not_found", "legacy"]),
      message: z.string(),
    }),
  ]),
);

export const teamSkillsDetails: Readonly<Record<string, CatalogDetail>> = {
  "get /v1/team/skill-promotions": {
    response: named(
      "TeamSkillPromotionRequestList",
      z.object({ requests: z.array(pendingRequestZod) }),
    ),
  },
  "get /v1/team/skill-promotions/{id}": {
    response: promotionPreview,
    responseDescription:
      "The request with what would leave the team, or the request with the reason it can no longer be prepared (`code`, `message`).",
    errors: ["404", "503"],
  },
  "post /v1/team/skill-promotions/{id}/confirm": {
    body: null,
    status: 201,
    response: untyped(
      "TeamSkillPromotionSubmitted",
      obj({ state: oneOfStrings("submitted"), registryVersionId: uuid }),
    ),
    responseDescription: "Submitted to the Site catalog; a 422 lists the Site rules it fails.",
    errors: ["404", "409", "422", "503"],
  },
  "post /v1/team/skill-promotions/{id}/decline": {
    body: named("DeclineSkillPromotionBody", declineSchema),
    response: untyped("TeamSkillPromotionDeclined", obj({ state: oneOfStrings("declined") })),
    errors: ["404", "409"],
  },
  "get /v1/team/skill-review": {
    query: {
      status: {
        type: "string",
        enum: ["pending", "approved", "rejected", "all"],
        description: "Which reviews to list (default `pending`).",
      },
      limit: { type: "integer", minimum: 1, maximum: 200, description: "Page size (1-200)." },
      cursor: { type: "string", description: "`nextCursor` from the previous page." },
    },
    response: untyped(
      "TeamSkillReviewList",
      obj({ reviews: arr(review), nextCursor: nullable(str) }),
    ),
  },
  "post /v1/team/skill-review/{skillId}/versions/{version}": {
    body: named("TeamSkillReviewDecisionBody", decisionSchema),
    response: untyped("TeamSkillReviewDecision", obj({ review })),
    errors: ["404", "409", "422"],
  },
  "get /v1/team/skill-review/settings": { response: Settings },
  "put /v1/team/skill-review/settings": {
    body: named("TeamSkillSettingsBody", settingsSchema),
    response: Settings,
    errors: ["422"],
  },
  "get /v1/team/skills/blocks": {
    response: untyped(
      "TeamSkillBlockList",
      obj({
        blocks: arr(
          obj({ skillId: uuid, name: str, blockedBy: uuid, blockedByName: str, at: dateTime }),
        ),
      }),
    ),
  },
  "delete /v1/team/skills/blocks/{skillId}": {
    response: untyped("TeamSkillUnblocked", obj({ blocked: { type: "boolean", const: false } })),
    errors: ["404"],
  },
  "put /v1/team/skills/blocks/{skillId}": {
    body: null,
    response: untyped(
      "TeamSkillBlocked",
      obj({ blocked: { type: "boolean", const: true }, changed: bool, addsRemoved: int }),
    ),
    responseDescription: "Blocked; members' adds of it are removed. 409 `installed` if installed.",
    errors: ["404", "409"],
  },
  "get /v1/team/skills/install-requests": {
    response: untyped(
      "TeamSkillInstallRequestList",
      obj({
        requests: arr(
          obj({
            skillId: uuid,
            name: str,
            requesters: arr(obj({ userId: uuid, name: str })),
            count: int,
            lastAt: dateTime,
            installed: nullable(str),
          }),
        ),
      }),
    ),
  },
  "post /v1/team/skills/install-requests/{skillId}/dismiss": {
    body: null,
    response: untyped(
      "TeamSkillInstallRequestsDismissed",
      obj({ dismissed: { type: "boolean", const: true } }),
    ),
    errors: ["404"],
  },
  "get /v1/team/skills/installs": { response: skillInstallList },
  "delete /v1/team/skills/installs/{skillId}": {
    body: named("UninstallSkillBody", uninstallSkillSchema),
    bodyOptional: true,
    response: untyped("TeamSkillUninstalled", obj({ optedOut: bool })),
    responseDescription:
      "Uninstalled; `optedOut` when it was a Default skill (later Default syncs skip it). The reason is kept with the opt-out.",
    errors: ["404"],
  },
  "put /v1/team/skills/installs/{skillId}": {
    body: named("TeamSkillInstallPutBody", putTeamSkillInstallSchema),
    response: skillInstallResult,
    errors: ["404", "409"],
  },
  "get /v1/team/skills/installs/{skillId}/diff": {
    query: { to: { type: "string", description: "The version (semver) to diff to." } },
    requiredQuery: ["to"],
    response: skillInstallDiff,
    errors: ["404", "503"],
  },
  "post /v1/team/skills/installs/{skillId}/move": {
    body: named("TeamSkillInstallMoveBody", z.strictObject({ version: semverSchema })),
    response: skillInstallResult,
    errors: ["404", "409"],
  },
  "post /v1/team/skills/installs/{skillId}/rollback": {
    body: null,
    response: skillInstallResult,
    errors: ["404", "409"],
  },
  "get /v1/team/skills/installs/{skillId}/updates": {
    response: skillInstallUpdates,
    errors: ["404"],
  },
  "get /v1/team/skills/member-adds": {
    response: untyped(
      "TeamSkillMemberAddList",
      obj({
        adds: arr(
          obj({
            userId: uuid,
            memberName: str,
            skillId: uuid,
            name: str,
            semver: str,
            pinMode: oneOfStrings(...SKILL_PIN_MODES),
            runs: nullable(str),
            updatedAt: dateTime,
            retirement: retirementJson,
          }),
        ),
      }),
    ),
  },
  "post /v1/team/skills/removed-defaults/{skillId}/reinstall": {
    body: null,
    status: 201,
    response: untyped("TeamSkillDefaultReinstalled", obj({ semver: str })),
    errors: ["404", "409"],
  },
  "get /v1/team/skills/usage": {
    response: usage,
    responseDescription: "The last 30 finished UTC days; any query parameter is refused (400).",
  },
};
