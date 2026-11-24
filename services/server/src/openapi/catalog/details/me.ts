import { z } from "zod";
import { CONNECTOR_GRANT_KIND_VALUES, SSO_LINKED_VIA } from "@kobe/db";
import {
  listNotificationsQuerySchema,
  listNotificationsResponseSchema,
  markNotificationsReadBodySchema,
  markNotificationsReadResponseSchema,
  sharedFileSchema,
  SITE_GRANTS,
  TEAM_ROLES,
  uiPreferencesResponseSchema,
  uiPreferencesSchema,
  uploadResponseSchema,
} from "@kobe/protocol";
import { putGrantSchema } from "../../../connectors/grants.js";
import { oauthStartBodySchema } from "../../../routes/connector-oauth.js";
import { timeZoneBodySchema } from "../../../routes/me.js";
import { setupSchema } from "../../../routes/setup.js";
import { activeTeamSchema } from "../../../teams/schemas.js";
import { named, untyped, type CatalogDetail } from "../build.js";
import { arr, bool, dateTime, int, nullable, obj, oneOfStrings, str, uuid } from "../json.js";

/**
 * Request and response schemas of the member's own catalog areas (KOBE-771): Me, Files,
 * Connector grants and Setup. Bodies come from the zod schemas the routes validate with and the
 * `@kobe/protocol` contracts; `untyped(...)` marks answers the routes build without a schema
 * (fields read from the handler and the helpers it calls).
 */

const teamRole = oneOfStrings(...TEAM_ROLES);
/** A boolean the handler always sends as `true`. */
const alwaysTrue = { type: "boolean", const: true };

const CurrentUser = untyped(
  "CurrentUser",
  obj({
    user: obj({ id: uuid, email: str, name: str, twoFactorEnabled: bool }),
    siteRole: nullable(oneOfStrings("owner", "admin")),
    siteGrants: arr(oneOfStrings(...SITE_GRANTS)),
    "siteFeatures?": arr(oneOfStrings("sso")),
  }),
);

const driftNotice = obj({
  connectorId: uuid,
  name: str,
  tools: arr(str),
  templates: arr(str),
  invalidTemplates: arr(obj({ uri: str, reason: str })),
  "refreshSkipped?": oneOfStrings("auth_required"),
  "templatesSkipped?": str,
});

const UiPreferences = named("UiPreferences", uiPreferencesResponseSchema);
const MemberTimeZone = untyped("MemberTimeZone", obj({ time_zone: nullable(str) }));

const ssoLink = obj({
  providerId: uuid,
  providerName: str,
  linkedVia: oneOfStrings(...SSO_LINKED_VIA),
  emailAtLink: nullable(str),
  linkedAt: dateTime,
  lastSignInAt: nullable(dateTime),
});

// Every `/v1/me/sso/*` route answers 404 while single sign-on is switched off.
const SSO_OFF = "404" as const;

export const meDetails: Readonly<Record<string, CatalogDetail>> = {
  "get /v1/me": { response: CurrentUser },
  "get /v1/me/connector-notices": {
    response: untyped("ConnectorDriftNoticeList", obj({ notices: arr(driftNotice) })),
    responseDescription:
      "`refreshSkipped` and `templatesSkipped` are sent to site admins only (tool names, never definitions).",
  },
  "get /v1/me/invites": {
    response: untyped(
      "MyTeamInvitationList",
      obj({
        invitations: arr(
          obj({
            teamId: uuid,
            teamSlug: str,
            teamName: str,
            role: teamRole,
            invitedByName: str,
            expiresAt: dateTime,
          }),
        ),
      }),
    ),
    responseDescription: "Empty while the caller's email address is not verified.",
  },
  "post /v1/me/invites/{teamId}/accept": {
    body: null,
    response: untyped("AcceptedTeamInvitation", obj({ teamId: uuid, role: teamRole })),
    errors: ["404"],
  },
  "post /v1/me/invites/{teamId}/decline": { body: null, status: 204, errors: ["404"] },
  "get /v1/me/preferences": { response: UiPreferences },
  "put /v1/me/preferences": {
    body: named("UiPreferencesBody", uiPreferencesSchema),
    response: UiPreferences,
    responseDescription: "All saved preferences after the merge.",
    errors: ["413"],
  },
  "get /v1/me/sso/links": {
    response: untyped("SsoLinkList", obj({ links: arr(ssoLink) })),
    errors: [SSO_OFF],
  },
  "delete /v1/me/sso/links/{providerId}": {
    response: untyped("SsoUnlinked", obj({ unlinked: alwaysTrue, sessionsEnded: int })),
    responseDescription: "Unlinked; `sessionsEnded` sessions made through the provider were ended.",
    errors: [SSO_OFF, "409"],
  },
  "delete /v1/me/sso/pending-link": {
    response: untyped("SsoPendingLinkDiscarded", obj({ discarded: alwaysTrue })),
    errors: [SSO_OFF],
  },
  "get /v1/me/sso/pending-link": {
    response: untyped(
      "SsoPendingLink",
      obj({ pending: nullable(obj({ providerId: uuid, providerName: str, email: str })) }),
    ),
    errors: [SSO_OFF],
  },
  "post /v1/me/sso/pending-link/confirm": {
    body: null,
    response: untyped("SsoPendingLinkConfirmed", obj({ linked: alwaysTrue, providerId: uuid })),
    errors: [SSO_OFF, "409"],
  },
  "get /v1/me/teams": {
    response: untyped(
      "MyTeamList",
      obj({
        activeTeamId: nullable(uuid),
        lastTeamId: nullable(uuid),
        teams: arr(
          obj({ id: uuid, slug: str, name: str, role: teamRole, registry: bool, chatReady: bool }),
        ),
      }),
    ),
    responseDescription:
      "`activeTeamId` is the session's team and `lastTeamId` the user's last one; either is null " +
      "when unset or no longer one of the user's teams.",
  },
  "put /v1/me/teams/active": {
    body: named("SetActiveTeamBody", activeTeamSchema),
    response: untyped("ActiveTeam", obj({ activeTeamId: uuid, role: teamRole })),
  },
  "get /v1/me/time-zone": { response: MemberTimeZone },
  "put /v1/me/time-zone": {
    body: named("SetTimeZoneBody", timeZoneBodySchema),
    response: MemberTimeZone,
  },
  "get /v1/notifications": {
    query: listNotificationsQuerySchema,
    response: named("NotificationList", listNotificationsResponseSchema),
    teamScoped: true,
  },
  "post /v1/notifications/read": {
    body: named("MarkNotificationsReadBody", markNotificationsReadBodySchema),
    response: named("MarkNotificationsReadResponse", markNotificationsReadResponseSchema),
    teamScoped: true,
  },
};

