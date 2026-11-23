import { z } from "zod";
import { connectorExposure, SCHEDULE_PAUSED_BY } from "@kobe/db";
import {
  addProjectMemberRequestSchema,
  createProjectRequestSchema,
  importProjectFileRequestSchema,
  listProjectsQuerySchema,
  projectFileSchema,
  projectFilesResponseSchema,
  projectListResponseSchema,
  projectMemberSchema,
  projectMembersResponseSchema,
  projectSchema,
  transferOwnerRequestSchema,
  transferOwnerResponseSchema,
  updateProjectMemberRequestSchema,
  updateProjectRequestSchema,
  gitConversionAbandonedSchema,
  gitConversionAnswerSchema,
  repoCommitInfoSchema,
  gitConversionStartBodySchema,
  gitConversionStartedSchema,
} from "@kobe/protocol";
import { inventoryQuerySchema } from "../../../agents/inventory.js";
import { runnableQuerySchema } from "../../../agents/runnable.js";
import {
  agentMemoryBodySchema,
  agentStatusSchema,
  createMetaSchema,
  listQuerySchema,
  rollbackSchema,
  versionsQuerySchema,
} from "../../../agents/schemas.js";
import { bodySchema as galleryEvalBodySchema } from "../../../routes/site-gallery.js";
import { teamModelResponseSchema } from "../../models.js";
import { jsonSchemaOf, named, untyped, type CatalogDetail } from "../build.js";
import { arr, bool, dateTime, int, nullable, num, obj, oneOfStrings, str, uuid } from "../json.js";
import {
  AgentEvalStarted,
  AgentPublished,
  AgentSkillUpdates,
  AgentVersionDetail,
  AgentVersionList,
  AgentWithWarnings,
  agentDefinitionShape,
  agentDetailProps,
  agentEval,
  agentEvalWithReport,
  agentFrontmatter,
  agentSummary,
  agentSummaryProps,
  agentTransfer,
  agentWarnings,
  GalleryScoreList,
} from "./agent-shapes.js";

/**
 * Request and response schemas of the Projects, Agents and Site: gallery catalog areas
 * (KOBE-771). Projects come from the `@kobe/protocol` contracts (`projects.ts`,
 * `project-commits.ts`); agent bodies from `agents/schemas.ts` and the agent-file frontmatter
 * schema; agent answers are built by `agents/http.ts` without a schema (`agent-shapes.ts`).
 */

// ------------------------------------------------------------------------------------ Projects

const Project = named("Project", projectSchema);
const ProjectFile = named("ProjectFile", projectFileSchema);
const ProjectMember = named("ProjectMember", projectMemberSchema);

const Conversion = named("GitConversionStarted", gitConversionStartedSchema);
const conversionRefusals =
  "A refused start names its reason (`code`, `message`, and `path`/`paths`, `seq`, `checkouts`, `limit_bytes`/`size_bytes` where they apply): 409 `already_repo`, `conversion_in_progress`, `archived`, `legal_hold`, `unsaved_checkouts`, `connection_read_only`; 403 `git_disabled`, `host_not_allowed`, `existing_repository_admin_only` (only Workspace admins choose an existing repository); 404 `connection_not_found`; 422 `cannot_create_repositories`, `internal_not_offered`, `invalid_repository_name`, `file_rejected_by_host`, `file_too_large`, `project_too_large`; 503 `git_unavailable`.";

