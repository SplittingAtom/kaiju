import { agentScope, SKILL_DRAFT_STARTS, skillSource } from "@kobe/db";
import {
  catalogSkillEvalScorecardSchema,
  kobeSkillManifestSchema,
  putMemberSkillAddSchema,
  REGISTRY_VERSION_STATES,
  SKILL_ACCESS_MODES,
  SKILL_EVAL_MODES,
  SKILL_PIN_MODES,
  skillEvalEstimateSchema,
  skillEvalRunModelSchema,
  skillEvalRunSchema,
  skillEvalStartedSchema,
  skillImportRequestSchema,
  startSkillEvalBodySchema,
} from "@kobe/protocol";
import { z } from "zod";
import { addSchema, reassignSchema } from "../../../routes/catalog-maintainers.js";
import { enablementSchema } from "../../../routes/me-skill-enablements.js";
import { querySchema as catalogQuerySchema } from "../../../routes/skill-catalog.js";
import {
  createSchema,
  forkSchema,
  fromWorkspaceSchema,
  manifestChoiceSchema,
  patchSchema,
  saveSchema,
} from "../../../routes/skill-drafts/shared.js";
import { manifestSchema, sourceSchema } from "../../../routes/skill-promotions.js";
import { accessSchema, offerSchema } from "../../../routes/skill-reach.js";
import { TEMPLATE_IDS } from "../../../skills/drafts/templates.js";
import { jsonSchemaOf, named, untyped, type CatalogDetail } from "../build.js";
import { arr, bool, dateTime, int, nullable, num, obj, oneOfStrings, str, uuid } from "../json.js";

/**
 * Request and response schemas of the Skills catalog area (KOBE-771): team and personal skills,
 * Workbench drafts, skill evals, the Site catalog as members see it, maintainers, Add for me and
 * Promote to Site. Bodies come from the zod schemas the routes validate with and the
 * `@kobe/protocol` contracts; `untyped(...)` marks answers the routes build without a schema
 * (fields read from `skill-json.ts`, `skill-drafts/shared.ts` and the helpers they call).
 */

type JsonSchema = Record<string, unknown>;

/** A JSON object stored as is (frontmatter, a draft's parent or import origin). */
const anyObject: JsonSchema = { type: "object" };
/** A count, or "few" under the catalog's minimum-count rule (KOBE-339). */
const shown: JsonSchema = { anyOf: [int, oneOfStrings("few")] };
const usageWindow = obj({ from: dateTime, to: dateTime });
const nameRef = obj({ id: uuid, name: str });
const packageFile = obj({ path: str, size: int });
const access = oneOfStrings(...SKILL_ACCESS_MODES);
const evalMode = oneOfStrings(...SKILL_EVAL_MODES);
const manifestJson = jsonSchemaOf(kobeSkillManifestSchema, "output");
const catalogScorecard = jsonSchemaOf(catalogSkillEvalScorecardSchema, "output");

// --- Skills (`routes/skill-json.ts`) ---

const skill = obj({
  id: uuid,
  scope: oneOfStrings("team", "personal"),
  slug: str,
  description: str,
  latestVersion: int,
  latestSemver: str,
  access: nullable(access),
  archivedAt: nullable(dateTime),
  ownerUserId: uuid,
  createdAt: dateTime,
  updatedAt: dateTime,
});
const skillVersion = obj({
  version: int,
  seq: int,
  semver: str,
  changelog: nullable(str),
  packageHash: nullable(str),
  frontmatter: anyObject,
  source: oneOfStrings(...skillSource.enumValues),
  contentHash: str,
  sizeBytes: int,
  fileCount: int,
  uncompressedBytes: int,
  uploadedBy: uuid,
  uploadedAt: dateTime,
  /** A team version's review; null for a personal one. */
  review: nullable(obj({ status: str, flagged: bool })),
});
const SkillWithVersion = untyped("SkillWithVersion", obj({ skill, version: skillVersion }));

