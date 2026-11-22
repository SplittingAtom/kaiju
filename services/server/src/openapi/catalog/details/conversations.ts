import { UI_RESOURCE_PLACEMENTS } from "@kobe/db";
import {
  artifactDetailSchema,
  artifactListResponseSchema,
  createScheduleBodySchema,
  fileEditProposalsResponseSchema,
  launchAppCardBodySchema,
  launchAppCardResponseSchema,
  learnStartRequestSchema,
  learnStartResponseSchema,
  learnStateSchema,
  listSchedulesQuerySchema,
  listSchedulesResponseSchema,
  notebookKernelResponseSchema,
  notebookRunBodySchema,
  notebookRunResponseSchema,
  notebookStartResponseSchema,
  patchScheduleBodySchema,
  scheduleResponseSchema,
  syncConflictActionBodySchema,
  threadFilesResponseSchema,
  threadSyncConflictsResponseSchema,
  workspaceFileEntrySchema,
} from "@kobe/protocol";
import { APP_TEXT_REASONS } from "../../../apps/thread-results.js";
import { launchNewThreadBodySchema } from "../../../apps/new-thread-draft.js";
import { CONNECTOR_PROBLEMS } from "../../../connectors/thread-connectors.js";
import { toggleBodySchema } from "../../../routes/thread-connectors.js";
import { draftQuerySchema } from "../../../routes/thread-skills.js";
import { runUsageSchema } from "../../usage.js";
import { named, untyped, type CatalogDetail } from "../build.js";
import { any, arr, bool, nullable, obj, oneOfStrings, str, uuid } from "../json.js";

/**
 * Request and response schemas of the conversation catalog areas (KOBE-771): Threads, Runs,
 * Artifacts, Workspace and Schedules. Bodies and answers come from the zod schemas the routes
 * validate with and the `@kobe/protocol` contracts; `untyped(...)` marks the few answers the
 * routes build without a schema (fields read from the handler).
 */

const SyncConflictAction = named("SyncConflictActionBody", syncConflictActionBodySchema);
const SyncConflicts = named("SyncConflicts", threadSyncConflictsResponseSchema);
const LaunchAppCard = named("LaunchAppCardResponse", launchAppCardResponseSchema);

const chatConnector = obj({
  connector_id: uuid,
  name: str,
  enabled: bool,
  "builtin?": obj({ kind: oneOfStrings("kobe"), admin: oneOfStrings("off", "read", "read_write") }),
  problem: nullable(obj({ code: oneOfStrings(...CONNECTOR_PROBLEMS), message: str, fix: str })),
});
const ChatConnectors = untyped("ChatConnectorList", obj({ connectors: arr(chatConnector) }));
const SkillNames = untyped("EffectiveSkillList", obj({ skills: arr(obj({ name: str })) }));

const appResultView = obj({
  result_ref: uuid,
  run_id: nullable(uuid),
  user_entry_id: nullable(str),
  tool_call_id: nullable(str),
  entry_id: nullable(str),
  connector_id: uuid,
  connector_name: str,
  tool: str,
  app_id: str,
  template_sha256: str,
  view: oneOfStrings("app", "text"),
  queued: bool,
  "reason?": oneOfStrings(...APP_TEXT_REASONS),
  "app?": obj({ title: str, placement: oneOfStrings(...UI_RESOURCE_PLACEMENTS) }),
});

const teamQuery = {
  team: {
    type: "string",
    format: "uuid",
    description: "The team the page believes is active (a download link cannot send X-Kobe-Team).",
  },
};