export const projectsDetails: Readonly<Record<string, CatalogDetail>> = {
  "get /v1/projects/{id}/repo-conversion": {
    response: named("GitConversionAnswer", gitConversionAnswerSchema),
    errors: ["404"],
  },
  "post /v1/projects/{id}/repo-conversion": {
    body: named("GitConversionStartBody", gitConversionStartBodySchema),
    status: 202,
    response: Conversion,
    responseDescription: `The attempt, running. ${conversionRefusals}`,
    errors: ["403", "404", "409", "413", "422", "429", "503"],
  },
  "post /v1/projects/{id}/repo-conversion/retry": {
    body: null,
    status: 202,
    response: Conversion,
    responseDescription:
      "The failed attempt, running again from its step. 409 `conversion_running` (not failed) or `legal_hold`; 404 `conversion_not_found`.",
    errors: ["403", "404", "409", "429"],
  },
  "get /v1/projects/{id}/repo-status": {
    response: named("RepoCommitInfo", repoCommitInfoSchema),
    errors: ["404"],
  },
  "post /v1/projects/{id}/repo-conversion/abandon": {
    body: null,
    response: named("GitConversionAbandoned", gitConversionAbandonedSchema),
    responseDescription:
      "The ended attempt and the repository left on the host, if the host created one for it. 409 `conversion_running`; 404 `conversion_not_found`.",
    errors: ["403", "404", "409"],
  },
  "get /v1/projects": {
    query: listProjectsQuerySchema,
    response: named("ProjectList", projectListResponseSchema),
  },
  "post /v1/projects": {
    body: named("CreateProjectBody", createProjectRequestSchema),
    status: 201,
    response: Project,
    responseDescription: "The new project; the caller is its owner.",
    errors: ["409", "422"],
  },
  "delete /v1/projects/{id}": { status: 204, errors: ["404", "409"] },
  "get /v1/projects/{id}": { response: Project, errors: ["404"] },
  "patch /v1/projects/{id}": {
    body: named("UpdateProjectBody", updateProjectRequestSchema),
    response: Project,
    errors: ["404", "409", "422"],
  },
  "get /v1/projects/{id}/files": {
    response: named("ProjectFileList", projectFilesResponseSchema),
    errors: ["404"],
  },
  "post /v1/projects/{id}/files": {
    body: null,
    multipart: {
      path: { type: "string", description: "Folder inside the project; absent or empty = root." },
      file: { type: "string", format: "binary", description: "The file (one part, after `path`)." },
    },
    status: 201,
    response: ProjectFile,
    responseDescription: "The stored file.",
    errors: ["404", "409", "411", "413", "415", "422", "503", "507"],
  },
  "delete /v1/projects/{id}/files/{file_id}": {
    status: 204,
    responseDescription: "Removed (the previous commit keeps the object). 409 under a legal hold.",
    errors: ["404", "409"],
  },
  "post /v1/projects/{id}/files/import": {
    body: named("ImportProjectFileBody", importProjectFileRequestSchema),
    status: 201,
    response: ProjectFile,
    responseDescription: "The copied file.",
    errors: ["404", "409", "413", "422", "503", "507"],
  },
  "get /v1/projects/{id}/members": {
    response: named("ProjectMemberList", projectMembersResponseSchema),
    errors: ["404"],
  },
  "post /v1/projects/{id}/members": {
    body: named("AddProjectMemberBody", addProjectMemberRequestSchema),
    status: 201,
    response: ProjectMember,
    errors: ["404", "409", "422"],
  },
  "delete /v1/projects/{id}/members/{user_id}": {
    status: 204,
    responseDescription: "Removed: the member is an implicit reader again.",
    errors: ["404", "409"],
  },
  "patch /v1/projects/{id}/members/{user_id}": {
    body: named("UpdateProjectMemberBody", updateProjectMemberRequestSchema),
    response: ProjectMember,
    errors: ["404", "409", "422"],
  },
  "post /v1/projects/{id}/owner": {
    body: named("TransferProjectOwnerBody", transferOwnerRequestSchema),
    response: named("TransferProjectOwnerResult", transferOwnerResponseSchema),
    errors: ["404", "409", "422"],
  },
  "get /v1/projects/no-owner": {
    query: {
      include_archived: { type: "string", enum: ["true", "false"], description: "Default false." },
    },
    response: named("ProjectList", projectListResponseSchema),
  },
};

// -------------------------------------------------------------------------------------- Agents

const AgentDraftBody = named("AgentDraftBody", z.strictObject(agentDefinitionShape));
const AgentStatusBody = named("AgentStatusBody", agentStatusSchema);
const AgentMemoryBody = named("AgentMemoryBody", agentMemoryBodySchema);
const AgentRollbackBody = named("AgentRollbackBody", rollbackSchema);