// --- Drafts (`routes/skill-drafts/shared.ts`) ---

const draft = obj({
  id: uuid,
  name: str,
  shared: bool,
  mine: bool,
  ownerUserId: uuid,
  startedFrom: oneOfStrings(...SKILL_DRAFT_STARTS),
  parentRef: nullable(anyObject),
  origin: nullable(anyObject),
  fromConversation: bool,
  coEdited: bool,
  rev: int,
  sizeBytes: int,
  fileCount: int,
  createdAt: dateTime,
  updatedAt: dateTime,
  updatedBy: uuid,
});
const draftFile = obj({
  path: str,
  size: int,
  kind: oneOfStrings("text", "binary"),
  updatedAt: dateTime,
});
const SkillDraftEnvelope = untyped("SkillDraftEnvelope", obj({ draft }));
const SkillDraftChange = untyped("SkillDraftChange", obj({ rev: int, draft }));
const manifestModelAnswer = {
  manifest: manifestJson,
  /** The model alias that answered. */
  model: str,
  source: oneOfStrings("model", "seed"),
};

/** `@kobe/skill-scanner` Finding (its category and severity unions, as written there). */
const scanFinding = obj({
  category: oneOfStrings(
    "network",
    "pipe-to-shell",
    "package-install",
    "obfuscation",
    "secret",
    "file-type",
    "prose",
    "limit",
  ),
  file: str,
  line: int,
  excerpt: str,
  rule: str,
  severity: oneOfStrings("caution", "block"),
});
const verdict = oneOfStrings("pass", "caution", "block");

// --- Evals (`@kobe/protocol` skill-evals `api.ts`) ---

const SkillEvalRun = named("SkillEvalRun", skillEvalRunSchema);
const SkillEvalStarted = named("SkillEvalStarted", skillEvalStartedSchema);
const SkillEvalEstimateAnswer = named(
  "SkillEvalEstimateAnswer",
  z.object({
    estimate: skillEvalEstimateSchema,
    runModel: skillEvalRunModelSchema,
    /** Why a Run would be refused now (shown before the click); null when it would start. */
    blocked: z.object({ code: z.string(), message: z.string() }).nullable(),
  }),
);
const evalModeQuery = {
  mode: { ...evalMode, default: "full", description: "The run mode to estimate." },
};
const RUN_VIEW_NOTE =
  "Cost fields are left out, and `costsHidden: true` added, for anyone but the run's starter and Team admins.";

// --- Catalog (`skills/catalog-browse.ts`) ---

const catalogCard = {
  id: uuid,
  name: str,
  summary: str,
  publisher: str,
  status: str,
  topics: arr(str),
  latest: obj({ versionId: uuid, semver: str, verdict: str, approvedAt: nullable(dateTime) }),
  score: nullable(obj({ passRate: nullable(num), lift: nullable(num), cases: nullable(num) })),
  teamsInstalled: shown,
  usage: obj({ members: shown, thumbsUp: shown }),
  state: obj({
    installed: nullable(obj({ semver: nullable(str), pinMode: str, access: str })),
    addedByMe: bool,
    myAdd: nullable(obj({ semver: str, pinMode: str })),
    blocked: bool,
  }),
};
const maintainer = obj({
  userId: uuid,
  name: str,
  email: str,
  deactivated: bool,
  addedAt: dateTime,
});
const InstallRequested = untyped(
  "CatalogSkillInstallRequested",
  obj({ requested: { type: "boolean", const: true }, alreadyRequested: bool }),
);
const MaintainerList = untyped("CatalogSkillMaintainerList", obj({ maintainers: arr(maintainer) }));

// --- Promotions (`routes/skill-promotions.ts` planJson) ---

const promotionPlan = obj({
  name: str,
  semver: str,
  packageHash: str,
  files: arr(packageFile),
  fixtures: arr(packageFile),
  fromConversation: bool,
  newSkill: bool,
  scorecard: nullable(catalogScorecard),
  verdict,
  refusals: arr(obj({ code: str, message: str })),
});

