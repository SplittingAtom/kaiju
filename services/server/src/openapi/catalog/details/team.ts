import {
  BUDGET_PERIODS,
  BUDGET_SCOPES,
  BUDGET_UNITS,
  EGRESS_PRESETS,
  KAIJU_MCP_MODES,
  KAIJU_MCP_TEAM_LEVELS,
  TEAM_ROLES,
  UI_RESOURCE_PLACEMENTS,
  auditActorKind,
  connectorExposure,
  pinnedToolSchema,
} from "@kaiju/db";
import { teamEvalCapSchema } from "@kaiju/protocol";
import { z } from "zod";
import { TEAM_PERMISSIONS } from "../../../authz/permissions.js";
import { memberDeleteSchema, memberSchema, teamSchema } from "../../../routes/budgets.js";
import { callSchema, frameQuerySchema } from "../../../routes/team-apps.js";
import {
  bodySchema as enableConnectorBodySchema,
  kaijuLevelSchema,
} from "../../../routes/team-connectors.js";
import { decisionBodySchema, headersBodySchema } from "../../../routes/team-egress.js";
import { memberRoleSchema } from "../../../teams/schemas.js";
import { named, untyped, type CatalogDetail } from "../build.js";
import { arr, bool, dateTime, int, nullable, num, obj, oneOfStrings, str, uuid } from "../json.js";
import { EgressRequestDecision, EgressRequestList } from "./team-shared.js";

/**
 * Request and response schemas of the Team catalog area, first half (KOBE-771): the team and its
 * members, MCP Apps, audit, break-glass, budgets, connectors and egress. Bodies are the zod schemas
 * the routes validate with; `untyped(...)` marks answers the routes build without a schema (the
 * fields read from the handler and the store function it calls). The rest of the area is in
 * `team-admin.ts`.
 */

const role = oneOfStrings(...TEAM_ROLES);
const person = obj({ id: uuid, name: str });

// --- Team and members -------------------------------------------------------------------------

const TeamOverview = untyped(
  "TeamOverview",
  obj({
    team: obj({ id: uuid, slug: str, name: str }),
    role,
    memorySteward: bool,
    permissions: arr(oneOfStrings(...Object.keys(TEAM_PERMISSIONS))),
  }),
);

const teamMember = obj({
  userId: uuid,
  name: str,
  email: str,
  role,
  joinedAt: dateTime,
  addedVia: nullable(oneOfStrings("skill_reviewer_grant", "idp", "site_admin")),
  deactivated: bool,
  managedBy: nullable(obj({ providerId: uuid, providerName: str })),
});

const expectedRoleQuery = {
  expectedRole: {
    type: "string",
    enum: [...TEAM_ROLES],
    description: "Act only while the role is still this one (else 409 `changed_since_approval`).",
  },
};

// --- MCP Apps ---------------------------------------------------------------------------------

const memberAppView = obj({
  appId: str,
  connectorId: uuid,
  connectorName: str,
  iconUrl: nullable(str),
  tool: str,
  title: str,
  uri: str,
  sha256: str,
  placement: oneOfStrings(...UI_RESOURCE_PLACEMENTS),
});

const tool = pinnedToolSchema.shape;
const AppBridgeTools = named(
  "AppBridgeToolList",
  z.object({
    tools: z.array(
      z.object({
        name: tool.name,
        title: tool.title,
        description: z.string(),
        inputSchema: tool.input_schema,
        outputSchema: tool.output_schema,
        annotations: tool.annotations,
      }),
    ),
  }),
);

// --- Audit and break-glass --------------------------------------------------------------------

const auditQuery = {
  limit: { type: "integer", minimum: 1, maximum: 200, description: "Page size (default 50)." },
  before: { type: "integer", minimum: 1, description: "Cursor: events older than this `seq`." },
  after: {
    type: "integer",
    minimum: 0,
    description: "Cursor: events newer than this `seq`, oldest first. Not with `before`.",
  },
  action: { type: "string", description: "A known audit action (current or historical name)." },
  category: { type: "string", description: "A known audit category." },
  actorId: { type: "string", format: "uuid" },
  since: { type: "string", format: "date-time" },
  until: { type: "string", format: "date-time" },
};