export const threadsDetails: Readonly<Record<string, CatalogDetail>> = {
  "post /v1/threads/{id}/app-cards": {
    body: named("LaunchAppCardBody", launchAppCardBodySchema),
    status: 201,
    response: LaunchAppCard,
    responseDescription: "The card, inserted at the leaf, or queued while a run is active.",
    errors: ["404", "409", "413", "429", "502"],
  },
  "delete /v1/threads/{id}/app-cards/{ref}": { status: 204, errors: ["404"] },
  "get /v1/threads/{id}/app-results": {
    response: untyped("AppResultViews", obj({ results: arr(appResultView), truncated: bool })),
    errors: ["404"],
  },
  "get /v1/threads/{id}/app-results/{ref}": {
    response: untyped("StoredAppResult", obj({ input: nullable(any), result: any })),
    responseDescription:
      "The stored result and the input the upstream ran (null before it was kept).",
    errors: ["404", "409", "503"],
  },
  "get /v1/threads/{id}/connectors": { response: ChatConnectors, errors: ["404"] },
  "put /v1/threads/{id}/connectors/{connectorId}": {
    body: named("ThreadConnectorToggleBody", toggleBodySchema),
    response: untyped("ThreadConnectorToggle", obj({ connector: chatConnector })),
    errors: ["404", "409"],
  },
  "get /v1/threads/{id}/export": {
    query: teamQuery,
    produces: "text/markdown",
    responseDescription: "The conversation as a Markdown attachment.",
    errors: ["404", "409", "429"],
  },
  "get /v1/threads/{id}/file-edit-proposals": {
    response: named("FileEditProposals", fileEditProposalsResponseSchema),
    errors: ["404"],
  },
  "get /v1/threads/{id}/files": {
    response: named("ThreadFiles", threadFilesResponseSchema),
    errors: ["404"],
  },
  "get /v1/threads/{id}/learn": {
    query: { estimate: { type: "string", enum: ["1"], description: "`1` adds token estimates." } },
    response: named("LearnState", learnStateSchema),
    errors: ["404"],
  },
  "post /v1/threads/{id}/learn": {
    body: named("LearnStartBody", learnStartRequestSchema),
    status: 202,
    response: named("LearnStartResponse", learnStartResponseSchema),
    responseDescription: "The pass started; a refusal answers with its code and status.",
    errors: ["402", "404", "409", "429"],
  },
  "post /v1/threads/{id}/notebook/interrupt": {
    body: null,
    response: named("NotebookKernelResponse", notebookKernelResponseSchema),
    errors: ["404", "409", "503"],
  },
  "post /v1/threads/{id}/notebook/restart": {
    body: null,
    response: named("NotebookKernelResponse", notebookKernelResponseSchema),
    errors: ["404", "409", "503"],
  },
  "post /v1/threads/{id}/notebook/run": {
    body: named("NotebookRunBody", notebookRunBodySchema),
    status: 202,
    response: named("NotebookRunResponse", notebookRunResponseSchema),
    responseDescription: "Accepted; follow `GET /v1/runs/{run_id}/events`.",
    errors: ["404", "409", "503"],
  },
  "post /v1/threads/{id}/notebook/start": {
    body: null,
    response: named("NotebookStartResponse", notebookStartResponseSchema),
    responseDescription:
      "200 once the kernel is up; 202 `waking` (ask again after `retry_after_ms`).",
    errors: ["404", "409", "503"],
  },
  "post /v1/threads/{id}/purge": { body: null, status: 204, errors: ["404", "409"] },
  "get /v1/threads/{id}/skills": { response: SkillNames, errors: ["404"] },
  "get /v1/threads/{id}/sync-conflicts": { response: SyncConflicts, errors: ["404"] },
  "post /v1/threads/{id}/sync-conflicts/{conflictId}": {
    body: SyncConflictAction,
    status: 204,
    errors: ["404"],
  },
  "post /v1/threads/app-cards": {
    body: named("LaunchNewThreadAppCardBody", launchNewThreadBodySchema),
    status: 201,
    response: LaunchAppCard,
    errors: ["404", "409", "413", "429", "502"],
  },
  "get /v1/threads/connectors": { response: ChatConnectors },
  "get /v1/threads/export": {
    query: teamQuery,
    produces: "application/zip",
    responseDescription: "All of the member's conversations as a zip attachment.",
    errors: ["409", "429"],
  },
  "get /v1/threads/skills": { query: draftQuerySchema, response: SkillNames, errors: ["404"] },
};

