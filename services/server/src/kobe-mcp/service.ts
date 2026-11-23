import type { Hono } from "hono";
import { withTeam, type KobeDb, type PinnedTool } from "@kobe/db";
import { logger } from "../logger.js";
import { decideMcpCall, type McpDecideDeps, type McpPrincipal } from "../mcp/decide.js";
import { loadActiveRuns, runHasConnector } from "../mcp/run-context.js";
import {
  guardKobeAdmin,
  KOBE_ADMIN_NOT_ALLOWED_REASON,
  kobeToolName,
} from "../policy/kobe-admin-guard.js";
import {
  allowedKobeTools,
  loadKobeAccess,
  loadKobeBuiltin,
  loadKobeSwitches,
  personAllows,
  switchesAllow,
} from "./access.js";
import {
  isKobeDocsToolName,
  KOBE_DOCS_TOOLS,
  kobeDocsContext,
  kobeDocsToolByName,
  runKobeDocsTool,
} from "./docs/index.js";
import { executeKobeTool } from "./execute.js";
import { decideGitAccess, loadGitToolFacts, namedRunAgent } from "../git-tools/access.js";
import { gitToolByName } from "../git-tools/catalog.js";
import { runGitTool, type GitToolsDeps } from "../git-tools/execute.js";
import { GIT_NOT_ALLOWED_REASON } from "../git-tools/guard.js";
import { offeredGitTools } from "../git-tools/listing.js";
import { withKobePersonLock, withinKobeLimit } from "./limits.js";
import { gitPinnable, kobeConnector, kobePinnedTool } from "./pinned.js";
import { KOBE_ADMIN_TOOLS, kobeToolByName } from "./tools/index.js";

/**
 * The Kobe MCP server, hosted by the server itself (KOBE-619, spec kobe-admin-mcp §3 design (b)).
 * The MCP proxy routes the built-in connector here (`/internal/v1/mcp/kobe/{list,calls}`); each
 * call is decided and executed in this one request: the sandbox token is authenticated by the
 * route, the run leased to the sandbox for the claimed thread is resolved, `decideMcpCall` decides
 * (policy engine, Kobe admin guard, signed approval verified and consumed, audit), and only an
 * `allow` for exactly this run, tool call and input reaches the executor. Nothing is minted for
 * the sandbox; the principal is re-derived from server state on every call.
 *
 * The docs tools (KOBE-620, spec §4, KA4/KA7) are listed for every run that has the connector
 * (every run while the site switch is not `off`: `run.ts`), scheduled runs and evals included;
 * they need no permission and count against no admin limit, and run here from `@kobe/guide`.
 */

export interface KobeToolListing {
  readonly connector: { readonly id: string; readonly name: string };
  /** The proxy's tool shape (pinned tools without the pinning bookkeeping). */
  readonly tools: readonly Omit<PinnedTool, "status" | "sha256" | "ui" | "proposed">[];
}

export interface KobeCallRequest {
  readonly tool: string;
  readonly arguments: unknown;
  readonly threadId?: string;
  readonly toolCallId?: string;
}

export type KobeCallAnswer =
  | { readonly outcome: "unavailable" }
  | {
      readonly outcome: "result";
      readonly result: {
        readonly content: readonly { readonly type: "text"; readonly text: string }[];
        /** Absent for the docs tools' text results (they declare no output schema). */
        readonly structuredContent?: Record<string, unknown>;
      };
    }
  | { readonly outcome: "denied"; readonly code: string; readonly message: string }
  | { readonly outcome: "error"; readonly code: string; readonly message: string };

export interface KobeMcpService {
  /** The public API router the executor dispatches to (`createApp` binds itself). */
  bindApi(api: Hono): void;
  /** `tools/list`; undefined when the connector is off or in none of the sandbox's runs. */
  list(principal: McpPrincipal): Promise<KobeToolListing | undefined>;
  call(principal: McpPrincipal, request: KobeCallRequest): Promise<KobeCallAnswer>;
}

export type KobeMcpServiceOptions = Omit<McpDecideDeps, "loadConnector" | "refuse" | "guard"> & {
  /** The deployment's public origin (`KOBE_PUBLIC_URL`): the docs tools' links (KOBE-620). */
  readonly publicUrl: string;
  /**
   * The git host tools' credentials and network (KOBE-762); unset: they are offered nowhere and
   * every call is refused.
   */
  readonly git?: Omit<GitToolsDeps, "db" | "publicUrl">;
};

