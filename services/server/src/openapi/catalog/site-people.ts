import type { CatalogArea } from "./build.js";

const MANAGE = "Site admins (`site.users.manage`).";
const SETTINGS = "Site admins (`site.settings.manage`).";
const BG = "Site admins (`site.break_glass.request`).";
const BG_APPROVE =
  "Site admins who may approve (`site.break_glass.approve`); a second admin decides.";
const HOLD = "Site admins (`site.legal_hold.manage`); placing and releasing need a second admin.";
const RETENTION = "Site admins (`site.retention.manage`).";
const AUDIT = "Site admins (`site.audit.read`).";
const TEAMS = "Site admins (`site.teams.manage`).";

/** OpenAPI catalog: Site people and compliance (KOBE-727; routes in `routes/site-*.ts`). */
export const sitePeopleAreas: readonly CatalogArea[] = [
  {
    tag: "Site: people",
    description:
      "Site console administration of people and the install: teams and their members, users, " +
      "invitations, site roles and grants, SSO and SCIM, site settings, branding and isolation. " +
      "For site admins.",
    entries: [
      ["get", "/v1/site/teams", "List every team on the site", TEAMS],
      ["post", "/v1/site/teams", "Create a team", TEAMS],
      [
        "patch",
        "/v1/site/teams/{teamId}",
        "Rename or update a team",
        "Site admins (`site.teams.manage`). The slug is immutable.",
      ],
      [
        "get",
        "/v1/site/teams/{teamId}/candidates",
        "Search users who could be added to a team",
        TEAMS,
      ],
      ["get", "/v1/site/teams/{teamId}/members", "List a team's members", TEAMS],
      [
        "post",
        "/v1/site/teams/{teamId}/members",
        "Add existing users to a team directly",
        "Site admins (`site.teams.manage`). Audited in the team's log.",
      ],
      [
        "delete",
        "/v1/site/teams/{teamId}/members/{userId}",
        "Remove a member from a team",
        "Site admins (`site.teams.manage`). Refused for the caller's own membership.",
      ],
      [
        "patch",
        "/v1/site/teams/{teamId}/members/{userId}",
        "Change a member's team role",
        "Site admins (`site.teams.manage`). Refused for the caller's own membership.",
      ],
      [
        "post",
        "/v1/site/teams/{teamId}/members/{userId}/take-over",
        "Take over a provider-managed team membership",
        "Site admins (`site.teams.manage`).",
      ],
      ["get", "/v1/site/users", "List every user on the site", MANAGE],
      ["post", "/v1/site/users/{userId}/deactivate", "Deactivate a user account", MANAGE],
      [
        "post",
        "/v1/site/users/{userId}/portable-memory/purge",
        "Purge a person's portable memory",
        "Site admins (`site.users.manage`). Needs the person's email as typed confirmation; call again to continue.",
      ],
      [
        "post",
        "/v1/site/users/{userId}/reactivate",
        "Reactivate a deactivated user account",
        MANAGE,
      ],
      ["get", "/v1/site/invites", "List site invitations", MANAGE],
      ["post", "/v1/site/invites", "Invite someone to the site", MANAGE],
      ["delete", "/v1/site/invites/{id}", "Revoke an invitation", MANAGE],
      ["post", "/v1/site/invites/{id}/resend", "Resend an invitation email", MANAGE],
      ["get", "/v1/site/roles", "List users holding a site role", MANAGE],
      [
        "put",
        "/v1/site/roles/{userId}",
        "Set a user's site role",
        "Site admins (`site.roles.manage`).",
      ],
      ["get", "/v1/site/roles/grants", "List site grants held beside the role ladder", MANAGE],
      [
        "delete",
        "/v1/site/roles/grants/{userId}/{grant}",
        "Take a site grant from a user",
        "Site admins (`site.grants.manage`).",
      ],
      [
        "put",
        "/v1/site/roles/grants/{userId}/{grant}",
        "Give a user a site grant",
        "Site admins (`site.grants.manage`).",
      ],
      [
        "post",
        "/v1/site/roles/transfer-ownership",
        "Transfer site ownership to another admin",
        "The Owner (`site.ownership.transfer`).",
      ],
      ["get", "/v1/site/sso/mappings", "List SSO group-to-team mappings", MANAGE],
      ["get", "/v1/site/sso/providers", "List SSO providers", MANAGE],
      ["post", "/v1/site/sso/providers", "Register an SSO provider", MANAGE],
      ["delete", "/v1/site/sso/providers/{id}", "Delete an SSO provider", MANAGE],
      ["get", "/v1/site/sso/providers/{id}", "Get an SSO provider", MANAGE],
      ["patch", "/v1/site/sso/providers/{id}", "Update an SSO provider", MANAGE],
      [
        "get",
        "/v1/site/sso/providers/{id}/scim",
        "Show a provider's SCIM endpoint and tokens",
        MANAGE,
      ],
      [
        "post",
        "/v1/site/sso/providers/{id}/scim/tokens",
        "Create a SCIM token for a provider",
        MANAGE,
      ],
      [
        "post",
        "/v1/site/sso/providers/{id}/scim/tokens/{tokenId}/revoke",
        "Revoke a SCIM token",
        MANAGE,
      ],
      [
        "post",
        "/v1/site/sso/providers/{id}/scim/tokens/{tokenId}/rotate",
        "Rotate a SCIM token",
        MANAGE,
      ],
      [
        "post",
        "/v1/site/sso/providers/{id}/test",
        "Test a saved SSO provider's discovery",
        "Site admins (`site.users.manage`). Rate limited.",
      ],
      [
        "post",
        "/v1/site/sso/providers/{providerId}/mappings",
        "Add an SSO group mapping to a provider",
        MANAGE,
      ],
      [
        "delete",
        "/v1/site/sso/providers/{providerId}/mappings/{mappingId}",
        "Remove an SSO group mapping",
        MANAGE,
      ],
      [
        "post",
        "/v1/site/sso/providers/test",
        "Test SSO provider settings before saving",
        "Site admins (`site.users.manage`). Rate limited.",
      ],
      [
        "delete",
        "/v1/site/sso/users/{userId}/link-expectations/{providerId}",
        "Remove a user's expected SSO link",
        MANAGE,
      ],
      [
        "put",
        "/v1/site/sso/users/{userId}/link-expectations/{providerId}",
        "Expect a user to link an SSO provider",
        MANAGE,
      ],
      ["get", "/v1/site/sso/users/{userId}/links", "List a user's SSO links", MANAGE],
      [
        "delete",
        "/v1/site/sso/users/{userId}/links/{providerId}",
        "Unlink a user from an SSO provider",
        MANAGE,
      ],
      ["get", "/v1/site/settings", "Read site settings", SETTINGS],
      [
        "put",
        "/v1/site/settings",
        "Change site settings",
        "Site admins (`site.settings.manage`). Audited; only the Owner may lower the two-factor requirement.",
      ],
      ["delete", "/v1/site/branding/assets/{kind}", "Remove a branding asset", SETTINGS],
      ["put", "/v1/site/branding/assets/{kind}", "Upload a branding asset", SETTINGS],
      [
        "post",
        "/v1/site/branding/reset",
        "Reset branding to the install defaults",
        "Site admins (`site.settings.manage`). Audited.",
      ],
      ["get", "/v1/site/isolation", "Show the sandbox isolation status", SETTINGS],
      ["post", "/v1/site/isolation/check", "Re-run the sandbox isolation check", SETTINGS],
    ],
  },
  {
    tag: "Site: compliance",
    description:
      "Audit log, break-glass access, legal holds and retention for site admins. Break-glass " +
      "and holds need a second admin to approve.",
    entries: [
      ["get", "/v1/site/audit", "List audit events across the site", AUDIT],
      [
        "get",
        "/v1/site/audit/export",
        "Download the audit log as CSV or JSONL",
        "Site admins (`site.audit.read`). File download; rate limited.",
      ],
      ["get", "/v1/site/audit/forwarding", "Show audit forwarding health", AUDIT],
      [
        "get",
        "/v1/site/audit/integrity",
        "Verify the audit chain and return its head",
        "Site admins (`site.audit.read`). Rate limited.",
      ],
      ["get", "/v1/site/break-glass", "List break-glass requests", BG],
      [
        "post",
        "/v1/site/break-glass",
        "Request break-glass access to a team's threads",
        "Site admins (`site.break_glass.request`). Answers 201.",
      ],
      ["get", "/v1/site/break-glass/{id}", "Get a break-glass request", BG],
      ["post", "/v1/site/break-glass/{id}/approve", "Approve a break-glass request", BG_APPROVE],
      ["post", "/v1/site/break-glass/{id}/deny", "Deny a break-glass request", BG_APPROVE],
      ["post", "/v1/site/break-glass/{id}/revoke", "Revoke a break-glass grant", BG],
      [
        "get",
        "/v1/site/break-glass/{id}/threads",
        "List threads readable under an active grant",
        "Read-only, only while the grant is active.",
      ],
      [
        "get",
        "/v1/site/break-glass/{id}/threads/{threadId}",
        "Read a thread under an active grant",
        "Read-only, only while the grant is active.",
      ],
      [
        "get",
        "/v1/site/break-glass/{id}/threads/{threadId}/entries",
        "Read a thread's entries under an active grant",
        "Read-only, only while the grant is active.",
      ],
      ["get", "/v1/site/portable-break-glass", "List break-glass requests for portable memory", BG],
      [
        "post",
        "/v1/site/portable-break-glass",
        "Request break-glass access to a person's portable memory",
        "Site admins (`site.break_glass.request`). Answers 201.",
      ],
      [
        "get",
        "/v1/site/portable-break-glass/{id}",
        "Get a portable-memory break-glass request",
        BG,
      ],
      [
        "post",
        "/v1/site/portable-break-glass/{id}/approve",
        "Approve a portable-memory break-glass request",
        BG_APPROVE,
      ],
      [
        "post",
        "/v1/site/portable-break-glass/{id}/deny",
        "Deny a portable-memory break-glass request",
        BG_APPROVE,
      ],
      [
        "get",
        "/v1/site/portable-break-glass/{id}/items",
        "List memory items readable under an active grant",
        "Read-only, only while the grant is active.",
      ],
      [
        "get",
        "/v1/site/portable-break-glass/{id}/items/{itemId}",
        "Read a memory item under an active grant",
        "Read-only, only while the grant is active.",
      ],
      [
        "post",
        "/v1/site/portable-break-glass/{id}/revoke",
        "Revoke a portable-memory break-glass grant",
        BG,
      ],
      ["get", "/v1/site/legal-hold", "List Workspace legal holds", HOLD],
      [
        "post",
        "/v1/site/legal-hold",
        "Request a legal hold on a Workspace",
        "Site admins (`site.legal_hold.manage`). Needs a second admin; answers 201.",
      ],
      ["get", "/v1/site/legal-hold/{id}", "Get a legal hold", HOLD],
      ["post", "/v1/site/legal-hold/{id}/approve", "Approve a legal hold request", HOLD],
      ["post", "/v1/site/legal-hold/{id}/deny", "Deny a legal hold request", HOLD],
      ["post", "/v1/site/legal-hold/{id}/release", "Request release of a legal hold", HOLD],
      ["post", "/v1/site/legal-hold/{id}/release/approve", "Approve release of a legal hold", HOLD],
      ["post", "/v1/site/legal-hold/{id}/release/deny", "Deny release of a legal hold", HOLD],
      ["post", "/v1/site/legal-hold/{id}/release/withdraw", "Withdraw a release request", HOLD],
      ["post", "/v1/site/legal-hold/{id}/withdraw", "Withdraw a legal hold request", HOLD],
      ["get", "/v1/site/site-legal-hold", "List site-wide memory legal holds", HOLD],
      [
        "post",
        "/v1/site/site-legal-hold",
        "Request a legal hold on Site memory",
        "Site admins (`site.legal_hold.manage`). Needs a second admin; answers 201.",
      ],
      ["get", "/v1/site/site-legal-hold/{id}", "Get a site-wide legal hold", HOLD],
      [
        "post",
        "/v1/site/site-legal-hold/{id}/approve",
        "Approve a site-wide legal hold request",
        HOLD,
      ],
      ["post", "/v1/site/site-legal-hold/{id}/deny", "Deny a site-wide legal hold request", HOLD],
      [
        "post",
        "/v1/site/site-legal-hold/{id}/release",
        "Request release of a site-wide hold",
        HOLD,
      ],
      [
        "post",
        "/v1/site/site-legal-hold/{id}/release/approve",
        "Approve release of a site-wide hold",
        HOLD,
      ],
      [
        "post",
        "/v1/site/site-legal-hold/{id}/release/deny",
        "Deny release of a site-wide hold",
        HOLD,
      ],
      [
        "post",
        "/v1/site/site-legal-hold/{id}/release/withdraw",
        "Withdraw a site-wide release request",
        HOLD,
      ],
      ["post", "/v1/site/site-legal-hold/{id}/withdraw", "Withdraw a site-wide hold request", HOLD],
      ["get", "/v1/site/retention", "Read the site's thread retention maximum", RETENTION],
      [
        "put",
        "/v1/site/retention",
        "Set the site's thread retention maximum",
        "Site admins (`site.retention.manage`). Lowering applies after a 7-day grace period; audited.",
      ],
      ["delete", "/v1/site/retention/pending", "Cancel a pending retention change", RETENTION],
    ],
  },
];
