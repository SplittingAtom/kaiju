import { z } from "zod";
import {
  CONNECTOR_CREDENTIAL_SOURCES,
  EGRESS_PRESETS,
  MODEL_PROVIDER_KINDS,
  UI_RESOURCE_FAILURES,
  UI_RESOURCE_PLACEMENTS,
  USAGE_KINDS,
  connectorExposure,
  pinnedToolAnnotationsSchema,
} from "@kobe/db";
import {
  THINKING_CONTROLS,
  THINKING_LEVELS,
  THINKING_LOWEST,
  rememberLimitsSchema,
} from "@kobe/protocol";
import { approveSchema } from "../../../connectors/reapproval.js";
import { AUTH_KINDS, STATUSES, createSchema, updateSchema } from "../../../connectors/registry.js";
import { putGrantSchema } from "../../../connectors/grants.js";
import { setPlacementSchema } from "../../../connectors/template-placement.js";
import { approveTemplatesSchema } from "../../../connectors/template-review.js";
import { addCeilingBodySchema, ceilingMembershipBodySchema } from "../../../egress/schemas.js";
import {
  addCatalogSchema,
  addProviderSchema,
  updateCatalogSchema,
  updateProviderSchema,
} from "../../../models/schemas.js";
import { policySettingsBodySchema, siteRuleBodySchema } from "../../../policy/schemas.js";
import { PIN_MESSAGES } from "../../../routes/connector-messages.js";
import { siteSchema } from "../../../routes/budgets.js";
import { querySchema as usageQuerySchema } from "../../../routes/usage.js";
import { jsonSchemaOf, named, untyped, type CatalogDetail } from "../build.js";
import { arr, bool, dateTime, int, nullable, num, obj, oneOfStrings, str, uuid } from "../json.js";

/**
 * Request and response schemas of the "Site: platform" catalog area (KOBE-771): site MCP
 * connectors, model providers and catalog, policy rules, the egress ceiling, budgets and usage.
 * Bodies are the zod schemas the routes validate with; answers the routes build by hand are
 * `untyped(...)` with the fields the handlers (and the stores they call) send.
 */

// --- Connectors ------------------------------------------------------------------------------

const connectorView = obj({
  id: uuid,
  name: str,
  url: str,
  iconUrl: nullable(str),
  authKind: oneOfStrings(...AUTH_KINDS),
  credentialSource: oneOfStrings(...CONNECTOR_CREDENTIAL_SOURCES),
  siteKeyHint: nullable(str),
  siteKeyStale: bool,
  status: oneOfStrings(...STATUSES),
  toolCount: int,
  driftedCount: int,
  templatesDriftedCount: int,
  templatesCount: int,
  refreshSkipped: nullable(str),
  refreshedAt: nullable(dateTime),
  templatesSkipped: nullable(str),
  createdAt: dateTime,
  updatedAt: dateTime,
});

/** `pinBody`: what pinning did (Kobe's own sentence on failure, never the server's text). */
const pinResult = {
  anyOf: [
    obj({ ok: { type: "boolean", const: true }, tools: int, "templates?": int }),
    obj({
      ok: { type: "boolean", const: false },
      failure: oneOfStrings(...Object.keys(PIN_MESSAGES)),
      message: str,
    }),
  ],
};

const ConnectorEnvelope = untyped("SiteConnectorEnvelope", obj({ connector: connectorView }));
const ConnectorWithPin = untyped(
  "SiteConnectorWithPin",
  obj({ connector: connectorView, "pin?": pinResult }),
);