const formatQuery = {
  format: {
    type: "string",
    enum: ["portable", "portable_evals"],
    description: "`portable` (SKILL.md and its files) or `portable_evals` (with `evals/`).",
  },
};
const ZIP_EXPORT =
  "A deterministic zip attachment; its SHA-256 is in the `X-Kobe-Sha256` header (pin it on import).";

const meDetails: Readonly<Record<string, CatalogDetail>> = {
  "get /v1/me/skill-submissions": {
    teamScoped: false,
    response: untyped(
      "SkillSubmissionList",
      obj({
        submissions: arr(
          obj({
            id: uuid,
            name: str,
            semver: str,
            state: oneOfStrings(...REGISTRY_VERSION_STATES),
            submittedAt: dateTime,
            updatedAt: dateTime,
            selfApproved: bool,
            notes: arr(obj({ action: str, note: str, at: dateTime })),
          }),
        ),
      }),
    ),
  },
  "post /v1/me/skill-submissions/{id}/retract": {
    teamScoped: false,
    body: null,
    response: untyped(
      "SkillSubmissionRetracted",
      obj({ id: uuid, state: oneOfStrings("retracted") }),
    ),
    errors: ["404", "409"],
  },
  "get /v1/me/skills/adds": {
    response: untyped(
      "MemberSkillAddList",
      obj({
        adds: arr(
          obj({
            skillId: uuid,
            name: str,
            semver: str,
            pinMode: oneOfStrings(...SKILL_PIN_MODES),
            runs: nullable(str),
            retirement: nullable(
              obj({
                kind: oneOfStrings("revoked", "withdrawn", "deprecated", "suspended"),
                semver: str,
                replacement: nullable(nameRef),
              }),
            ),
            updatedAt: dateTime,
          }),
        ),
      }),
    ),
  },
  "delete /v1/me/skills/adds/{skillId}": {
    response: untyped("MemberSkillAddRemoved", obj({ removed: { type: "boolean", const: true } })),
    errors: ["404"],
  },
  "put /v1/me/skills/adds/{skillId}": {
    body: named("PutMemberSkillAdd", putMemberSkillAddSchema),
    response: untyped(
      "MemberSkillAdded",
      obj({ semver: str, pinMode: oneOfStrings(...SKILL_PIN_MODES), runs: nullable(str) }),
    ),
    errors: ["404", "409"],
  },
  "get /v1/me/skills/enablements": {
    response: untyped(
      "MemberSkillChoices",
      obj({
        personal: arr(obj({ skillId: uuid, name: str, enabled: bool })),
        team: arr(obj({ skillId: uuid, name: str, access, enabled: bool })),
        catalog: arr(obj({ skillId: uuid, name: str, access, enabled: bool })),
      }),
    ),
  },
  "put /v1/me/skills/enablements": {
    body: named("MemberSkillEnablementBody", enablementSchema),
    response: untyped("MemberSkillEnablement", obj({ enabled: bool })),
    errors: ["404", "409"],
  },
};

