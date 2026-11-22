import {
  agentOwnershipOpenApiPaths,
  agentRosterOpenApiPaths,
  agentRosterOpenApiSchemas,
} from "./agent-roster.js";
import { approvalsOpenApiPaths, approvalsOpenApiSchemas } from "./approvals.js";
import { brandingOpenApiPaths, brandingOpenApiSchemas } from "./branding.js";
import { compactOpenApiPaths, compactOpenApiSchemas } from "./compact.js";
import { branchSummaryOpenApiPaths, branchSummaryOpenApiSchemas } from "./branch-summary.js";
import { contextOpenApiPaths, contextOpenApiSchemas } from "./context.js";
import { egressAccessOpenApiPaths, egressAccessOpenApiSchemas } from "./egress-access.js";
import { evalCasesOpenApiPaths, evalCasesOpenApiSchemas } from "./eval-cases.js";
import { feedbackOpenApiPaths, feedbackOpenApiSchemas } from "./feedback.js";
import { markersOpenApiPaths, markersOpenApiSchemas } from "./markers.js";
import { modelsOpenApiPaths, modelsOpenApiSchemas } from "./models.js";
import { pendingOpenApiPaths, pendingOpenApiSchemas } from "./pending.js";
import { projectCommitsOpenApiPaths, projectCommitsOpenApiSchemas } from "./project-commits.js";
import { runsOpenApiPaths, runsOpenApiSchemas } from "./runs.js";
import { semanticMemoryOpenApiPaths, semanticMemoryOpenApiSchemas } from "./semantic-memory.js";
import { threadsOpenApiPaths, threadsOpenApiSchemas } from "./threads.js";
import { threadFoldersOpenApiPaths, threadFoldersOpenApiSchemas } from "./thread-folders.js";
import { threadFileLinksOpenApiPaths, threadFileLinksOpenApiSchemas } from "./thread-file-links.js";
import { usageOpenApiPaths, usageOpenApiSchemas } from "./usage.js";
import {
  catalogOpenApiPaths,
  catalogOpenApiResponses,
  catalogOpenApiSchemas,
  catalogOpenApiTags,
} from "./catalog/index.js";
import { mergePaths, mergeSchemas } from "./catalog/build.js";
import {
  teamDefaultAgentOpenApiPaths,
  teamDefaultAgentOpenApiSchemas,
} from "./team-default-agent.js";

/**
 * The server's OpenAPI 3.1 document, committed as `services/server/openapi.json` and checked for
 * drift by `document.test.ts`. Areas add their paths and schemas here (one line each). It covers
 * every route of the member and admin API on the user-facing listener (`coverage.test.ts`, KOBE-727):
 * fully described areas here, the rest at summary level from `catalog/`; what is left out on
 * purpose is in `undocumented-allowlist.ts`.
 */
export function openApiDocument(): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "Kobe API",
      version: "0.0.0",
      description:
        "Team-scoped routes act on the session's active team (spec D9); send X-Kobe-Team on " +
        "changes. Errors are `{code, message}`. Authentication is the Better Auth session cookie.\n\n" +
        "Coverage: every route of the member and admin API is listed. Operations marked " +
        "`x-kobe-detail: summary` (tagged by area) document their summary and path parameters " +
        "only; their request and response bodies are not described yet. The rest are fully " +
        "described; a response schema marked `x-kobe-untyped` lists the fields the route sends " +
        "without a schema in code. Not listed on purpose: health probes, Better Auth's own " +
        "`/api/auth/*` handler, SCIM provisioning (`/v1/scim/v2`, see the SCIM specification), " +
        "OAuth redirect and client-metadata endpoints, the web app's telemetry beacon, and the " +
        "sandbox-facing and internal listeners, which are not reachable from outside the cluster.",
    },
    tags: catalogOpenApiTags(),
    paths: mergePaths(
      {
        ...threadsOpenApiPaths(),
        ...threadFoldersOpenApiPaths(),
        ...runsOpenApiPaths(),
        ...pendingOpenApiPaths(),
        ...markersOpenApiPaths(),
        ...compactOpenApiPaths(),
        ...branchSummaryOpenApiPaths(),
        ...contextOpenApiPaths(),
        ...approvalsOpenApiPaths(),
        ...usageOpenApiPaths(),
        ...modelsOpenApiPaths(),
        ...feedbackOpenApiPaths(),
        ...evalCasesOpenApiPaths(),
        ...brandingOpenApiPaths(),
        ...agentRosterOpenApiPaths(),
        ...agentOwnershipOpenApiPaths(),
        ...projectCommitsOpenApiPaths(),
        ...teamDefaultAgentOpenApiPaths(),
        ...egressAccessOpenApiPaths(),
        ...threadFileLinksOpenApiPaths(),
        ...semanticMemoryOpenApiPaths(),
      },
      catalogOpenApiPaths(),
    ),
    components: {
      schemas: mergeSchemas(
        {
          ...threadsOpenApiSchemas(),
          ...threadFoldersOpenApiSchemas(),
          ...runsOpenApiSchemas(),
          ...pendingOpenApiSchemas(),
          ...markersOpenApiSchemas(),
          ...compactOpenApiSchemas(),
          ...branchSummaryOpenApiSchemas(),
          ...contextOpenApiSchemas(),
          ...approvalsOpenApiSchemas(),
          ...usageOpenApiSchemas(),
          ...modelsOpenApiSchemas(),
          ...feedbackOpenApiSchemas(),
          ...evalCasesOpenApiSchemas(),
          ...brandingOpenApiSchemas(),
          ...agentRosterOpenApiSchemas(),
          ...projectCommitsOpenApiSchemas(),
          ...teamDefaultAgentOpenApiSchemas(),
          ...egressAccessOpenApiSchemas(),
          ...threadFileLinksOpenApiSchemas(),
          ...semanticMemoryOpenApiSchemas(),
        },
        catalogOpenApiSchemas(),
      ),
      responses: catalogOpenApiResponses(),
      securitySchemes: {
        session: { type: "apiKey", in: "cookie", name: "better-auth.session_token" },
      },
    },
    security: [{ session: [] }],
  };
}