export const filesDetails: Readonly<Record<string, CatalogDetail>> = {
  "get /v1/files/{id}": {
    response: named("SharedFileDetail", sharedFileSchema.extend({ thread_id: z.uuid() })),
    errors: ["404"],
  },
  "get /v1/files/{id}/content": {
    produces: "application/octet-stream",
    responseDescription: "The file's bytes as an attachment (`nosniff`, not cached).",
    errors: ["404", "503"],
  },
  "post /v1/uploads": {
    body: null,
    multipart: {
      thread_id: {
        type: "string",
        format: "uuid",
        description: "Optional: the thread to attach to.",
      },
      file: { type: "string", format: "binary", description: "One file part (any field name)." },
    },
    status: 201,
    response: named("UploadResponse", uploadResponseSchema),
    responseDescription:
      "Send multipart/form-data with an optional `thread_id` text field and one file part. " +
      "Refusals with an upload code (`file_too_large`, `quota_exceeded`, `scan_rejected`, " +
      "`scan_unavailable`) also carry `limit_bytes` where it applies.",
    errors: ["404", "413", "422", "429", "503", "507"],
  },
};

const grantSummary = obj({
  connector_id: uuid,
  hint: str,
  kind: oneOfStrings(...CONNECTOR_GRANT_KIND_VALUES),
  expires_at: nullable(dateTime),
  created_at: dateTime,
  updated_at: dateTime,
});
/** The list adds whether Kaiju renews an OAuth grant by itself (KOBE-835). */
const listedGrant = obj({
  connector_id: uuid,
  hint: str,
  kind: oneOfStrings(...CONNECTOR_GRANT_KIND_VALUES),
  expires_at: nullable(dateTime),
  refreshable: bool,
  created_at: dateTime,
  updated_at: dateTime,
});

const ConnectorGrantEnvelope = untyped("ConnectorGrantEnvelope", obj({ grant: grantSummary }));

export const connectorGrantsDetails: Readonly<Record<string, CatalogDetail>> = {
  "get /v1/connector-grants": {
    response: untyped("ConnectorGrantList", obj({ grants: arr(listedGrant) })),
  },
  "delete /v1/connector-grants/{connectorId}": { status: 204, errors: ["404"] },
  "put /v1/connector-grants/{connectorId}": {
    body: named("PutConnectorGrantBody", putGrantSchema),
    response: ConnectorGrantEnvelope,
    responseDescription: "An existing key was replaced.",
    otherSuccess: { "201": { response: ConnectorGrantEnvelope, description: "The key is new." } },
    errors: ["404", "409", "422", "503"],
  },
  "post /v1/connector-grants/{connectorId}/oauth/start": {
    body: named("ConnectorOauthStartBody", oauthStartBodySchema),
    response: untyped("ConnectorOauthStart", obj({ authorization_url: str })),
    responseDescription:
      "Send the browser to `authorization_url`. The callback brings it back to My connectors, or (`return_to: site`, site admins) to the Site console's connector registry.",
    errors: ["400", "404", "422", "429", "502", "503"],
  },
};

export const setupDetails: Readonly<Record<string, CatalogDetail>> = {
  "get /v1/setup": { response: untyped("SetupStatus", obj({ required: bool })) },
  "post /v1/setup": {
    body: named("SetupBody", setupSchema),
    status: 201,
    response: untyped("SetupOwnerCreated", obj({ userId: uuid })),
    responseDescription: "The Owner was created; sign in with the email and password sent.",
    errors: ["400", "403", "409", "429"],
  },
};