const evalDetails: Readonly<Record<string, CatalogDetail>> = {
  "get /v1/skill-evals": {
    query: {
      draft_id: { ...uuid, description: "The draft's runs." },
      scope: { ...oneOfStrings("team", "personal"), description: "With `skill_id`." },
      skill_id: { ...uuid, description: "A saved skill's runs (with `scope`)." },
    },
    response: named("SkillEvalRunList", z.object({ evals: z.array(skillEvalRunSchema) })),
    responseDescription: RUN_VIEW_NOTE,
  },
  "get /v1/skill-evals/{id}": {
    response: SkillEvalRun,
    responseDescription: RUN_VIEW_NOTE,
    errors: ["404"],
  },
  "post /v1/skill-evals/{id}/cancel": {
    body: null,
    status: 202,
    response: SkillEvalRun,
    responseDescription: `The cancel is accepted; the run as it stands. ${RUN_VIEW_NOTE}`,
    errors: ["404", "409"],
  },
  "get /v1/skill-evals/{id}/events": {
    produces: "text/event-stream",
    responseDescription: "`skill.eval.progress` and `skill.eval.completed` events.",
    otherSuccess: {
      "204": { description: "A finished eval's reconnect (with `Last-Event-ID`): stop listening." },
    },
    errors: ["404", "429"],
  },
  "post /v1/skills/{scope}/{id}/versions/{seq}/evals": {
    body: named("StartSkillEvalBody", startSkillEvalBodySchema),
    status: 202,
    response: SkillEvalStarted,
    errors: ["404", "409", "422", "503"],
  },
  "get /v1/skills/{scope}/{id}/versions/{seq}/evals/estimate": {
    query: evalModeQuery,
    response: SkillEvalEstimateAnswer,
    errors: ["404", "409", "422", "503"],
  },
  "post /v1/skills/drafts/{id}/evals": {
    body: named("StartSkillEvalBody", startSkillEvalBodySchema),
    status: 202,
    response: SkillEvalStarted,
    errors: ["404", "409", "422", "503"],
  },
  "get /v1/skills/drafts/{id}/evals/estimate": {
    query: evalModeQuery,
    response: SkillEvalEstimateAnswer,
    errors: ["404", "409", "422", "503"],
  },
};

const skillDetails: Readonly<Record<string, CatalogDetail>> = {
  "get /v1/skills": {
    query: {
      scope: {
        ...oneOfStrings("team", "personal"),
        description: "Only the team's or only my personal skills (default both).",
      },
    },
    response: untyped("SkillList", obj({ skills: arr(skill) })),
  },
  "post /v1/skills": {
    body: null,
    rawBody: [
      "application/zip",
      "application/x-zip-compressed",
      "application/octet-stream",
      "text/markdown",
      "text/x-markdown",
      "text/plain",
    ],
    multipart: {
      bundle: { type: "string", format: "binary", description: "The zip or SKILL.md." },
      semver: { ...str, description: "The version number (MAJOR.MINOR.PATCH)." },
      changelog: { ...str, description: "One changelog line (form field only)." },
    },
    query: {
      scope: oneOfStrings("team", "personal"),
      semver: {
        ...str,
        description: "The version number (MAJOR.MINOR.PATCH); default the next minor.",
      },
    },
    requiredQuery: ["scope"],
    status: 201,
    response: SkillWithVersion,
    responseDescription: "The skill and its new version; a team version starts pending review.",
    errors: ["409", "413", "415", "422", "429", "503"],
  },
  "get /v1/skills/{id}": {
    response: untyped("SkillEnvelope", obj({ skill })),
    errors: ["404"],
  },
  "put /v1/skills/{id}/access": {
    body: named("SetSkillAccessBody", accessSchema),
    response: untyped(
      "SkillAccessSet",
      obj({ access, requiredCount: int, "warning?": oneOfStrings("many_required") }),
    ),
    errors: ["404", "409"],
  },
  "put /v1/skills/{id}/offer": {
    body: named("SetSkillOfferBody", offerSchema),
    response: untyped("SkillOfferSet", obj({ offerToAll: bool })),
    errors: ["404", "409"],
  },
  "get /v1/skills/{id}/reach": {
    response: untyped(
      "SkillReach",
      obj({
        offerToAll: bool,
        access,
        approved: bool,
        agents: arr(
          obj({
            id: uuid,
            scope: oneOfStrings(...agentScope.enumValues),
            slug: str,
            name: str,
            via: nullable(oneOfStrings("named", "offer")),
            exclusive: bool,
            inDraft: bool,
            canEdit: bool,
          }),
        ),
      }),
    ),
    errors: ["404"],
  },
  "get /v1/skills/{id}/usage": {
    response: untyped(
      "SkillUsage",
      obj({
        uses: int,
        lastUsedAt: nullable(dateTime),
        agents: arr(
          obj({
            agentId: nullable(uuid),
            scope: nullable(oneOfStrings(...agentScope.enumValues)),
            name: nullable(str),
            uses: int,
          }),
        ),
      }),
    ),
    responseDescription: "An agent the caller can't see is counted without its id, scope or name.",
    errors: ["404"],
  },
  "get /v1/skills/{id}/versions": {
    response: untyped("SkillVersionList", obj({ versions: arr(skillVersion) })),
    errors: ["404"],
  },
  "get /v1/skills/{id}/versions/{version}": {
    response: SkillWithVersion,
    errors: ["404"],
  },
  "get /v1/skills/{id}/versions/{version}/bundle": {
    produces: "application/zip",
    responseDescription: "The version's stored zip as an attachment.",
    errors: ["404", "422", "503"],
  },
  "get /v1/skills/{id}/versions/{version}/export": {
    query: formatQuery,
    requiredQuery: ["format"],
    produces: "application/zip",
    responseDescription: ZIP_EXPORT,
    errors: ["404", "409", "413", "422", "429", "503"],
  },
};

