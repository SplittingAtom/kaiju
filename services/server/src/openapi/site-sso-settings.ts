import { z } from "zod";
import { ssoSettingsSchema } from "../routes/site-sso.js";

/**
 * OpenAPI for the "Require single sign-on" Site setting (KOBE-774), generated from the route's zod
 * schema. The provider routes beside it (`/v1/site/sso/providers`) are not described yet.
 */

type JsonSchema = Record<string, unknown>;

const schemaOf = (schema: z.ZodType, io: "input" | "output"): JsonSchema => {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, {
    io,
    target: "draft-2020-12",
  }) as JsonSchema;
  return rest;
};

const json = (schemaName: string, description: string) => ({
  description,
  content: { "application/json": { schema: { $ref: `#/components/schemas/${schemaName}` } } },
});

const settings = json("SiteSsoSettings", "The setting and whether it can be turned on.");

const ssoSettingsView = z.strictObject({
  requireSso: z.boolean().describe("Stored: password and passkey sign-in are off."),
  inForce: z
    .boolean()
    .describe(
      "Stored on, the chart's `auth.sso.enabled` is on, and at least one provider can finish a sign-in.",
    ),
  canTurnOn: z
    .boolean()
    .describe("This session was signed in through an enabled identity provider."),
  unlinked: z
    .strictObject({
      owners: z.number().int().nonnegative(),
      siteRoles: z.number().int().nonnegative(),
      users: z.number().int().nonnegative(),
    })
    .describe(
      "Active accounts (and of them site-role holders and Owners) with no identity at an enabled provider: they could not sign in while it is on. Counts only.",
    ),
});

export function siteSsoSettingsOpenApiPaths(): Record<string, Record<string, unknown>> {
  const common = {
    "401": json("Error", "`unauthenticated`: no session."),
    "403": json("Error", "`forbidden`: not an Owner or Admin."),
    "404": json("Error", "`not_found`: single sign-on is off (`auth.sso.enabled: false`)."),
  };
  return {
    "/v1/site/sso/settings": {
      get: {
        operationId: "getSiteSsoSettings",
        summary: "Whether the Site requires single sign-on",
        description: "Needs `site.users.manage`.",
        responses: { "200": settings, ...common },
      },
      put: {
        operationId: "putSiteSsoSettings",
        summary: "Require single sign-on, or stop requiring it",
        description:
          "Needs `site.users.manage`; turning it off needs the Owner. Turning it on works only " +
          "from a session signed in through an enabled identity provider, and ends every session " +
          "that was not (`identity.sso.required.enabled`). While in force the server refuses " +
          "password sign-in, password reset, invitation acceptance and passkey sign-in " +
          "(`403 SSO_REQUIRED` on `/api/auth/*`). It turns itself off when the last enabled " +
          "provider is disabled or deleted, and `kobe sso allow-local-sign-in` turns it off " +
          "with cluster access (`identity.sso.required.disabled`). While it is stored on, the " +
          "Owner keeps an identity at an enabled provider: disabling or deleting the Owner's only " +
          "one answers 409 `owner_would_lose_sign_in`, transferring ownership to an unlinked user " +
          "409 `owner_not_linked`, unlinking an account's only usable identity 409 " +
          "`last_sign_in_method`.",
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/PutSiteSsoSettingsBody" } },
          },
        },
        responses: {
          "200": settings,
          "400": json("Error", "`invalid_request`: `requireSso` missing or not a boolean."),
          ...common,
          "403": json(
            "Error",
            "`forbidden`: not an Owner or Admin, or an Admin turning it off (Owner only).",
          ),
          "409": json(
            "Error",
            "`sso_session_required`: turning it on from a session not signed in through an enabled identity provider; `owners_not_linked`: an active Owner has no identity at an enabled provider (the message gives how many).",
          ),
        },
      },
    },
  };
}

export function siteSsoSettingsOpenApiSchemas(): Record<string, JsonSchema> {
  return {
    SiteSsoSettings: schemaOf(ssoSettingsView, "output"),
    PutSiteSsoSettingsBody: schemaOf(ssoSettingsSchema, "input"),
  };
}