const PUBLISH_ERRORS = ["404", "409", "429"] as const;
/** Draft saves and publishes need `If-Match` with the agent's ETag (428 without, 412 stale). */
const IF_MATCH = ["412", "428"] as const;
const DRAFT_MEDIA = ["text/markdown", "text/x-markdown", "text/plain"];

const fromQuery = {
  from: {
    type: "string",
    enum: ["site"],
    description: "`site`: a roster read shows the site entry's version in effect.",
  },
};

const scoreStatus = oneOfStrings("none", "evaluating", "passed", "blocked", "errored");
const inventoryItem = obj({
  id: uuid,
  scope: oneOfStrings("team", "personal", "gallery"),
  slug: str,
  name: str,
  ownerUserId: nullable(uuid),
  ownerName: nullable(str),
  status: oneOfStrings("active", "suspended"),
  archivedAt: nullable(dateTime),
  currentVersion: nullable(int),
  versionCount: int,
  runCount: int,
  lastRunAt: nullable(dateTime),
  tokens: int,
  schedules: arr(
    obj({
      scheduleId: uuid,
      ownerUserId: uuid,
      ownerName: str,
      status: oneOfStrings("active", "paused"),
      pausedBy: nullable(oneOfStrings(...SCHEDULE_PAUSED_BY)),
      nextDueAt: nullable(dateTime),
    }),
  ),
  orbitScore: obj({
    status: scoreStatus,
    attackSuccessRate: nullable(num),
    at: nullable(dateTime),
  }),
  canExport: bool,
});

const runnableAgent = obj({
  id: uuid,
  scope: oneOfStrings("team", "personal", "gallery"),
  slug: str,
  "galleryKey?": str,
  "default?": { type: "boolean", enum: [true] },
  name: str,
  "description?": str,
  "icon?": str,
  model: nullable(str),
  starters: arr(str),
  currentVersion: int,
  "dangerous?": { type: "boolean", enum: [true] },
  group: oneOfStrings("personal", "team", "site"),
});

const AgentStatusChange = untyped(
  "AgentInventoryStatus",
  obj({
    id: uuid,
    scope: oneOfStrings("team", "personal", "gallery"),
    status: oneOfStrings("active", "suspended"),
  }),
);