const catalogDetails: Readonly<Record<string, CatalogDetail>> = {
  "get /v1/skills/catalog": {
    query: catalogQuerySchema,
    response: untyped(
      "CatalogSkillPage",
      obj({
        skills: arr(obj(catalogCard)),
        tags: arr(str),
        membersMayAdd: bool,
        usageWindow,
      }),
    ),
  },
  "get /v1/skills/catalog/{skillId}": {
    response: untyped(
      "CatalogSkillDetail",
      obj({
        ...catalogCard,
        skillMd: nullable(str),
        files: arr(packageFile),
        versions: arr(
          obj({
            id: uuid,
            semver: str,
            state: str,
            approvedAt: nullable(dateTime),
            changelog: nullable(str),
            verdict: str,
          }),
        ),
        authoritativeScorecard: nullable(catalogScorecard),
        license: nullable(str),
        egress: arr(obj({ host: str, enabledHere: bool, inCeiling: bool })),
        packages: anyObject,
        maintainers: arr(str),
        agents: arr(nameRef),
        canRequestEgress: bool,
        membersMayAdd: bool,
        canBlock: bool,
        replacement: nullable(nameRef),
        canDeprecate: bool,
        usageWindow,
      }),
    ),
    errors: ["404"],
  },
  "get /v1/skills/catalog/{skillId}/maintainers": {
    teamScoped: false,
    response: MaintainerList,
    errors: ["404"],
  },
  "post /v1/skills/catalog/{skillId}/maintainers": {
    teamScoped: false,
    body: named("AddCatalogSkillMaintainerBody", addSchema),
    response: MaintainerList,
    errors: ["404", "409"],
  },
  "put /v1/skills/catalog/{skillId}/maintainers": {
    teamScoped: false,
    body: named("ReassignCatalogSkillMaintainersBody", reassignSchema),
    response: MaintainerList,
    errors: ["404", "409"],
  },
  "delete /v1/skills/catalog/{skillId}/maintainers/{userId}": {
    teamScoped: false,
    response: MaintainerList,
    errors: ["404", "409"],
  },
  "post /v1/skills/catalog/{skillId}/request": {
    body: null,
    status: 202,
    response: InstallRequested,
    responseDescription: "Requested; the Team admins are emailed.",
    otherSuccess: {
      "200": {
        response: InstallRequested,
        description: "Already requested (`alreadyRequested: true`); nobody is emailed again.",
      },
    },
    errors: ["404", "409", "429"],
  },
  "get /v1/skills/catalog/{skillId}/usage": {
    teamScoped: false,
    response: untyped(
      "CatalogSkillUsage",
      obj({
        totals: obj({
          teamsInstalled: shown,
          members: shown,
          runs: shown,
          thumbsUp: shown,
          optOuts: shown,
        }),
        /** Published versions, newest first, then "other". */
        versions: arr(str),
        perVersion: obj({
          teamsRunning: nullable(arr(shown)),
          members: nullable(arr(shown)),
          runs: nullable(arr(shown)),
          thumbsUp: nullable(arr(shown)),
        }),
        window: usageWindow,
        refreshedAt: dateTime,
      }),
    ),
    responseDescription:
      "The last 30 finished UTC days; any query parameter is refused (400). `perVersion` columns are null when withheld.",
    errors: ["404"],
  },
  "get /v1/skills/catalog/{skillId}/versions/{semver}/export": {
    query: formatQuery,
    requiredQuery: ["format"],
    produces: "application/zip",
    responseDescription: ZIP_EXPORT,
    errors: ["404", "413", "422", "429", "503"],
  },
};