const toolDefinition = {
  title: str,
  description: str,
  inputSchema: { type: "object", description: "The tool's JSON Schema for its input." },
  annotations: jsonSchemaOf(pinnedToolAnnotationsSchema, "output"),
  ui: obj({ "resourceUri?": str, "visibility?": arr(str) }),
};
const toolDefinitionSchema = obj({
  "title?": toolDefinition.title,
  description: toolDefinition.description,
  inputSchema: toolDefinition.inputSchema,
  annotations: toolDefinition.annotations,
  "ui?": toolDefinition.ui,
});
const toolReview = obj({
  name: str,
  status: oneOfStrings("pinned", "drifted"),
  change: nullable(oneOfStrings("changed", "added")),
  "approved?": toolDefinitionSchema,
  "live?": obj({
    "title?": toolDefinition.title,
    description: toolDefinition.description,
    inputSchema: toolDefinition.inputSchema,
    annotations: toolDefinition.annotations,
    "ui?": toolDefinition.ui,
    sha256: str,
  }),
});

const templateVersionFields = {
  sha256: str,
  pinnedHash: str,
  bytes: int,
  mimeType: str,
  meta: {
    type: "object",
    description: "The declared `_meta.ui` (csp, permissions, domain, prefersBorder), as pinned.",
  },
};
const templateVersion = obj(templateVersionFields);
const templateReview = obj({
  uri: str,
  status: oneOfStrings("pinned", "drifted"),
  change: nullable(oneOfStrings("changed", "added", "invalid")),
  "approved?": templateVersion,
  "live?": templateVersion,
  "invalid?": oneOfStrings(...UI_RESOURCE_FAILURES),
  placement: oneOfStrings(...UI_RESOURCE_PLACEMENTS),
});
const sourceVersion = obj({ ...templateVersionFields, html: str });

const reprobeOutcome = obj({
  status: oneOfStrings("unchanged", "drifted", "pinned"),
  "changed?": int,
  "added?": int,
  "removed?": int,
  "tools?": int,
  "templates?": {
    description: "`pinned`: how many templates were pinned; `drifted`: template changes to review.",
    anyOf: [int, obj({ changed: int, added: int, removed: int, invalid: int })],
  },
  message: str,
});

const approvedNames = (name: string) => untyped(name, obj({ approved: arr(str) }));