export const agentsDetails: Readonly<Record<string, CatalogDetail>> = {
  "get /v1/agents": {
    query: listQuerySchema,
    response: untyped("AgentSummaryList", obj({ agents: arr(agentSummary) })),
  },
  "post /v1/agents": {
    body: named(
      "CreateAgentBody",
      z.strictObject({ ...agentDefinitionShape, ...createMetaSchema.shape }),
    ),
    rawBody: DRAFT_MEDIA,
    status: 201,
    response: AgentWithWarnings,
    responseDescription:
      "The new agent (ETag header set). An agent markdown file takes its meta from the query.",
    errors: ["409", "413", "415"],
  },
  "delete /v1/agents/{id}": {
    response: AgentWithWarnings,
    responseDescription: "Archived (it has published versions): the archived agent.",
    otherSuccess: { "204": { description: "Deleted: the agent was never published." } },
    errors: ["404", "409"],
  },
  "get /v1/agents/{id}": {
    query: fromQuery,
    response: untyped(
      "AgentRead",
      obj({
        agent: {
          anyOf: [obj({ ...agentDetailProps, "versionInEffect?": int }), agentSummary],
        },
        "warnings?": agentWarnings,
        "transfer?": nullable(agentTransfer),
      }),
    ),
    responseDescription:
      "With the draft when the caller may read the definition (ETag header set; the owner of a " +
      "personal agent also gets `transfer`); a roster read adds `versionInEffect`; otherwise the " +
      "summary only, and for the recipient of a pending transfer the summary with `transfer`.",
    errors: ["404"],
  },
  "put /v1/agents/{id}": {
    body: AgentDraftBody,
    rawBody: DRAFT_MEDIA,
    response: AgentWithWarnings,
    responseDescription: "The saved draft (new ETag).",
    errors: ["404", "409", "413", "415", ...IF_MATCH],
  },
  "get /v1/agents/{id}/evals": {
    response: untyped("AgentEvalList", obj({ evals: arr(agentEval), active: nullable(agentEval) })),
    errors: ["404"],
  },
  "get /v1/agents/{id}/evals/{evalId}": {
    response: untyped("AgentEvalDetail", obj({ eval: agentEvalWithReport })),
    errors: ["404"],
  },
  "get /v1/agents/{id}/export": {
    produces: "text/markdown",
    responseDescription: "The agent file as an attachment (`<slug>.md`).",
    errors: ["404"],
  },
  "post /v1/agents/{id}/memory": {
    body: AgentMemoryBody,
    status: 201,
    response: AgentPublished,
    responseDescription: "The new version carrying the setting.",
    errors: [...PUBLISH_ERRORS],
  },
  "post /v1/agents/{id}/publish": {
    body: null,
    status: 201,
    response: AgentPublished,
    responseDescription: "Published as a new version.",
    otherSuccess: {
      "202": {
        response: AgentEvalStarted,
        description: "The team's eval gate applies: published once its Orbit eval passes.",
      },
    },
    errors: [...PUBLISH_ERRORS, "422", "503", ...IF_MATCH],
  },
  "post /v1/agents/{id}/rollback": {
    body: AgentRollbackBody,
    status: 201,
    response: AgentPublished,
    responseDescription: "Republished as the newest version.",
    otherSuccess: {
      "202": {
        response: AgentEvalStarted,
        description: "The team's eval gate applies: republished once its Orbit eval passes.",
      },
    },
    errors: [...PUBLISH_ERRORS, "422", "503"],
  },
  "get /v1/agents/{id}/skill-updates": { response: AgentSkillUpdates, errors: ["404"] },
  "put /v1/agents/{id}/status": {
    body: AgentStatusBody,
    response: AgentWithWarnings,
    errors: ["404"],
  },
  "post /v1/agents/{id}/unarchive": { body: null, response: AgentWithWarnings, errors: ["404"] },
  "get /v1/agents/{id}/versions": {
    query: versionsQuerySchema,
    response: AgentVersionList,
    errors: ["404"],
  },
  "get /v1/agents/{id}/versions/{version}": { response: AgentVersionDetail, errors: ["404"] },
  "get /v1/agents/{id}/versions/{version}/orbit": {
    produces: "application/yaml",
    responseDescription: "The version as Orbit YAML (`<slug>-v<version>.orbit.yaml`).",
    errors: ["404", "409", "422"],
  },
  "get /v1/agents/gallery-scores": { response: GalleryScoreList },
  "get /v1/agents/inventory": {
    query: inventoryQuerySchema,
    response: untyped(
      "AgentInventoryPage",
      obj({ agents: arr(inventoryItem), nextCursor: nullable(str) }),
    ),
  },
  "put /v1/agents/inventory/{id}/status": {
    body: AgentStatusBody,
    response: AgentStatusChange,
    errors: ["404"],
  },
  "get /v1/agents/runnable": {
    query: runnableQuerySchema,
    response: untyped(
      "RunnableAgentPage",
      obj({ agents: arr(runnableAgent), nextCursor: nullable(str) }),
    ),
  },
};

// -------------------------------------------------------------------------------- Site: gallery

const galleryState = obj({
  key: nullable(str),
  generation: nullable(int),
  customized: bool,
  customizedAt: nullable(dateTime),
  customizedBy: nullable(uuid),
  customizedFromGeneration: nullable(int),
  updateAvailable: bool,
});

const GalleryAgent = untyped(
  "GalleryAgentWithWarnings",
  obj({
    agent: obj({ ...agentDetailProps, gallery: nullable(galleryState) }),
    warnings: agentWarnings,
  }),
);

const definitionSide = {
  frontmatter: agentFrontmatter,
  prompt: str,
  file: { type: "string", description: "The definition as an agent markdown file." },
};

const galleryTool = obj({
  pi_name: str,
  name: str,
  title: nullable(str),
  read_only: bool,
  open_world: bool,
  status: oneOfStrings("pinned", "drifted"),
  app: nullable(obj({ resource_uri: str, review: oneOfStrings("approved", "pending", "missing") })),
  model_visible: bool,
});

