import { z } from "zod";
import {
  threadContextErrorSchema,
  threadContextMemoriesSchema,
  threadContextSchema,
  threadContextWakingSchema,
  threadStatsSchema,
  type ThreadContextErrorCode,
} from "@kaiju/protocol";

/**
 * OpenAPI for `GET /v1/threads/{id}/context` (KOBE-470, `routes/thread-context.ts`, spec
 * docs/specs/context-viewer.md): generated from the contract's zod schemas.
 */
type JsonSchema = Record<string, unknown>;

const schemaOf = (schema: z.ZodType): JsonSchema => {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, {
    io: "output",
    target: "draft-2020-12",
  }) as JsonSchema;
  return rest;
};

const json = (schemaName: string, description: string) => ({
  description,
  content: { "application/json": { schema: { $ref: `#/components/schemas/${schemaName}` } } },
});

const codes = (...list: ThreadContextErrorCode[]) => list.map((c) => `\`${c}\``).join(", ");

export function contextOpenApiPaths(): Record<string, Record<string, unknown>> {
  return {
    "/v1/threads/{id}/context": {
      get: {
        operationId: "getThreadContext",
        summary: "What the thread's latest model call sent the model",
        description:
          "The owner reads the context of the thread's latest model call, live from their " +
          "workspace, as ordered sections with text and token counts (scaled to the call's " +
          "reported prompt tokens) and the context window. `exact` is false when it was rebuilt " +
          "from the session because the workspace restarted since that call (`missing` lists " +
          "what it may lack). Nothing is stored; section text is untrusted, show it as plain " +
          "text. A sleeping workspace is woken: 202, ask again after `retry_after_ms`.",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          "200": json("ThreadContext", "The sections, in the order the model saw them."),
          "202": json("ThreadContextWaking", "The workspace is waking; ask again."),
          "400": json("Error", "`invalid_request`: bad id."),
          "401": json("Error", "`unauthenticated`: no session."),
          "403": json(
            "ThreadContextError",
            `${codes("not_owner")} (a reader the thread is shared with); also \`forbidden\`, ` +
              "`not_a_team_member` (as `Error`).",
          ),
          "404": json("Error", "`thread_not_found`: unknown id, or another user's or team's."),
          "409": json("ThreadContextError", codes("thread_busy", "context_unsupported")),
          "429": json(
            "ThreadContextError",
            `${codes("rate_limited")}: more than 30 reads a minute, or waking the sleeping ` +
              "workspace would pass the member's 20 sandbox starts in 10 minutes (`Retry-After`).",
          ),
          "502": json("ThreadContextError", codes("context_unavailable")),
          "503": json("ThreadContextError", codes("sandbox_unavailable")),
        },
      },
    },
    "/v1/threads/{id}/context/memories": {
      get: {
        operationId: "getThreadContextMemories",
        summary: "The memories the thread's latest run was given",
        description:
          "The owner reads the semantic memories (Policy, Site, Workspace and their own) that " +
          "the thread's latest run with records was given (`latest` false when a newer run " +
          "came after it), in the order the block " +
          "renders them: Policy, pinned items, then the items picked for that message. Each " +
          "item is the version the run got. `run_id` is null while no run has records. Statements are untrusted: show them as plain text.",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          "200": json("ThreadContextMemories", "The items, in render order."),
          "400": json("Error", "`invalid_request`: bad id."),
          "401": json("Error", "`unauthenticated`: no session."),
          "403": json(
            "ThreadContextError",
            `${codes("not_owner")} (a reader the thread is shared with); also \`forbidden\`, ` +
              "`not_a_team_member` (as `Error`).",
          ),
          "404": json("Error", "`thread_not_found`: unknown id, or another user's or team's."),
        },
      },
    },
    "/v1/threads/{id}/stats": {
      get: {
        operationId: "getThreadStats",
        summary: "The conversation's stats",
        description:
          "Whoever may read the thread (its owner, and members it is shared with) reads counts " +
          "aggregated from what Kaiju stores about it, over every branch: turns and their " +
          "outcomes, compactions, branch summaries, models, tool calls (failed, refused), " +
          "approvals, skills used, MCP connector calls, tokens (input, output, cached, " +
          "reasoning), thinking levels, cost, and the median and 95th percentile of the time to " +
          "the first token and of a turn's duration. A figure Kaiju does not have is null, not 0. " +
          "`refused`, `failures_by_code` and `first_token` come from a turn's live events, which " +
          "are folded away 7 days after it ends (`events` counts kept and folded turns). Read " +
          "from the database only; no sandbox is woken.",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          "200": json("ThreadStats", "The figures."),
          "400": json("Error", "`invalid_request`: bad id."),
          "401": json("Error", "`unauthenticated`: no session."),
          "403": json("Error", "`forbidden`, `not_a_team_member`."),
          "404": json(
            "Error",
            "`thread_not_found`: unknown id, or a thread the caller may not read.",
          ),
          "429": json("Error", "`rate_limited`: more than 30 reads a minute."),
        },
      },
    },
  };
}

export function contextOpenApiSchemas(): Record<string, JsonSchema> {
  return {
    ThreadContext: schemaOf(threadContextSchema),
    ThreadContextWaking: schemaOf(threadContextWakingSchema),
    ThreadContextError: schemaOf(threadContextErrorSchema),
    ThreadContextMemories: schemaOf(threadContextMemoriesSchema),
    ThreadStats: schemaOf(threadStatsSchema),
  };
}
