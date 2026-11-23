import { z } from "zod";
import {
  notebookErrorSchema,
  notebookVariablesBodySchema,
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
          "The owner reads a snapshot of their kernel's user variables (the Python editor's " +
          "Variables tab, called after each run and on Refresh). The workspace keeps the snapshot " +
          "it took after the owner's last run: it answers with it while code runs (`stale`: true) " +
          "or when nothing ran since, and takes a fresh one when the kernel is idle and code ran " +
          "since or `refresh` is true. After a snapshot taken after a run timed out, automatic " +
          "snapshots pause for the conversation until the workspace restarts (`auto_paused`: " +
          "`snapshot_timeout`): only `refresh` takes one then. Per variable its name, type, a short " +
          "value (capped) and summaries for common types. The value is read without running the " +
          "member's code: only for exact built-in scalars, strings, bytes and containers, ranges " +
          "and numpy/pandas objects; for anything else it is empty with `repr_error`: " +
          "`not_read` (`raised` when reading a library object failed) " +
          "(`len`; `shape` and `dtype` for numpy arrays; `shape`, `columns` and " +
          "`columns_total` for pandas DataFrames, never their data). Modules, functions and " +
          "classes are listed by name in `other`; names starting with `_` and IPython's own " +
          "are left out; `truncated` when a cap left variables out. It is an inspection request " +
          "in the kernel, not code run (no execution hooks, no execution count, nothing stored) " +
          "and never wakes a sleeping " +
          "workspace or starts a kernel: `no_kernel`, `busy` (code is running) and " +
          "`unavailable` (no answer in time) are answers too. Nothing is stored: snapshots " +
          "are never in run events and go to the owner only, since a repr can hold a secret. " +
          "Reprs are untrusted: show them as plain text.",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        requestBody: {
          required: false,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/NotebookVariablesBody" } },
          },
        },
        responses: {
          "200": json("NotebookVariables", "The snapshot, or why there is none."),
          "400": json("Error", "`invalid_request`: bad id or body."),
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
    NotebookVariablesBody: schemaOf(notebookVariablesBodySchema),
    NotebookError: schemaOf(notebookErrorSchema),
  };
}
