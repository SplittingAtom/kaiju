import type { KobeDb } from "@kobe/db";
import { logger } from "../logger.js";
import { decideMcpCall, type McpDecideDeps, type McpPrincipal } from "../mcp/decide.js";
import { loadActiveRuns, runHasConnector } from "../mcp/run-context.js";
import { kobeToolName } from "../policy/kobe-admin-guard.js";
import type { KobeCallAnswer, KobeCallRequest, KobeToolListing } from "../kobe-mcp/service.js";
import { decideGitAccess, loadGitToolFacts, namedRunAgent } from "./access.js";
import { gitToolByName } from "./catalog.js";
import { runGitTool, type GitToolsDeps } from "./execute.js";
import { GIT_NOT_ALLOWED_REASON } from "./guard.js";
import { offeredGitTools } from "./listing.js";
import { gitConnector, gitPinnedTool, loadGitBuiltin } from "./pinned.js";

/**
 * The built-in git connector's MCP server, hosted by the server (KOBE-762; owner decision
 * 2026-11-22: its own connector, apart from the Kobe MCP connector). The MCP proxy routes it here
 * (`/internal/v1/mcp/git/{list,calls}`); each call is decided and executed in this one request on
 * the same decision path as every connector call (`decideMcpCall`: the policy engine under every
 * active run of the sandbox, the git access check as the person half, a signed approval verified
 * and consumed, the `mcp.tool_call` audit row), and only an `allow` for exactly this run, tool
 * call and input reaches the executor.
 */

export interface GitMcpService {
  /** `tools/list`; undefined when nothing is offered to the sandbox's runs. */
  list(principal: McpPrincipal): Promise<KobeToolListing | undefined>;
  call(principal: McpPrincipal, request: KobeCallRequest): Promise<KobeCallAnswer>;
}

export type GitMcpServiceOptions = Omit<McpDecideDeps, "loadConnector" | "refuse" | "guard"> &
  Omit<GitToolsDeps, "db">;

/** The audit field grammar of tool call ids: other ids are replaced by the decision's own. */
const PLAIN_ID = /^[A-Za-z0-9_.:/-]{1,128}$/;

export function createGitMcpService(options: GitMcpServiceOptions): GitMcpService {
  const db: KobeDb = options.db;
  const gitDeps: GitToolsDeps = {
    db,
    envelope: options.envelope,
    net: options.net,
    publicUrl: options.publicUrl,
    ...(options.tokenCache ? { tokenCache: options.tokenCache } : {}),
    ...(options.adapterFor ? { adapterFor: options.adapterFor } : {}),
  };

  return {
    async list(principal) {
      if (principal.evalThreadId !== undefined) return undefined;
      const row = await loadGitBuiltin(db);
      if (!row) return undefined;
      const loaded = await loadActiveRuns(db, options.runContext, principal);
      if (!loaded.ok || !loaded.runs.some((r) => runHasConnector(r, row.id))) return undefined;
      const offered = offeredGitTools(await loadGitToolFacts(db, principal));
      if (offered.length === 0) return undefined;
      return {
        connector: { id: row.id, name: row.name },
        tools: offered.map((t) => {
          const {
            status: _status,
            sha256: _sha,
            ui: _ui,
            proposed: _p,
            ...listed
          } = gitPinnedTool(row.name, t);
          return listed;
        }),
      };
    },

    async call(principal, request) {
      const row = await loadGitBuiltin(db);
      if (!row) return { outcome: "unavailable" };
      const tool = gitToolByName(request.tool);
      const decided = await decideMcpCall(
        {
          ...options,
          async loadConnector(_teamId, connectorId) {
            return connectorId === row.id ? gitConnector(row) : undefined;
          },
          // The person half: input, connection, role, agents of the sandbox's runs, Site, now.
          refuse: async (pinned) => {
            const name = kobeToolName(pinned.pi_name);
            const def = name === undefined ? undefined : gitToolByName(name);
            if (def === undefined) return { code: "unknown_tool", message: "Unknown git tool." };
            const parsed = def.input.safeParse(request.arguments ?? {});
            if (!parsed.success) {
              return { code: "invalid_input", message: `The input of ${def.name} is not valid.` };
            }
            if (def.name === "git_list_connections") return undefined;
            const access = decideGitAccess(
              def,
              (parsed.data as { connection?: string }).connection,
              await loadGitToolFacts(db, principal),
            );
            return access.ok
              ? undefined
              : { code: GIT_NOT_ALLOWED_REASON, message: access.message };
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
      );
      if (decided.decision === "deny") {
        return { outcome: "denied", code: decided.code, message: decided.message };
      }
      // Defence in depth: an allow names the run and thread it was decided for.
      if (
        tool === undefined ||
        decided.run_id === undefined ||
        request.threadId === undefined ||
        decided.tool.name !== request.tool
      ) {
        logger.error({ sandboxId: principal.sandboxId }, "git-mcp: allow without a run; refused");
        return { outcome: "error", code: "failed", message: "Kobe could not run this tool." };
      }
      const toolCallId =
        decided.tool_call_id !== undefined && PLAIN_ID.test(decided.tool_call_id)
          ? decided.tool_call_id
          : `git-${decided.run_id}`;
      const ran = await runGitTool(
        gitDeps,
        {
          principal,
          runId: decided.run_id,
          threadId: request.threadId,
          toolCallId,
          agentId: await namedRunAgent(db, principal.teamId, decided.run_id),
        },
        tool,
        request.arguments,
      );
      return ran.ok
        ? { outcome: "result", result: { content: [{ type: "text", text: ran.text }] } }
        : { outcome: "error", code: ran.code, message: ran.message };
    },
  };
}