const teamAuditEvent = obj({
  id: uuid,
  seq: int,
  at: dateTime,
  teamId: nullable(uuid),
  actor: obj({
    kind: oneOfStrings(...auditActorKind.enumValues),
    id: nullable(str),
    name: nullable(str),
    email: nullable(str),
  }),
  action: str,
  target: { type: "object" },
  "viaAgent?": obj({ threadId: uuid, runId: str, toolCallId: str, threadOpen: bool }),
});

const breakGlassGrant = obj({
  id: uuid,
  status: oneOfStrings("pending", "active", "denied", "revoked", "expired"),
  requestedBy: person,
  approvedBy: nullable(person),
  selfApproved: bool,
  legalHold: bool,
  scope: oneOfStrings("team", "user", "thread", "restricted"),
  subject: nullable(person),
  threadId: nullable(uuid),
  reason: nullable(str),
  startsAt: nullable(dateTime),
  expiresAt: nullable(dateTime),
  endedAt: nullable(dateTime),
});

// --- Budgets ----------------------------------------------------------------------------------

const amounts = {
  monthly_usd: nullable(num),
  daily_usd: nullable(num),
  monthly_tokens: nullable(int),
  daily_tokens: nullable(int),
};
const spend = obj({ month_usd: num, day_usd: num, month_tokens: int, day_tokens: int });

const TeamBudgets = untyped(
  "TeamBudgets",
  obj({
    period: obj({ month: str, day: str }),
    site: obj({
      user_requests_per_minute: int,
      percent_used: obj({
        month_usd: nullable(num),
        day_usd: nullable(num),
        month_tokens: nullable(num),
        day_tokens: nullable(num),
      }),
    }),
    team: obj({
      ...amounts,
      user_requests_per_minute: nullable(int),
      spent: spend,
      member_default: obj(amounts),
    }),
    effective_requests_per_minute: int,
    members: arr(
      obj({ user_id: uuid, name: nullable(str), email: nullable(str), ...amounts, spent: spend }),
    ),
    spent_by_kind: arr(obj({ kind: str, usd: num, tokens: num })),
    eval_cap: obj({ usd: nullable(num), tokens: nullable(num), month_usd: num, month_tokens: num }),
  }),
);

const budgetState = oneOfStrings("ok", "warning", "exhausted");

// --- Connectors -------------------------------------------------------------------------------

const teamConnectorTool = obj({
  pi_name: str,
  name: str,
  title: nullable(str),
  read_only: bool,
  open_world: bool,
  status: oneOfStrings("pinned", "drifted"),
  app: nullable(obj({ resource_uri: str, review: oneOfStrings("approved", "pending", "missing") })),
  model_visible: bool,
});

const teamConnector = obj({
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
  tools: arr(teamConnectorTool),
});

const KaijuTeamConnector = untyped(
  "KaijuTeamConnector",
  obj({
    kaiju: obj({
      connector_id: nullable(uuid),
      name: nullable(str),
      mode: oneOfStrings(...KAIJU_MCP_MODES),
      level: oneOfStrings(...KAIJU_MCP_TEAM_LEVELS),
      docs_tools: arr(str),
      admin_tools: arr(
        obj({ pi_name: str, title: str, scope: oneOfStrings("team", "site"), read_only: bool }),
      ),
    }),
  }),
);

// --- Egress -----------------------------------------------------------------------------------

const teamEgressEntry = obj({
  domain: str,
  preset: nullable(oneOfStrings(...EGRESS_PRESETS)),
  in_ceiling: bool,
  shared_hosting: bool,
  enabled: bool,
  enabled_by: nullable(uuid),
  enabled_at: nullable(dateTime),
  header_names: arr(str),
  headers_updated_at: nullable(dateTime),
});

