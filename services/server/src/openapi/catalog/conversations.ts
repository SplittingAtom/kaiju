import type { CatalogArea } from "./build.js";
import {
  artifactsDetails,
  runsDetails,
  schedulesDetails,
  threadsDetails,
  workspaceDetails,
} from "./details/conversations.js";
import { workspaceRebuildDetails } from "./details/workspace-rebuild.js";

/** OpenAPI catalog: conversations (threads, runs, artifacts, workspace, schedules) (KOBE-727). */
export const conversationsAreas: readonly CatalogArea[] = [
  {
    tag: "Threads",
    detailed: true,
    teamScoped: true,
    details: threadsDetails,
    description:
      "Conversations beyond the core thread API: app cards and results, connectors, export, learning, notebooks, skills and sync conflicts. Team-scoped: send X-Kobe-Team.",
    entries: [
      [
        "post",
        "/v1/threads/{id}/app-cards",
        "Launch an app card in a conversation",
        "Team members (`team.chat`). Answers 201; queued when a run is active.",
      ],
      [
        "delete",
        "/v1/threads/{id}/app-cards/{ref}",
        "Remove a waiting app card",
        "Answers 204, or 404 when no such card is waiting.",
      ],
      [
        "get",
        "/v1/threads/{id}/app-results",
        "List the conversation's app results as the viewer sees them",
        "Owner and readers of a shared thread. Newest 500, oldest first.",
      ],
      [
        "get",
        "/v1/threads/{id}/app-results/{ref}",
        "Read one stored app result with its input",
        "409 `text_only` when the viewer cannot open it as an app.",
      ],
      [
        "get",
        "/v1/threads/{id}/connectors",
        "List the connectors with their on/off state for this conversation",
        "Owner only.",
      ],
      [
        "put",
        "/v1/threads/{id}/connectors/{connectorId}",
        "Turn a connector on or off for this conversation",
        "Owner only. 409 when the connector is not working.",
      ],
      [
        "get",
        "/v1/threads/{id}/export",
        "Download one conversation as Markdown",
        "Owner only; audited. A download link passes `?team=`.",
      ],
      [
        "get",
        "/v1/threads/{id}/file-edit-proposals",
        "List the file edits the agent proposed in this conversation",
        "Owner only.",
      ],
      [
        "get",
        "/v1/threads/{id}/files",
        "List the workspace files the agent wrote in this conversation",
        "Owner only.",
      ],
      [
        "get",
        "/v1/threads/{id}/learn",
        "Read the conversation's Learn state",
        "Owner only; `?estimate=1` adds token estimates.",
      ],
      [
        "post",
        "/v1/threads/{id}/learn",
        "Start a Learn pass over the conversation",
        "Owner only. Answers 202, or a refusal with its code.",
      ],
      [
        "post",
        "/v1/threads/{id}/notebook/interrupt",
        "Interrupt the conversation's notebook kernel",
        "Owner only.",
      ],
      [
        "post",
        "/v1/threads/{id}/notebook/restart",
        "Restart the conversation's notebook kernel",
        "Owner only.",
      ],
      [
        "post",
        "/v1/threads/{id}/notebook/run",
        "Run a notebook cell or Python file in the kernel",
        "Owner only. Answers 202.",
      ],
      [
        "post",
        "/v1/threads/{id}/notebook/start",
        "Start the notebook kernel without running anything",
        "Owner only. 202 `waking` while the sandbox wakes.",
      ],
      ["post", "/v1/threads/{id}/purge", "Delete a trashed conversation for good", "Answers 204."],
      ["get", "/v1/threads/{id}/skills", "List the skills in effect for this conversation"],
      [
        "get",
        "/v1/threads/{id}/sync-conflicts",
        "List the conversation's file sync conflicts",
        "Owner only.",
      ],
      [
        "post",
        "/v1/threads/{id}/sync-conflicts/{conflictId}",
        "Settle one file sync conflict",
        "Owner only. Answers 204.",
      ],
      [
        "post",
        "/v1/threads/app-cards",
        "Start a new conversation from an app card",
        "Answers 201.",
      ],
      ["get", "/v1/threads/connectors", "List the connectors for a conversation not started yet"],
      [
        "get",
        "/v1/threads/export",
        "Download all of the member's conversations as a zip",
        "A download link passes `?team=`.",
      ],
      [
        "get",
        "/v1/threads/skills",
        "List the skills in effect for a new conversation",
        "`agent_id` picks the agent; 404 when it is not available.",
      ],
    ],
  },
  {
    tag: "Runs",
    detailed: true,
    teamScoped: true,
    details: runsDetails,
    description: "Agent runs: the event stream and usage. Team-scoped: send X-Kobe-Team.",
    entries: [
      [
        "get",
        "/v1/runs/{id}/usage",
        "Read the model and token usage of one run",
        "Team members (`team.chat`) who may read the run's thread.",
      ],
      [
        "get",
        "/v1/runs/{runId}/events",
        "Stream a run's events (Kobe Event Stream)",
        "Team members (`team.chat`). `text/event-stream`; unknown or private runs answer 404.",
      ],
    ],
  },
  {
    tag: "Artifacts",
    detailed: true,
    teamScoped: true,
    details: artifactsDetails,
    description:
      "Artifacts an agent produced in a conversation, by version. Team-scoped: send X-Kobe-Team.",
    entries: [
      ["get", "/v1/artifacts", "List a conversation's artifacts", "Needs `thread_id`."],
      ["get", "/v1/artifacts/{id}", "Read one artifact with its versions"],
      [
        "get",
        "/v1/artifacts/{id}/versions/{n}/content",
        "Download one artifact version's content",
        "File download (`text/plain`, attachment).",
      ],
      [
        "post",
        "/v1/artifacts/{id}/versions/{n}/edit-as-file",
        "Copy a text artifact version into the member's workspace",
        "Thread owner only; audited.",
      ],
      [
        "get",
        "/v1/artifacts/{id}/versions/{n}/frame",
        "Get the sandboxed HTML frame for an artifact version",
        "HTML document for the panel's iframe; passes `?team=`.",
      ],
    ],
  },
  {
    tag: "Workspace",
    detailed: true,
    teamScoped: true,
    details: { ...workspaceDetails, ...workspaceRebuildDetails },
    description: "The member's synced workspace files. Team-scoped: send X-Kobe-Team.",
    entries: [
      [
        "get",
        "/v1/workspace/rebuild",
        "Whether the member's workspace volume is lost, and when the workspace last synced",
        "Team members (`team.chat`). KOBE-739: `{volume: lost|unreachable|rebuilding|present|missing|unknown, last_synced_at, rebuildable, down_since?, offer_at?}`; reads the cluster, cached 30 s, rate limited (429). 503 `rebuild_unavailable` without workspace storage.",
      ],
      [
        "post",
        "/v1/workspace/rebuild",
        "Rebuild the member's lost workspace from the last sync",
        "Team members (`team.chat`). Body `{confirm: true}`. Re-checks the loss live (409 `volume_reachable`, or `volume_not_yet_lost` with `offer_at` while the node's grace period runs), audits `sandbox.volume_rebuilt`, then deletes the old claim and volume; the next wake restores from object storage. 503 `rebuild_pending` when the cleanup is retried; 409 `rebuild_superseded` when the claim there is not the confirmed one; idempotent (`already`).",
      ],
      [
        "get",
        "/v1/workspace/sync-conflicts",
        "List the member's sync conflicts no conversation wrote",
        "Team members (`team.chat`).",
      ],
      [
        "post",
        "/v1/workspace/sync-conflicts/{conflictId}",
        "Settle one workspace sync conflict",
        "Team members (`team.chat`). Answers 204; idempotent.",
      ],
    ],
  },
  {
    tag: "Schedules",
    detailed: true,
    teamScoped: true,
    details: schedulesDetails,
    description:
      "Scheduled runs: a member's own, plus the team's inventory for admins. Team-scoped: send X-Kobe-Team.",
    entries: [
      [
        "get",
        "/v1/schedules",
        "List schedules with the active count",
        "`scope=team` is for team admins (`team.schedules.pause`).",
      ],
      ["post", "/v1/schedules", "Create a schedule"],
      ["delete", "/v1/schedules/{id}", "Delete one of the member's schedules", "Answers 204."],
      ["get", "/v1/schedules/{id}", "Read one of the member's schedules"],
      ["patch", "/v1/schedules/{id}", "Change one of the member's schedules"],
      [
        "post",
        "/v1/schedules/{id}/pause",
        "Pause a schedule",
        "Owner or team admin (`team.schedules.pause`).",
      ],
      [
        "post",
        "/v1/schedules/{id}/resume",
        "Resume a paused schedule",
        "Owner or team admin (`team.schedules.pause`).",
      ],
    ],
  },
];