const draftDetails: Readonly<Record<string, CatalogDetail>> = {
  "get /v1/skills/drafts": {
    query: { cursor: { ...str, description: "`next` from the previous page." } },
    response: untyped("SkillDraftList", obj({ drafts: arr(draft), next: nullable(str) })),
  },
  "post /v1/skills/drafts": {
    body: named("CreateSkillDraftBody", createSchema),
    status: 201,
    response: SkillDraftEnvelope,
    errors: ["409", "413", "422"],
  },
  "delete /v1/skills/drafts/{id}": { status: 204, errors: ["404"] },
  "get /v1/skills/drafts/{id}": {
    response: untyped("SkillDraftDetail", obj({ draft, files: arr(draftFile) })),
    responseDescription: "The draft and its files; the `ETag` header is the draft's revision.",
    errors: ["404"],
  },
  "patch /v1/skills/drafts/{id}": {
    body: named("PatchSkillDraftBody", patchSchema),
    response: SkillDraftEnvelope,
    responseDescription: "Under `If-Match: <rev>`; a stale revision is 409 with who changed it.",
    errors: ["404", "409", "428"],
  },
  "get /v1/skills/drafts/{id}/bump": {
    query: { destination: oneOfStrings("team", "personal") },
    requiredQuery: ["destination"],
    response: untyped(
      "SkillDraftBump",
      obj({
        rev: int,
        latest: nullable(obj({ skillId: uuid, semver: str })),
        kind: nullable(oneOfStrings("major", "minor", "patch")),
        suggested: nullable(str),
        reasons: arr(str),
      }),
    ),
    errors: ["404", "429", "503"],
  },
  "delete /v1/skills/drafts/{id}/files/{path}": {
    response: SkillDraftChange,
    responseDescription: "Under `If-Match: <rev>`; the new revision.",
    errors: ["404", "409", "428", "429"],
  },
  "get /v1/skills/drafts/{id}/files/{path}": {
    produces: "application/octet-stream",
    responseDescription:
      "The file's bytes: `text/plain; charset=utf-8` for a text file, `application/octet-stream` otherwise.",
    errors: ["404"],
  },
  "put /v1/skills/drafts/{id}/files/{path}": {
    body: null,
    rawBody: ["application/octet-stream"],
    response: SkillDraftChange,
    responseDescription: "The file's raw bytes, under `If-Match: <rev>`; the new revision.",
    errors: ["404", "409", "413", "422", "428", "429"],
  },
  "post /v1/skills/drafts/{id}/manifest": {
    body: named("SkillDraftManifestBody", manifestChoiceSchema),
    bodyOptional: true,
    status: 201,
    response: untyped(
      "SkillDraftManifestCreated",
      obj({ rev: int, draft, ...manifestModelAnswer }),
    ),
    responseDescription: "Under `If-Match: <rev>`. The version number inside is a placeholder.",
    errors: ["404", "409", "413", "422", "428", "429", "502", "503"],
  },
  "get /v1/skills/drafts/{id}/scan": {
    response: untyped(
      "SkillDraftScan",
      obj({
        rev: int,
        verdict,
        findings: arr(scanFinding),
        scripts: arr(str),
        skipped: arr(str),
        ruleSetVersion: str,
      }),
    ),
    errors: ["404", "422", "429", "503"],
  },
  "post /v1/skills/drafts/{id}/versions": {
    body: named("SaveSkillDraftVersionBody", saveSchema),
    status: 201,
    response: SkillWithVersion,
    responseDescription:
      "Under `If-Match: <rev>` (the revision the author saw). A team version starts pending review.",
    errors: ["404", "409", "413", "428", "429", "503"],
  },
  "post /v1/skills/drafts/fork": {
    body: named("ForkSkillDraftBody", forkSchema),
    status: 201,
    response: SkillDraftEnvelope,
    errors: ["404", "409", "413", "422", "429", "503"],
  },
  "post /v1/skills/drafts/from-workspace": {
    body: named("SkillDraftFromWorkspaceBody", fromWorkspaceSchema),
    status: 201,
    response: SkillDraftEnvelope,
    responseDescription: "A new draft.",
    otherSuccess: {
      "200": {
        response: untyped(
          "SkillDraftFromWorkspace",
          obj({ draft, created: { type: "boolean", const: false } }),
        ),
        description: "The folder was saved into the existing draft it saves into.",
      },
    },
    errors: ["404", "409", "413", "422", "429", "503"],
  },
  "post /v1/skills/drafts/import": {
    body: named("SkillImportRequest", skillImportRequestSchema),
    status: 201,
    response: SkillDraftEnvelope,
    errors: ["409", "413", "422", "429", "503"],
  },
  "get /v1/skills/drafts/saves": {
    query: { threadId: { ...uuid, description: "The conversation." } },
    requiredQuery: ["threadId"],
    response: untyped(
      "SkillDraftSaveList",
      obj({
        saves: arr(
          obj({
            toolCallId: str,
            draftId: uuid,
            name: str,
            created: bool,
            "newBecause?": oneOfStrings("shared", "edited"),
          }),
        ),
      }),
    ),
    errors: ["404"],
  },
  "get /v1/skills/drafts/templates": {
    response: untyped(
      "SkillDraftTemplateList",
      obj({ templates: arr(obj({ id: oneOfStrings(...TEMPLATE_IDS), title: str, summary: str })) }),
    ),
  },
  "post /v1/skills/drafts/upload": {
    body: null,
    rawBody: ["application/zip", "text/markdown", "application/octet-stream"],
    query: { kind: oneOfStrings("zip", "skill_md") },
    requiredQuery: ["kind"],
    status: 201,
    response: SkillDraftEnvelope,
    responseDescription: "The bytes are read as `kind` says, whatever the content type.",
    errors: ["409", "413", "422", "429"],
  },
};

