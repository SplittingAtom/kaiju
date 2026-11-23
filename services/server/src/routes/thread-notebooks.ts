import { Hono, type Context } from "hono";
import {
  notebookPathSchema,
  notebookRunBodySchema,
  notebookVariablesBodySchema,
} from "@kobe/protocol";
import { execOutputs, fileHistory } from "../notebooks/history.js";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { NOTEBOOK_ERROR_STATUS, NotebookRunError } from "../notebooks/user-run.js";
import { RunError } from "../runs/errors.js";
import { uuidSchema } from "../threads/schemas.js";
import { refuseEvalThreadWrites } from "./eval-thread-guard.js";
import { actorOf } from "../authz/actor.js";
import { invalidRequest, param, parseBody, readJson } from "../http/request.js";

type Ctx = Context<{ Variables: TeamVariables }>;

/**
 * The thread's notebook kernel (KOBE-464, contract `notebooks.ts`, docs/specs/notebooks.md):
 * - `POST /v1/threads/{id}/notebook/run` {path, cell_id?, timeout_s?}: 202 {run_id, exec_id}; the
 *   outputs stream on `GET /v1/runs/{run_id}/events` and a cell's are saved into its notebook;
 * - `POST /v1/threads/{id}/notebook/interrupt` and `.../restart`: 200 {status};
 * - `POST /v1/threads/{id}/notebook/start` (KOBE-477): 202 {status: "waking", retry_after_ms} while
 *   the sandbox wakes, then 200 {status: "idle" | "busy"} once the kernel is up (no code runs).
 * - `POST /v1/threads/{id}/notebook/variables` {refresh?} (KOBE-803): 200 a snapshot of the
 *   kernel's variables (`stale` when kept from before code that ran since), or {status: "busy" |
 *   "no_kernel" | "unavailable"}; never wakes the sandbox, stores nothing.
 * - `GET /v1/threads/{id}/notebook/executions?path=` (KOBE-804): the `.py` file's last 50
 *   executions from the stored run events, newest first, without outputs; and
 *   `GET .../notebook/executions/{exec_id}/outputs`: one execution's outputs. Nothing new stored.
 * The thread's owner only (the kernel is in their sandbox); a shared reader is 403 `read_only`,
 * another member's or team's thread 404. Eval threads are refused like every other write.
 */
export function threadNotebookRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.chat"));
  app.use("/:id/*", refuseEvalThreadWrites(deps, "thread"));

  app.post("/:id/notebook/run", async (c) => {
    const id = param(c, "id", uuidSchema);
    const body = await parseBody(c, notebookRunBodySchema);
    if (!id.success || !body) {
      return invalidRequest(c, "Name an .ipynb file with a cell_id, or a .py file.");
    }
    return answer(c, async () =>
      c.json(await deps.runs.notebookRun(actorOf(c), id.data, body), 202),
    );
  });

  // KOBE-477: start the kernel, running nothing; 202 `waking` while the sandbox wakes.
  app.post("/:id/notebook/start", async (c) => {
    const id = param(c, "id", uuidSchema);
    if (!id.success) return invalidRequest(c, "Unknown conversation.");
    return answer(c, async () => {
      const started = await deps.runs.notebookStart(actorOf(c), id.data);
      return c.json(started, started.status === "waking" ? 202 : 200);
    });
  });

  // KOBE-803: the editor's Variables tab; a silent snapshot, never waking the sandbox.
  app.post("/:id/notebook/variables", async (c) => {
    const id = param(c, "id", uuidSchema);
    // The body is optional ({refresh?}); a missing or empty body is no refresh.
    const body = notebookVariablesBodySchema.safeParse(await readJson(c, {}));
    if (!id.success) return invalidRequest(c, "Unknown conversation.");
    if (!body.success) return invalidRequest(c, 'Send an empty body or {"refresh": true}.');
    const refresh = body.data.refresh === true;
    return answer(c, async () =>
      c.json(await deps.runs.notebookVariables(actorOf(c), id.data, refresh)),
    );
  });

  // KOBE-804: the run pane's Log survives a reload (stored run events, bounded).
  app.get("/:id/notebook/executions", async (c) => {
    const id = param(c, "id", uuidSchema);
    const path = notebookPathSchema.safeParse(c.req.query("path"));
    if (!id.success || !path.success || !path.data.endsWith(".py")) {
      return invalidRequest(c, "Name a .py file with ?path=.");
    }
    return answer(c, async () =>
      c.json(await fileHistory(deps.database.db, actorOf(c), id.data, path.data)),
    );
  });

  app.get("/:id/notebook/executions/:execId/outputs", async (c) => {
    const id = param(c, "id", uuidSchema);
    const execId = param(c, "execId", uuidSchema);
    if (!id.success || !execId.success) return invalidRequest(c, "Unknown execution.");
    return answer(c, async () =>
      c.json(await execOutputs(deps.database.db, actorOf(c), id.data, execId.data)),
    );
  });

  for (const op of ["interrupt", "restart"] as const) {
    app.post(`/:id/notebook/${op}`, async (c) => {
      const id = param(c, "id", uuidSchema);
      if (!id.success) return invalidRequest(c, "Unknown conversation.");
      return answer(c, async () => c.json(await deps.runs.notebookKernel(actorOf(c), id.data, op)));
    });
  }

  return app;
}

async function answer(c: Ctx, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof NotebookRunError) {
      return c.json(
        { code: err.code, message: err.message },
        NOTEBOOK_ERROR_STATUS[err.code] as 400,
      );
    }
    if (err instanceof RunError) {
      return c.json({ code: err.code, message: err.message }, err.status as 400);
    }
    throw err;
  }
}
