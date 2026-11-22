import { z } from "zod";
import {
  notebookErrorSchema,
  notebookVariablesResultSchema,
  type NotebookError,
} from "@kobe/protocol";

/**
 * OpenAPI for `POST /v1/threads/{id}/notebook/variables` (KOBE-803, `routes/thread-notebooks.ts`,
 * `notebooks/variables.ts`): generated from the contract's zod schemas. The other notebook routes
 * stay in the summary-level catalog.
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

const codes = (...list: NotebookError["code"][]) => list.map((c) => `\`${c}\``).join(", ");

export function notebookVariablesOpenApiPaths(): Record<string, Record<string, unknown>> {
  return {
    "/v1/threads/{id}/notebook/variables": {
      post: {
        operationId: "postThreadNotebookVariables",
        summary: "Snapshot the variables of the conversation's Python kernel",
        description:
          "The owner takes a fresh snapshot of their kernel's user variables (the Python " +
          "editor's Variables tab): per variable its name, type, a short repr (capped; empty " +
          "with `repr_error` when it raised or took too long) and summaries for common types " +
          "(`len`; `shape` and `dtype` for numpy arrays; `shape`, `columns` and " +
          "`columns_total` for pandas DataFrames, never their data). Modules, functions and " +
          "classes are listed by name in `other`; names starting with `_` and IPython's own " +
          "are left out; `truncated` when a cap left variables out. It runs silently in the " +
          "kernel (no execution count, not a run, nothing stored) and never wakes a sleeping " +
          "workspace or starts a kernel: `no_kernel`, `busy` (code is running) and " +
          "`unavailable` (no answer in time) are answers too. Reprs are untrusted: show them " +
          "as plain text. The snapshot after each run is on its `notebook.finished` event.",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          "200": json("NotebookVariables", "The snapshot, or why there is none."),
          "400": json("Error", "`invalid_request`: bad id."),
          "401": json("Error", "`unauthenticated`: no session."),
          "403": json(
            "Error",
            "`read_only` (a reader the thread is shared with), `forbidden`, `not_a_team_member`.",
          ),
          "404": json("NotebookError", codes("thread_not_found")),
          "409": json(
            "NotebookError",
            `${codes("variables_unsupported", "notebooks_unsupported")}; also (as \`Error\`) ` +
              "`thread_busy` while another request holds the conversation and " +
              "`skill_eval_thread` for a skill eval's conversation.",
          ),
          "429": json("NotebookError", codes("rate_limited")),
          "503": json("NotebookError", codes("isolation_unavailable", "sandbox_unavailable")),
        },
      },
    },
  };
}

export function notebookVariablesOpenApiSchemas(): Record<string, JsonSchema> {
  return {
    NotebookVariables: schemaOf(notebookVariablesResultSchema),
    NotebookError: schemaOf(notebookErrorSchema),
  };
}