const promotionDetails: Readonly<Record<string, CatalogDetail>> = {
  "post /v1/skills/promotions": {
    body: named("PromoteSkillBody", sourceSchema),
    status: 201,
    response: untyped(
      "SkillPromotionSubmitted",
      obj({ state: oneOfStrings("submitted"), registryVersionId: uuid }),
    ),
    responseDescription: "Submitted to the Site Registry.",
    otherSuccess: {
      "202": {
        response: untyped(
          "SkillPromotionRequested",
          obj({ state: oneOfStrings("requested"), requestId: uuid }),
        ),
        description: "Queued for a Team admin to confirm.",
      },
    },
    errors: ["404", "409", "422", "503"],
  },
  "post /v1/skills/promotions/manifest": {
    body: named("PromotionManifestBody", manifestSchema),
    status: 201,
    response: untyped("PromotionManifestCreated", obj({ draft, ...manifestModelAnswer })),
    errors: ["404", "409", "413", "422", "429", "502", "503"],
  },
  "get /v1/skills/promotions/preview": {
    query: sourceSchema,
    response: untyped("SkillPromotionPreview", promotionPlan),
    errors: ["404", "409", "503"],
  },
};

export const skillsDetails: Readonly<Record<string, CatalogDetail>> = {
  ...meDetails,
  ...evalDetails,
  ...skillDetails,
  ...catalogDetails,
  ...draftDetails,
  ...promotionDetails,
};