const connectorsDetails: Readonly<Record<string, CatalogDetail>> = {
  "get /v1/site/connectors": {
    response: untyped("SiteConnectorList", obj({ connectors: arr(connectorView) })),
  },
  "post /v1/site/connectors": {
    body: named("CreateSiteConnectorBody", createSchema),
    status: 201,
    response: ConnectorWithPin,
    responseDescription: "Registered; `pin` says whether its tools were probed and pinned.",
    errors: ["409", "422"],
  },
  "delete /v1/site/connectors/{id}": {
    response: untyped(
      "SiteConnectorRemoval",
      obj({ removed: bool, soft: bool, teams: int, message: str }),
    ),
    responseDescription:
      "Soft-deleted: kept disabled, its name reserved; `teams` had it enabled when removed.",
    errors: ["404"],
  },
  "get /v1/site/connectors/{id}": { response: ConnectorEnvelope, errors: ["404"] },
  "patch /v1/site/connectors/{id}": {
    body: named("UpdateSiteConnectorBody", updateSchema),
    response: ConnectorWithPin,
    errors: ["404", "409", "422"],
  },
  "post /v1/site/connectors/{id}/pin": {
    body: null,
    response: untyped("SiteConnectorPin", obj({ connector: connectorView, pin: pinResult })),
    responseDescription:
      "Pinned (or already pinned); the same body comes with 502 when the probe failed.",
    errors: ["404", "502"],
  },
  "post /v1/site/connectors/{id}/refresh": {
    body: null,
    response: untyped(
      "SiteConnectorRefresh",
      obj({ refresh: reprobeOutcome, connector: connectorView }),
    ),
    errors: ["404", "409", "429", "502"],
  },
  "delete /v1/site/connectors/{id}/site-key": { status: 204, errors: ["404"] },
  "put /v1/site/connectors/{id}/site-key": {
    body: named("SiteConnectorKeyBody", putGrantSchema),
    response: untyped(
      "SiteConnectorKeySet",
      obj({ connector: connectorView, replaced: bool, "pin?": pinResult }),
    ),
    errors: ["404", "409", "503"],
  },
  "get /v1/site/connectors/{id}/teams": {
    response: untyped(
      "SiteConnectorTeamList",
      obj({
        teams: arr(
          obj({
            id: uuid,
            name: str,
            slug: str,
            exposure: oneOfStrings(...connectorExposure.enumValues),
            enabled_tools: int,
          }),
        ),
      }),
    ),
    errors: ["404"],
  },
  "get /v1/site/connectors/{id}/templates": {
    response: untyped("SiteConnectorTemplateReviews", obj({ templates: arr(templateReview) })),
    errors: ["404"],
  },
  "post /v1/site/connectors/{id}/templates/approve": {
    body: named("ApproveSiteConnectorTemplatesBody", approveTemplatesSchema),
    response: approvedNames("SiteConnectorTemplatesApproved"),
    errors: ["404", "409"],
  },
  "get /v1/site/connectors/{id}/templates/frame": {
    query: {
      uri: { type: "string", description: "The template's ui:// URI." },
      version: { type: "string", enum: ["live", "approved"], description: "Which bytes." },
      sha256: {
        type: "string",
        description: "The hash the source read showed; another one is 409 `stale`.",
      },
    },
    requiredQuery: ["uri", "version"],
    produces: "text/html",
    responseDescription: "The template in the app frame's document (sandboxed, header CSP).",
    errors: ["404", "409"],
  },
  "put /v1/site/connectors/{id}/templates/placement": {
    body: named("SiteConnectorTemplatePlacementBody", setPlacementSchema),
    response: untyped(
      "SiteConnectorTemplatePlacement",
      obj({ uri: str, placement: oneOfStrings(...UI_RESOURCE_PLACEMENTS) }),
    ),
    errors: ["404"],
  },
  "get /v1/site/connectors/{id}/templates/source": {
    query: { uri: { type: "string", description: "The template's ui:// URI." } },
    requiredQuery: ["uri"],
    response: untyped(
      "SiteConnectorTemplateSource",
      obj({ source: obj({ uri: str, "approved?": sourceVersion, "live?": sourceVersion }) }),
    ),
    responseDescription: "The template's bytes as JSON text (never served as a page).",
    errors: ["404"],
  },
  "get /v1/site/connectors/{id}/tools": {
    response: untyped("SiteConnectorToolReviews", obj({ tools: arr(toolReview) })),
    errors: ["404"],
  },
  "post /v1/site/connectors/{id}/tools/approve": {
    body: named("ApproveSiteConnectorToolsBody", approveSchema),
    response: approvedNames("SiteConnectorToolsApproved"),
    errors: ["404", "409"],
  },
};

// --- Egress ceiling ----------------------------------------------------------------------------

const ceilingEntry = obj({
  domain: str,
  preset: nullable(oneOfStrings(...EGRESS_PRESETS)),
  in_ceiling: bool,
  internal: bool,
  note: nullable(str),
  shared_hosting: bool,
  created_by: nullable(uuid),
  created_at: dateTime,
  updated_at: dateTime,
});
const Ceiling = untyped(
  "SiteEgressCeiling",
  obj({ domains: arr(ceilingEntry), presets: arr(oneOfStrings(...EGRESS_PRESETS)) }),
);

const CeilingAdded = untyped(
  "SiteEgressCeilingAdded",
  obj({ domain: ceilingEntry, warnings: arr(str) }),
);

const egressDetails: Readonly<Record<string, CatalogDetail>> = {
  "get /v1/site/egress-ceiling": { response: Ceiling },
  "post /v1/site/egress-ceiling": {
    body: named("AddSiteEgressCeilingDomainBody", addCeilingBodySchema),
    status: 201,
    response: CeilingAdded,
    responseDescription: "The domain is new in the ceiling; `warnings` names shared hosting.",
    otherSuccess: {
      "200": {
        response: CeilingAdded,
        description:
          "A listed domain (out of the ceiling) was put back in; `warnings` names shared hosting.",
      },
    },
    errors: ["409"],
  },
  "delete /v1/site/egress-ceiling/{domain}": { status: 204, errors: ["404", "409"] },
  "put /v1/site/egress-ceiling/presets/{preset}": {
    body: named("SiteEgressPresetMembershipBody", ceilingMembershipBodySchema),
    response: Ceiling,
    errors: ["404"],
  },
};

