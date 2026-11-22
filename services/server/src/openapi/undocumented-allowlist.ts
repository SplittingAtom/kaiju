/**
 * Mounted routes the OpenAPI document deliberately leaves out (KOBE-727), each with its reason.
 * `coverage.test.ts` fails on a mounted route that is neither documented nor listed here, on an
 * entry that matches no mounted route (stale) and on an entry that matches a documented route.
 *
 * `route` is `METHOD /path` in OpenAPI form (`{param}`); `*` as the method matches any method,
 * and a path ending in `/*` matches that prefix and everything under it. Prefix wildcards are for
 * the sandbox-facing and internal listeners only: on the user-facing listener every entry names
 * one route (KOBE-771).
 */

export type AllowlistCategory =
  | "probe"
  | "auth-provider"
  | "scim"
  | "oauth"
  | "telemetry"
  | "fallback"
  | "sandbox-listener"
  | "internal-listener";

export interface AllowlistEntry {
  readonly route: string;
  readonly category: AllowlistCategory;
  readonly reason: string;
}

/**
 * SCIM provisioning (`routes/scim.ts`), one by one (KOBE-771) so a new route under the prefix
 * cannot hide behind a wildcard.
 */
const SCIM_ROUTES = [
  "GET /v1/scim/v2/{slug}/ServiceProviderConfig",
  "GET /v1/scim/v2/{slug}/ResourceTypes",
  "GET /v1/scim/v2/{slug}/ResourceTypes/{id}",
  "GET /v1/scim/v2/{slug}/Schemas",
  "GET /v1/scim/v2/{slug}/Schemas/{id}",
  "GET /v1/scim/v2/{slug}/Users",
  "POST /v1/scim/v2/{slug}/Users",
  "GET /v1/scim/v2/{slug}/Users/{id}",
  "PUT /v1/scim/v2/{slug}/Users/{id}",
  "PATCH /v1/scim/v2/{slug}/Users/{id}",
  "DELETE /v1/scim/v2/{slug}/Users/{id}",
] as const;

export const UNDOCUMENTED_ROUTES: readonly AllowlistEntry[] = [
  {
    route: "GET /healthz",
    category: "probe",
    reason: "Kubernetes liveness probe on every listener; not part of the API.",
  },
  {
    route: "GET /readyz",
    category: "probe",
    reason: "Kubernetes readiness probe; not part of the API.",
  },
  ...["GET", "POST"].map((method): AllowlistEntry => ({
    route: `${method} /api/auth/{path}`,
    category: "auth-provider",
    reason:
      "Better Auth's own handler (sign-in, sessions, passkeys, SSO callbacks), mounted as one " +
      "catch-all: its API is the library's, documented by Better Auth, not by Kobe.",
  })),
  ...SCIM_ROUTES.map((route): AllowlistEntry => ({
    route,
    category: "scim",
    reason:
      "SCIM 2.0 provisioning for identity providers (RFC 7643/7644, bearer token per provider): " +
      "the protocol is the specification; setup is in docs/guide/admin/single-sign-on.md.",
  })),
  {
    route: "GET /v1/oauth/client-metadata.json",
    category: "oauth",
    reason:
      "OAuth Client ID Metadata Document, fetched by authorization servers, never by clients " +
      "of the Kobe API.",
  },
  {
    route: "GET /v1/connector-grants/oauth/callback",
    category: "oauth",
    reason:
      "Redirect target of a connector's OAuth authorization (the provider sends the browser " +
      "here); not called by API clients. Starting the flow is documented.",
  },
  {
    route: "POST /v1/telemetry/web-vitals",
    category: "telemetry",
    reason: "Web Vitals beacon from Kobe's own web app; not an API for other clients.",
  },
  {
    route: "* /v1/site/gallery/agents/{path}",
    category: "fallback",
    reason:
      "Catch-all after the gallery routes that refuses changes to gallery agents (read-only " +
      "outside the documented gallery edit routes); not an endpoint of its own.",
  },
  {
    route: "* /v1/sandbox/*",
    category: "sandbox-listener",
    reason:
      "Sandbox-facing listener (its own port, cluster-internal, refused through the ingress): " +
      "session token trade, workspace sync, skill bundles and eval fixtures for sandboxes only.",
  },
  {
    route: "* /internal/v1/*",
    category: "internal-listener",
    reason:
      "Internal listener for the MCP proxy (its own port, keyed, NetworkPolicy-restricted): " +
      "connector calls and the policy re-check; never reachable by members or admins.",
  },
];
