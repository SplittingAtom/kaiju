import type { CatalogArea } from "./build.js";
import { sitePlatformDetails } from "./details/site-platform.js";

const CONNECTORS = "Site admins (`site.connectors.manage`).";
const EGRESS = "Site admins (`site.egress.manage`).";
const MODELS = "Site admins (`site.models.manage`).";
const POLICY = "Site admins (`site.policy.manage`).";

/** OpenAPI catalog: Site platform (KOBE-727; routes in `routes/site-*.ts`, `budgets.ts`, `usage.ts`). */
export const sitePlatformAreas: readonly CatalogArea[] = [
  {
    tag: "Site: platform",
    detailed: true,
    details: sitePlatformDetails,
    description:
      "Site-wide platform configuration for site admins: MCP connectors, model providers and " +
      "catalog, policy rules, the egress ceiling, budgets and usage.",
    entries: [
      ["get", "/v1/site/connectors", "List site MCP connectors", CONNECTORS],
      [
        "post",
        "/v1/site/connectors",
        "Register an MCP connector",
        "Site admins (`site.connectors.manage`). Probes and pins its tools; a failed probe leaves it unpinned.",
      ],
      ["delete", "/v1/site/connectors/{id}", "Delete a connector", CONNECTORS],
      ["get", "/v1/site/connectors/{id}", "Get a connector", CONNECTORS],
      [
        "patch",
        "/v1/site/connectors/{id}",
        "Update a connector",
        "Site admins (`site.connectors.manage`). A new URL clears the old pins and pins again.",
      ],
      ["post", "/v1/site/connectors/{id}/pin", "Probe and pin a connector's tools", CONNECTORS],
      ["post", "/v1/site/connectors/{id}/refresh", "Re-probe a connector now", CONNECTORS],
      [
        "delete",
        "/v1/site/connectors/{id}/site-key",
        "Remove a connector's site-wide key",
        CONNECTORS,
      ],
      [
        "put",
        "/v1/site/connectors/{id}/site-key",
        "Set or replace a connector's site-wide key",
        "Site admins (`site.connectors.manage`). Pins tools with it if unpinned.",
      ],
      ["get", "/v1/site/connectors/{id}/teams", "List teams that enabled a connector", CONNECTORS],
      [
        "get",
        "/v1/site/connectors/{id}/templates",
        "Review a connector's app templates, approved and live",
        CONNECTORS,
      ],
      [
        "post",
        "/v1/site/connectors/{id}/templates/approve",
        "Approve reviewed app templates",
        CONNECTORS,
      ],
      [
        "get",
        "/v1/site/connectors/{id}/templates/frame",
        "Preview a template in a sandboxed frame",
        "Site admins (`site.connectors.manage`). Answers HTML for Kobe's own page frame only.",
      ],
      [
        "put",
        "/v1/site/connectors/{id}/templates/placement",
        "Set where a template's app opens",
        "Site admins (`site.connectors.manage`). One of chat, artifacts or rail.",
      ],
      [
        "get",
        "/v1/site/connectors/{id}/templates/source",
        "Read a template's source for review",
        "Site admins (`site.connectors.manage`). JSON only, never served as a page.",
      ],
      [
        "get",
        "/v1/site/connectors/{id}/tools",
        "Compare approved and live tool definitions",
        CONNECTORS,
      ],
      ["post", "/v1/site/connectors/{id}/tools/approve", "Re-approve drifted tools", CONNECTORS],
      ["get", "/v1/site/egress-ceiling", "List the egress ceiling domains and presets", EGRESS],
      [
        "post",
        "/v1/site/egress-ceiling",
        "Add a domain to the egress ceiling",
        "Site admins (`site.egress.manage`). Answers 201 when new.",
      ],
      [
        "delete",
        "/v1/site/egress-ceiling/{domain}",
        "Remove a domain from the egress ceiling",
        "Site admins (`site.egress.manage`). Answers 204.",
      ],
      [
        "put",
        "/v1/site/egress-ceiling/presets/{preset}",
        "Turn an egress preset on or off",
        EGRESS,
      ],
      ["get", "/v1/site/models", "List model providers and the catalog", MODELS],
      ["post", "/v1/site/models/catalog", "Add a model to the catalog", MODELS],
      ["delete", "/v1/site/models/catalog/{alias}", "Remove a model from the catalog", MODELS],
      ["patch", "/v1/site/models/catalog/{alias}", "Update a catalog model", MODELS],
      ["post", "/v1/site/models/providers", "Add a model provider", MODELS],
      ["delete", "/v1/site/models/providers/{id}", "Delete a model provider", MODELS],
      ["patch", "/v1/site/models/providers/{id}", "Update a model provider", MODELS],
      ["get", "/v1/site/models/providers/{id}/models", "List models a provider offers", MODELS],
      [
        "post",
        "/v1/site/models/providers/{id}/models/refresh",
        "Refresh a provider's model list",
        MODELS,
      ],
      ["get", "/v1/site/policy/remember-limits", "Read the site's memory remember limits", POLICY],
      ["put", "/v1/site/policy/remember-limits", "Set the site's memory remember limits", POLICY],
      ["get", "/v1/site/policy/rules", "List site policy rules", POLICY],
      ["post", "/v1/site/policy/rules", "Add a site policy rule", POLICY],
      [
        "delete",
        "/v1/site/policy/rules/{id}",
        "Delete a site policy rule",
        "Site admins (`site.policy.manage`). Answers 204.",
      ],
      ["put", "/v1/site/policy/rules/{id}", "Replace a site policy rule", POLICY],
      ["get", "/v1/site/policy/settings", "Read site policy settings", POLICY],
      ["put", "/v1/site/policy/settings", "Change site policy settings", POLICY],
      [
        "get",
        "/v1/site/budget",
        "Read the site's budget limits",
        "Site admins (`site.budgets.manage`).",
      ],
      [
        "put",
        "/v1/site/budget",
        "Set the site's budget limits",
        "Site admins (`site.budgets.manage`).",
      ],
      [
        "get",
        "/v1/site/usage",
        "Show model usage summed over every team",
        "Site admins (`site.usage.read`).",
      ],
    ],
  },
];