// --- Models ------------------------------------------------------------------------------------

const providerView = obj({
  id: str,
  kind: oneOfStrings(...MODEL_PROVIDER_KINDS),
  name: str,
  base_url: nullable(str),
  allow_private_network: bool,
  key_set: bool,
  key_revision: int,
  gateway_provider: str,
  created_at: dateTime,
  updated_at: dateTime,
});
const price = nullable(num);
const catalogView = obj({
  alias: str,
  provider_id: str,
  model: str,
  label: nullable(str),
  input_modalities: arr(str),
  max_output_tokens: nullable(int),
  context_window: nullable(int),
  reasoning: bool,
  thinking: obj({
    control: oneOfStrings(...THINKING_CONTROLS),
    allowed: bool,
    default: nullable(oneOfStrings(...THINKING_LEVELS)),
    max: nullable(oneOfStrings(...THINKING_LEVELS)),
    lowest: oneOfStrings(...THINKING_LOWEST),
  }),
  gateway_model: str,
  input_usd_per_mtok: price,
  output_usd_per_mtok: price,
  cache_read_usd_per_mtok: price,
  cache_write_usd_per_mtok: price,
  created_at: dateTime,
  updated_at: dateTime,
});
const Provider = untyped("SiteModelProviderEnvelope", obj({ provider: providerView }));
const CatalogModel = untyped("SiteCatalogModelEnvelope", obj({ model: catalogView }));
const ProviderModels = untyped(
  "SiteProviderModels",
  obj({
    provider_id: str,
    models: arr(str),
    image_models: arr(str),
    discovery: oneOfStrings("ok", "failed", "unknown"),
    detail: nullable(str),
    truncated: bool,
  }),
);

const modelsDetails: Readonly<Record<string, CatalogDetail>> = {
  "get /v1/site/models": {
    response: untyped(
      "SiteModels",
      obj({
        providers: arr(providerView),
        catalog: arr(catalogView),
        gateway: obj({
          desired_version: int,
          synced_version: int,
          in_sync: bool,
          last_synced_at: nullable(dateTime),
          last_attempt_at: nullable(dateTime),
          last_error: nullable(str),
        }),
        configured: bool,
        token_defaults: obj({
          max_output_tokens: int,
          reasoning_max_output_tokens: int,
          context_window: int,
        }),
      }),
    ),
  },
  "post /v1/site/models/catalog": {
    body: named("AddSiteCatalogModelBody", addCatalogSchema),
    status: 201,
    response: CatalogModel,
    errors: ["404", "409"],
  },
  "delete /v1/site/models/catalog/{alias}": { status: 204, errors: ["404"] },
  "patch /v1/site/models/catalog/{alias}": {
    body: named("UpdateSiteCatalogModelBody", updateCatalogSchema),
    response: CatalogModel,
    errors: ["404", "409"],
  },
  "post /v1/site/models/providers": {
    body: named("AddSiteModelProviderBody", addProviderSchema),
    status: 201,
    response: Provider,
    errors: ["409", "503"],
  },
  "delete /v1/site/models/providers/{id}": { status: 204, errors: ["404", "409"] },
  "patch /v1/site/models/providers/{id}": {
    body: named("UpdateSiteModelProviderBody", updateProviderSchema),
    response: Provider,
    errors: ["404", "503"],
  },
  "get /v1/site/models/providers/{id}/models": {
    response: ProviderModels,
    errors: ["404", "409", "503"],
  },
  "post /v1/site/models/providers/{id}/models/refresh": {
    body: null,
    response: ProviderModels,
    errors: ["404", "409", "429", "503"],
  },
};

// --- Policy ------------------------------------------------------------------------------------