const EgressDomainEnabled = untyped(
  "TeamEgressDomainEnabled",
  obj({ domain: str, enabled: { type: "boolean", const: true }, settled_requests: int }),
);

export const teamDetails: Readonly<Record<string, CatalogDetail>> = {
  "get /v1/team": { response: TeamOverview },
  "get /v1/team/members": {
    response: untyped("TeamMemberList", obj({ members: arr(teamMember) })),
  },
  "patch /v1/team/members/{userId}": {
    body: named("ChangeTeamMemberRoleBody", memberRoleSchema),
    response: untyped("TeamMemberRoleChanged", obj({ userId: uuid, role })),
    errors: ["404", "409"],
  },
  "delete /v1/team/members/{userId}": {
    query: expectedRoleQuery,
    status: 204,
    errors: ["404", "409"],
  },
  "post /v1/team/members/{userId}/take-over": {
    body: null,
    response: untyped("TeamMemberTakenOver", obj({ userId: uuid, managedBy: { type: "null" } })),
    responseDescription: "The membership is the team's own now (403 `cannot_take_over_self`).",
    errors: ["404", "409"],
  },
  "get /v1/team/sso-mappings": {
    response: untyped(
      "TeamSsoMappingList",
      obj({
        mappings: arr(
          obj({ id: uuid, providerId: uuid, providerName: str, claimValue: str, role }),
        ),
      }),
    ),
    responseDescription: "The mappings; 404 while single sign-on is switched off on the site.",
    errors: ["404"],
  },

  "get /v1/team/apps": {
    response: untyped(
      "MemberAppList",
      obj({
        apps: arr(memberAppView),
        needsKey: arr(obj({ connectorId: uuid, connectorName: str, title: str })),
      }),
    ),
  },
  "post /v1/team/apps/{appId}/calls": {
    body: named("AppCallBody", callSchema),
    response: untyped("AppCallResult", obj({ result: { type: "object" } })),
    responseDescription:
      "The tool's result. Errors here use `{error: {code, message}}`, not the plain envelope.",
    errors: ["404", "413", "422", "429", "502", "503"],
  },
  "get /v1/team/apps/{appId}/frame": {
    query: frameQuerySchema,
    produces: "text/html",
    responseDescription: "The app's sandboxed frame document (only into Kaiju's own page).",
    errors: ["404", "409"],
  },
  "get /v1/team/apps/{appId}/template": {
    response: untyped(
      "MemberAppTemplate",
      obj({ html: str, sha256: str, connectorId: uuid, uri: str }),
    ),
    errors: ["404"],
  },
  "get /v1/team/apps/{appId}/tools": {
    response: AppBridgeTools,
    errors: ["404", "429"],
  },

  "get /v1/team/audit": {
    query: auditQuery,
    response: untyped(
      "TeamAuditPage",
      obj({ events: arr(teamAuditEvent), nextCursor: nullable(str) }),
    ),
  },
  "get /v1/team/audit/export": {
    query: {
      format: { type: "string", enum: ["csv", "jsonl"] },
      since: { type: "string", format: "date-time" },
      until: { type: "string", format: "date-time" },
    },
    requiredQuery: ["format"],
    produces: "text/csv",
    responseDescription:
      "An attachment: CSV (`text/csv`) or JSONL (`application/x-ndjson`) as `format` asks.",
    errors: ["429"],
  },
  "get /v1/team/break-glass": {
    response: untyped(
      "TeamBreakGlassGrants",
      obj({ active: arr(breakGlassGrant), recent: arr(breakGlassGrant) }),
    ),
  },

  "get /v1/team/budgets": { response: TeamBudgets },
  "put /v1/team/budgets/eval-cap": {
    body: named("SetTeamEvalCapBody", z.object({ evalCap: teamEvalCapSchema })),
    response: TeamBudgets,
  },
  "delete /v1/team/budgets/members/{userId}": {
    body: named("DeleteTeamMemberBudgetBody", memberDeleteSchema),
    bodyOptional: true,
    response: TeamBudgets,
    responseDescription:
      "The budgets after the removal; with `expected`, only while the budget is still that one.",
    errors: ["404", "409"],
  },
  "put /v1/team/budgets/members/{userId}": {
    body: named("SetTeamMemberBudgetBody", memberSchema),
    response: TeamBudgets,
    errors: ["404", "409"],
  },
  "get /v1/team/budgets/status": {
    response: untyped(
      "MemberBudgetStatus",
      obj({
        state: budgetState,
        lines: arr(
          obj({
            scope: oneOfStrings(...BUDGET_SCOPES, "eval"),
            period: oneOfStrings(...BUDGET_PERIODS),
            unit: oneOfStrings(...BUDGET_UNITS),
            limit: nullable(num),
            spent: nullable(num),
            percent: num,
            state: budgetState,
          }),
        ),
      }),
    ),
  },
  "put /v1/team/budgets/team": {
    body: named("SetTeamBudgetBody", teamSchema),
    response: TeamBudgets,
    errors: ["409"],
  },

  "get /v1/team/connectors": {
    response: untyped("TeamConnectorList", obj({ connectors: arr(teamConnector) })),
  },
  "delete /v1/team/connectors/{id}": {
    query: {
      expectedExposure: {
        type: "string",
        enum: [...connectorExposure.enumValues],
        description: "Disable only while the exposure is still this one.",
      },
    },
    status: 204,
    errors: ["404", "409"],
  },
  "put /v1/team/connectors/{id}": {
    body: named("EnableTeamConnectorBody", enableConnectorBodySchema),
    response: untyped("TeamConnectorEnvelope", obj({ connector: teamConnector })),
    errors: ["404", "409", "422"],
  },
  "get /v1/team/connectors/kaiju": { response: KaijuTeamConnector },
  "put /v1/team/connectors/kaiju": {
    body: named("SetKaijuTeamLevelBody", kaijuLevelSchema),
    response: KaijuTeamConnector,
    errors: ["409"],
  },

  "get /v1/team/egress": {
    response: untyped("TeamEgress", obj({ domains: arr(teamEgressEntry), header_injection: bool })),
    responseDescription: "Header names are empty for members who are not team admins.",
  },
  "delete /v1/team/egress/domains/{domain}": {
    query: {
      expected: {
        type: "string",
        enum: ["enabled_without_headers"],
        description: "Refuse (409 `injected_headers`) rather than delete injected header values.",
      },
    },
    status: 204,
    errors: ["404", "409"],
  },
  "put /v1/team/egress/domains/{domain}": {
    body: null,
    query: {
      expected: {
        type: "string",
        enum: ["disabled"],
        description: "The approved before-state; 409 `changed_since_approval` if already enabled.",
      },
    },
    response: EgressDomainEnabled,
    responseDescription: "The domain was already enabled (nothing changed).",
    otherSuccess: {
      "201": { response: EgressDomainEnabled, description: "The domain was newly enabled." },
    },
    errors: ["409"],
  },
  "delete /v1/team/egress/domains/{domain}/headers": { status: 204, errors: ["404"] },
  "put /v1/team/egress/domains/{domain}/headers": {
    body: named("TeamEgressHeadersBody", headersBodySchema),
    response: untyped("TeamEgressHeaderNames", obj({ domain: str, header_names: arr(str) })),
    errors: ["404", "422", "503"],
  },
  "get /v1/team/egress/requests": {
    query: {
      status: {
        type: "string",
        enum: ["pending", "approved", "denied", "all"],
        default: "pending",
      },
    },
    response: EgressRequestList,
  },
  "post /v1/team/egress/requests/{id}": {
    body: named("TeamEgressDecisionBody", decisionBodySchema),
    response: EgressRequestDecision,
    errors: ["404", "409", "422"],
  },
};
