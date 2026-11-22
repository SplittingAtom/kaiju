import type { CatalogArea } from "./build.js";
import { connectorGrantsDetails, filesDetails, meDetails, setupDetails } from "./details/me.js";

/**
 * OpenAPI catalog: the signed-in member's own account, files, connector keys and first-run setup
 * (KOBE-727; routes in `routes/me*.ts`, `my-*.ts`, `notifications.ts`, `uploads.ts`, `files.ts`,
 * `connector-grants.ts`, `connector-oauth.ts`, `setup.ts`).
 */
export const meAreas: readonly CatalogArea[] = [
  {
    tag: "Me",
    description:
      "The signed-in member's own account: profile, teams and invitations, preferences, time zone, " +
      "linked sign-ins and notifications. Not team-scoped except notifications (send X-Kobe-Team).",
    detailed: true,
    details: meDetails,
    entries: [
      ["get", "/v1/me", "Get the signed-in user, site role and site grants"],
      [
        "get",
        "/v1/me/connector-notices",
        "List connector tool-drift notices that concern the caller",
        "Site admins and admins of teams that enabled the connector see notices.",
      ],
      [
        "get",
        "/v1/me/invites",
        "List the caller's pending team invitations",
        "Only for a verified email address.",
      ],
      [
        "post",
        "/v1/me/invites/{teamId}/accept",
        "Accept a team invitation and join the team",
        "Answers 404 when there is no invitation for the caller.",
      ],
      [
        "post",
        "/v1/me/invites/{teamId}/decline",
        "Decline a team invitation",
        "Answers 204; 404 when there is no invitation for the caller.",
      ],
      ["get", "/v1/me/preferences", "Get the member's saved layout preferences"],
      [
        "put",
        "/v1/me/preferences",
        "Merge changes into the member's layout preferences",
        "Unknown keys or out-of-bounds values are refused with 400; large bodies with 413.",
      ],
      [
        "get",
        "/v1/me/sso/links",
        "List the single sign-on providers linked to the caller",
        "404 while single sign-on is switched off.",
      ],
      [
        "delete",
        "/v1/me/sso/links/{providerId}",
        "Unlink a single sign-on provider from the caller",
        "Refused with 409 when it is the caller's only way to sign in.",
      ],
      ["delete", "/v1/me/sso/pending-link", "Discard a sign-in link waiting for confirmation"],
      [
        "get",
        "/v1/me/sso/pending-link",
        "Show the sign-in link waiting for the caller's confirmation",
        "Answers `{pending: null}` when none is waiting.",
      ],
      [
        "post",
        "/v1/me/sso/pending-link/confirm",
        "Confirm and complete a pending sign-in link",
        "Answers 409 when the sign-in can no longer be linked.",
      ],
      ["get", "/v1/me/teams", "List the caller's teams with role, and the active team"],
      [
        "put",
        "/v1/me/teams/active",
        "Switch the session's active team",
        "403 when the caller is not a member of that team.",
      ],
      ["get", "/v1/me/time-zone", "Get the member's IANA time zone (null means UTC)"],
      ["put", "/v1/me/time-zone", "Set the member's IANA time zone"],
      [
        "get",
        "/v1/notifications",
        "List the caller's notifications in the active team",
        "Filter with `unread`, `limit` and `cursor`.",
      ],
      [
        "post",
        "/v1/notifications/read",
        "Mark notifications as read",
        'Send `{"notification_ids": [...]}` or `{"all": true}`.',
      ],
    ],
  },
  {
    tag: "Files",
    description:
      "Uploading files and reading shared files. Team-scoped: send X-Kobe-Team; needs `team.chat`.",
    detailed: true,
    teamScoped: true,
    details: filesDetails,
    entries: [
      [
        "get",
        "/v1/files/{id}",
        "Get the metadata of a shared file",
        "Readable by whoever can read the thread it was shared in.",
      ],
      [
        "get",
        "/v1/files/{id}/content",
        "Download a shared file's content",
        "File download as an attachment; 503 when the content is unavailable.",
      ],
      [
        "post",
        "/v1/uploads",
        "Upload a file (multipart form data) to private storage",
        "Answers 201 with the file; refusals are 403, 413, 422 or 503. Private to the uploader.",
      ],
    ],
  },
  {
    tag: "Connector grants",
    description:
      "A member's own API keys for connectors that use one, and the OAuth start for connectors that " +
      "use it. Team-scoped: send X-Kobe-Team; needs `team.chat`. Keys are write-only.",
    detailed: true,
    teamScoped: true,
    details: connectorGrantsDetails,
    entries: [
      ["get", "/v1/connector-grants", "List the caller's connector keys (never the key values)"],
      [
        "delete",
        "/v1/connector-grants/{connectorId}",
        "Remove the caller's stored key for a connector",
        "Answers 204; 404 when there is no key.",
      ],
      [
        "put",
        "/v1/connector-grants/{connectorId}",
        "Store or replace the caller's API key for a connector",
        "Answers 201 on first store, 200 on replace; 409 when the site provides the key; 503 without a site envelope key.",
      ],
      [
        "post",
        "/v1/connector-grants/{connectorId}/oauth/start",
        "Start an OAuth connection and get the authorization URL",
        "404 when the connector is not enabled for the team; 422 when it does not use OAuth; 429 after too many attempts by the caller (30 per 10 minutes).",
      ],
    ],
  },
  {
    tag: "Setup",
    description: "First-run site setup. Unauthenticated; it disables itself once an Owner exists.",
    detailed: true,
    // Unauthenticated: no 401; a wrong token is 403 and a bad body 400 (listed per operation).
    defaultErrors: [],
    details: setupDetails,
    entries: [
      ["get", "/v1/setup", "Report whether first-run setup is still required"],
      [
        "post",
        "/v1/setup",
        "Create the site's Owner account during first-run setup",
        "Needs the site's setup token. Answers 201; 409 once set up, 403 on a wrong token.",
      ],
    ],
  },
];