const policyRule = obj({
  id: uuid,
  scope: oneOfStrings("site"),
  scope_ref: { type: "null" },
  effect: oneOfStrings("deny", "ask"),
  tool_glob: str,
  arg_pattern: nullable({
    type: "object",
    additionalProperties: str,
    description: "JSON Pointer → glob over the tool's arguments.",
  }),
  note: nullable(str),
  created_by: uuid,
  created_at: dateTime,
  expires_at: nullable(dateTime),
});
const PolicyRule = untyped("SitePolicyRuleEnvelope", obj({ rule: policyRule }));
const RuleBody = named("SitePolicyRuleBody", siteRuleBodySchema);
const PolicySettings = untyped("SitePolicySettings", obj({ promptSandboxWrites: bool }));
const RememberLimits = named("SiteRememberLimits", z.object({ limits: rememberLimitsSchema }));

const policyDetails: Readonly<Record<string, CatalogDetail>> = {
  "get /v1/site/policy/remember-limits": { response: RememberLimits },
  "put /v1/site/policy/remember-limits": {
    body: named("SiteRememberLimitsBody", rememberLimitsSchema),
    response: RememberLimits,
  },
  "get /v1/site/policy/rules": {
    response: untyped("SitePolicyRuleList", obj({ rules: arr(policyRule) })),
  },
  "post /v1/site/policy/rules": {
    body: RuleBody,
    status: 201,
    response: PolicyRule,
    errors: ["409"],
  },
  "delete /v1/site/policy/rules/{id}": { status: 204, errors: ["404"] },
  "put /v1/site/policy/rules/{id}": {
    body: RuleBody,
    response: PolicyRule,
    errors: ["404", "409"],
  },
  "get /v1/site/policy/settings": { response: PolicySettings },
  "put /v1/site/policy/settings": {
    body: named("SitePolicySettingsBody", policySettingsBodySchema),
    response: PolicySettings,
  },
};

// --- Budget and usage --------------------------------------------------------------------------

const BudgetLimits = untyped(
  "SiteBudgetLimits",
  obj({
    monthly_usd: nullable(num),
    daily_usd: nullable(num),
    monthly_tokens: nullable(int),
    daily_tokens: nullable(int),
    user_requests_per_minute: int,
    updated_at: dateTime,
  }),
);

const usageTotals = {
  calls: int,
  input_tokens: int,
  output_tokens: int,
  cache_read_tokens: int,
  cache_write_tokens: int,
  cost_usd: num,
  cost_usd_exact: str,
  unpriced_calls: int,
  estimated_calls: int,
  reasoning_tokens: int,
};

const budgetUsageDetails: Readonly<Record<string, CatalogDetail>> = {
  "get /v1/site/budget": { response: BudgetLimits },
  "put /v1/site/budget": {
    body: named("SiteBudgetBody", siteSchema),
    response: BudgetLimits,
    errors: ["409"],
  },
  "get /v1/site/usage": {
    query: usageQuerySchema,
    response: untyped(
      "SiteUsage",
      obj({
        range: obj({ from: dateTime, to: dateTime, bucket: oneOfStrings("hour", "day") }),
        totals: obj(usageTotals),
        series: arr(obj({ t: dateTime, ...usageTotals })),
        by_user: arr(
          obj({ user_id: uuid, name: nullable(str), email: nullable(str), ...usageTotals }),
        ),
        by_model: arr(obj({ model: str, ...usageTotals })),
        by_agent: arr(
          obj({
            agent_id: nullable(uuid),
            slug: nullable(str),
            scope: nullable(oneOfStrings("team", "personal", "gallery")),
            ...usageTotals,
          }),
        ),
        by_kind: arr(obj({ kind: oneOfStrings(...USAGE_KINDS), ...usageTotals })),
        by_team: arr(obj({ team_id: uuid, slug: str, name: str, ...usageTotals })),
        retention_months: {
          ...nullable(int),
          description: "Per-call usage older than this many months is deleted; null: kept.",
        },
      }),
    ),
  },
};

export const sitePlatformDetails: Readonly<Record<string, CatalogDetail>> = {
  ...connectorsDetails,
  ...egressDetails,
  ...modelsDetails,
  ...policyDetails,
  ...budgetUsageDetails,
};