export const runsDetails: Readonly<Record<string, CatalogDetail>> = {
  "get /v1/runs/{id}/usage": {
    response: named("RunUsage", runUsageSchema),
    errors: ["404"],
  },
  "get /v1/runs/{runId}/events": {
    query: {
      starting_after: {
        type: "string",
        description: "Resume after this event seq (or send the `Last-Event-ID` header).",
      },
    },
    produces: "text/event-stream",
    responseDescription:
      "Kobe Event Stream (types in `@kobe/protocol` `events.ts`); 204 when the run has ended " +
      "and nothing is left to send.",
    errors: ["404"],
  },
};

export const artifactsDetails: Readonly<Record<string, CatalogDetail>> = {
  "get /v1/artifacts": {
    query: { thread_id: { type: "string", format: "uuid" } },
    requiredQuery: ["thread_id"],
    response: named("ArtifactList", artifactListResponseSchema),
    errors: ["404"],
  },
  "get /v1/artifacts/{id}": {
    response: named("ArtifactDetail", artifactDetailSchema),
    errors: ["404"],
  },
  "get /v1/artifacts/{id}/versions/{n}/content": {
    produces: "text/plain",
    responseDescription: "The version's content as an attachment.",
    errors: ["404"],
  },
  "post /v1/artifacts/{id}/versions/{n}/edit-as-file": {
    body: null,
    status: 201,
    response: named("WorkspaceFileEntry", workspaceFileEntrySchema),
    responseDescription: "The new file in the member's workspace.",
    errors: ["404", "409", "503"],
  },
  "get /v1/artifacts/{id}/versions/{n}/frame": {
    query: teamQuery,
    produces: "text/html",
    responseDescription: "The sandboxed HTML document for the artifact panel's iframe.",
    errors: ["404", "409"],
  },
};

export const workspaceDetails: Readonly<Record<string, CatalogDetail>> = {
  "get /v1/workspace/sync-conflicts": { response: SyncConflicts },
  "post /v1/workspace/sync-conflicts/{conflictId}": {
    body: SyncConflictAction,
    status: 204,
    errors: ["404"],
  },
};

const Schedule = named("Schedule", scheduleResponseSchema);
// Refusals specific to schedules use `ScheduleError` (`@kobe/protocol` schedules.ts), as `Error`.
const SCHEDULE_ERRORS = ["409", "422"] as const;

const expectedActive = (value: "true" | "false", what: string) => ({
  expectedActive: {
    type: "string",
    enum: [value],
    description: `Refuse with 409 when the schedule is no longer ${what} (an approval's guard).`,
  },
});

export const schedulesDetails: Readonly<Record<string, CatalogDetail>> = {
  "get /v1/schedules": {
    query: listSchedulesQuerySchema,
    response: named("ScheduleList", listSchedulesResponseSchema),
  },
  "post /v1/schedules": {
    body: named("CreateScheduleBody", createScheduleBodySchema),
    status: 201,
    response: Schedule,
    errors: [...SCHEDULE_ERRORS],
  },
  "delete /v1/schedules/{id}": { status: 204, errors: ["404"] },
  "get /v1/schedules/{id}": { response: Schedule, errors: ["404"] },
  "patch /v1/schedules/{id}": {
    body: named("PatchScheduleBody", patchScheduleBodySchema),
    response: Schedule,
    errors: ["404", ...SCHEDULE_ERRORS],
  },
  "post /v1/schedules/{id}/pause": {
    body: null,
    query: expectedActive("true", "active"),
    response: Schedule,
    errors: ["404", "409"],
  },
  "post /v1/schedules/{id}/resume": {
    body: null,
    query: expectedActive("false", "paused"),
    response: Schedule,
    errors: ["404", ...SCHEDULE_ERRORS],
  },
};