const galleryConnector = obj({
  id: uuid,
  name: str,
  auth_kind: oneOfStrings("oauth", "api_key", "none"),
  credential_source: oneOfStrings("member", "site"),
  site_key_ready: bool,
  status: oneOfStrings("active", "disabled"),
  icon_url: nullable(str),
  enabled: bool,
  exposure: nullable(oneOfStrings(...connectorExposure.enumValues)),
  enabled_tools: arr(str),
  tools: arr(galleryTool),
});

/** The site catalog as `TeamModels` items without the team's thinking fields; no default. */
const builderModels = jsonSchemaOf(
  z.strictObject({
    models: z.array(teamModelResponseSchema.omit({ thinking_max: true, thinking_in_team: true })),
    default: z.null(),
  }),
  "output",
);

export const siteGalleryDetails: Readonly<Record<string, CatalogDetail>> = {
  "get /v1/site/gallery/agents": {
    response: untyped(
      "GalleryAgentList",
      obj({
        agents: arr(obj({ ...agentSummaryProps, gallery: nullable(galleryState) })),
      }),
    ),
  },
  "get /v1/site/gallery/agents/{id}": { response: GalleryAgent, errors: ["404"] },
  "put /v1/site/gallery/agents/{id}": {
    body: AgentDraftBody,
    rawBody: DRAFT_MEDIA,
    response: GalleryAgent,
    responseDescription: "The saved draft; the agent is marked Customized.",
    errors: ["404", "409", "413", "415", ...IF_MATCH],
  },
  "get /v1/site/gallery/agents/{id}/compare": {
    response: untyped(
      "GalleryAgentComparison",
      obj({
        gallery: galleryState,
        repository: nullable(obj({ generation: int, ...definitionSide })),
        current: nullable(obj({ version: int, ...definitionSide })),
      }),
    ),
    errors: ["404"],
  },
  "post /v1/site/gallery/agents/{id}/eval": {
    body: named("GalleryEvalBody", galleryEvalBodySchema),
    status: 202,
    response: AgentEvalStarted,
    responseDescription: "Evaluating; the score appears in `/scores` when the eval finishes.",
    errors: ["404", "409", "422", "503"],
  },
  "get /v1/site/gallery/agents/{id}/export": {
    produces: "text/markdown",
    responseDescription: "The agent file as an attachment (`<slug>.md`).",
    errors: ["404"],
  },
  "post /v1/site/gallery/agents/{id}/memory": {
    body: AgentMemoryBody,
    status: 201,
    response: AgentPublished,
    errors: [...PUBLISH_ERRORS],
  },
  "post /v1/site/gallery/agents/{id}/publish": {
    body: null,
    status: 201,
    response: AgentPublished,
    responseDescription: "Published as a new version (never eval-gated).",
    errors: [...PUBLISH_ERRORS, ...IF_MATCH],
  },
  "post /v1/site/gallery/agents/{id}/reset": {
    body: null,
    response: GalleryAgent,
    responseDescription:
      "Re-attached to the repository definition (seeded now as a new version when it can be). " +
      "409 `not_customized` when it already follows it, `agent_archived` when archived.",
    errors: ["404", "409"],
  },
  "post /v1/site/gallery/agents/{id}/rollback": {
    body: AgentRollbackBody,
    status: 201,
    response: AgentPublished,
    errors: [...PUBLISH_ERRORS],
  },
  "get /v1/site/gallery/agents/{id}/skill-updates": {
    response: AgentSkillUpdates,
    responseDescription: "Gallery agents freeze no skills: `skills` is always empty.",
    errors: ["404"],
  },
  "get /v1/site/gallery/agents/{id}/versions": {
    query: versionsQuerySchema,
    response: AgentVersionList,
    responseDescription: "As for team agents; `score` is always null (gallery scores: `/scores`).",
    errors: ["404"],
  },
  "get /v1/site/gallery/agents/{id}/versions/{version}": {
    response: AgentVersionDetail,
    errors: ["404"],
  },
  "get /v1/site/gallery/agents/builder-options": {
    response: untyped(
      "GalleryBuilderOptions",
      obj({
        models: builderModels,
        connectors: arr(galleryConnector),
      }),
    ),
  },
  "get /v1/site/gallery/agents/scores": { response: GalleryScoreList },
};