/** The audit field grammar of tool call ids: other ids are replaced by the decision's own. */
const PLAIN_ID = /^[A-Za-z0-9_.:/-]{1,128}$/;

export function createKobeMcpService(options: KobeMcpServiceOptions): KobeMcpService {
  const db: KobeDb = options.db;
  let api: Hono | undefined;

  const decideDeps = (row: { id: string; name: string }): McpDecideDeps => ({
    ...options,
    async loadConnector(teamId, connectorId) {
      if (connectorId !== row.id) return undefined;
      const switches = await loadKobeSwitches(db, teamId);
      return kobeConnector(
        row,
        KOBE_ADMIN_TOOLS.filter((t) => switchesAllow(t, switches)),
      );
    },
    refuse: async () => undefined,
    guard: (decision, input, run) =>
      guardKobeAdmin(decision, {
        tool: input.tool,
        input,
        evalRun: run.skillEval === true,
        now: (options.now ?? (() => new Date()))(),
      }),
  });

  return {
    bindApi(app) {
      api = app;
    },

    async list(principal) {
      const row = await loadKobeBuiltin(db);
      if (!row) return undefined;
      const loaded = await loadActiveRuns(db, options.runContext, principal);
      if (!loaded.ok) return undefined;
      const runs = loaded.runs.filter((r) => runHasConnector(r, row.id));
      if (runs.length === 0) return undefined;
      // Admin tools only for a run a person can answer (§3: scheduled runs and evals get docs only).
      const answerable =
        principal.evalThreadId === undefined &&
        runs.some((r) => r.trigger === "user" && r.skillEval !== true);
      const admin = answerable
        ? allowedKobeTools(
            await withTeam(db, principal.teamId, (tx) =>
              loadKobeAccess(tx, principal.teamId, principal.userId),
            ),
          )
        : [];
      // KOBE-762: the git host tools while a connection this sandbox's runs may use exists.
      const git =
        options.git === undefined || principal.evalThreadId !== undefined
          ? []
          : offeredGitTools(await loadGitToolFacts(db, principal)).map(gitPinnable);
      return {
        connector: { id: row.id, name: row.name },
        tools: [...KOBE_DOCS_TOOLS, ...admin, ...git].map((t) => {
          const {
            status: _status,
            sha256: _sha,
            ui: _ui,
            proposed: _p,
            ...listed
          } = kobePinnedTool(row.name, t);
          return listed;
        }),
      };
    },

    async call(principal, request) {
      const row = await loadKobeBuiltin(db);
      if (!row) return { outcome: "unavailable" };
      const docs = kobeDocsToolByName(request.tool);
      const tool = docs === undefined ? kobeToolByName(request.tool) : undefined;
      // KOBE-762: a git host tool (decided like any connector tool; its own access check below).
      const git =
        docs === undefined && tool === undefined ? gitToolByName(request.tool) : undefined;
      const deps = decideDeps(row);
      // The limit count and the decision's audit row under the person's lock (atomic limits).
      // The docs tools (KOBE-620) and the git tools (KOBE-762, own limits) never wait for it.
      const underLock = async <T>(
        f: () => Promise<T>,
      ): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false }> =>
        docs === undefined && git === undefined
          ? withKobePersonLock(db, principal.userId, f)
          : { ok: true as const, value: await f() };
      const locked = await underLock(() =>
        decideMcpCall(
          {
            ...deps,
            // The person half (§8): permission and switches re-read now, then the per-person limits.
            refuse: async (pinned) => {
              const name = kobeToolName(pinned.pi_name);
              // The docs tools (KOBE-620): no team or user data, no permission, no admin limit.
              if (name !== undefined && isKobeDocsToolName(name)) return undefined;
              // The git host tools (KOBE-762): input, connection, role, agents and Site, now.
              const gitDef = name === undefined ? undefined : gitToolByName(name);
              if (gitDef !== undefined) {
                if (options.git === undefined) {
                  return {
                    code: GIT_NOT_ALLOWED_REASON,
                    message: "Git tools are not available on this server.",
                  };
                }
                const parsed = gitDef.input.safeParse(request.arguments ?? {});
                if (!parsed.success) {
                  return {
                    code: "invalid_input",
                    message: `The input of ${gitDef.name} is not valid.`,
                  };
                }
                if (gitDef.name === "git_list_connections") return undefined;
                const decided = decideGitAccess(
                  gitDef,
                  (parsed.data as { connection?: string }).connection,
                  await loadGitToolFacts(db, principal),
                );
                return decided.ok
                  ? undefined
                  : { code: GIT_NOT_ALLOWED_REASON, message: decided.message };
              }
              const def = name === undefined ? undefined : kobeToolByName(name);
              if (def === undefined) return { code: "unknown_tool", message: "Unknown Kobe tool." };
              // Checked before anyone is asked: an approval is only ever for a well-formed change.
              if (!def.input.safeParse(request.arguments ?? {}).success) {
                return { code: "invalid_input", message: `The input of ${def.name} is not valid.` };
              }
              const access = await withTeam(db, principal.teamId, (tx) =>
                loadKobeAccess(tx, principal.teamId, principal.userId),
              );
              if (!switchesAllow(def, access) || !personAllows(def, access)) {
                return {
                  code: KOBE_ADMIN_NOT_ALLOWED_REASON,
                  message: `${pinned.pi_name} is not available to you in this team (your role, or the Kobe admin switches).`,
                };
              }
              if (!(await withinKobeLimit(db, principal.userId, def.readOnly ? "read" : "write"))) {
                return {
                  code: "kobe_admin_rate_limited",
                  message: def.readOnly
                    ? "Too many Kobe admin reads in the last minute; try again shortly."
                    : "Too many Kobe admin changes in the last hour; try again later.",
                };
              }
              return undefined;
            },
          },
          principal,
          {
            connectorId: row.id,
            tool: request.tool,
            arguments: request.arguments,
            ...(request.threadId === undefined ? {} : { threadId: request.threadId }),
            ...(request.toolCallId === undefined ? {} : { toolCallId: request.toolCallId }),
          },
        ),
      );
      if (!locked.ok) {
        return {
          outcome: "denied",
          code: "kobe_admin_rate_limited",
          message: "Kobe is busy with your other admin calls; try again shortly.",
        };
      }
      const decided = locked.value;
      if (decided.decision === "deny") {
        return { outcome: "denied", code: decided.code, message: decided.message };
      }
      // Defence in depth: an allow names the run and thread it was decided for.
      if (
        (tool === undefined && docs === undefined && git === undefined) ||
        decided.run_id === undefined ||
        request.threadId === undefined ||
        decided.tool.name !== request.tool ||
        api === undefined
      ) {
        logger.error({ sandboxId: principal.sandboxId }, "kobe-mcp: allow without a run; refused");
        return { outcome: "error", code: "failed", message: "Kobe could not run this tool." };
      }
      if (docs !== undefined) {
        const answered = runKobeDocsTool(
          docs,
          request.arguments,
          await kobeDocsContext(db, options.publicUrl),
        );
        return answered.ok
          ? { outcome: "result", result: answered.result }
          : { outcome: "error", code: answered.code, message: answered.message };
      }
      const toolCallId =
        decided.tool_call_id !== undefined && PLAIN_ID.test(decided.tool_call_id)
          ? decided.tool_call_id
          : `kobe-${decided.run_id}`;
      if (git !== undefined) {
        if (options.git === undefined) {
          return { outcome: "error", code: "unavailable", message: "Git tools are not available." };
        }
        const ran = await runGitTool(
          { ...options.git, db, publicUrl: options.publicUrl },
          {
            principal,
            runId: decided.run_id,
            threadId: request.threadId,
            toolCallId,
            agentId: await namedRunAgent(db, principal.teamId, decided.run_id),
          },
          git,
          request.arguments,
        );
        return ran.ok
          ? { outcome: "result", result: { content: [{ type: "text", text: ran.text }] } }
          : { outcome: "error", code: ran.code, message: ran.message };
      }
      if (tool === undefined) {
        return { outcome: "error", code: "failed", message: "Kobe could not run this tool." };
      }
      const executed = await executeKobeTool(
        api,
        {
          userId: principal.userId,
          teamId: principal.teamId,
          runId: decided.run_id,
          threadId: request.threadId,
          toolCallId,
        },
        tool,
        request.arguments,
      );
      return executed.ok
        ? { outcome: "result", result: executed.result }
        : { outcome: "error", code: executed.code, message: executed.message };
    },
  };
}
