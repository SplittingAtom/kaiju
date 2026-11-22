import { KOBE_MCP_MODES, TEAM_ROLES } from "@kobe/db";
import { SITE_GRANTS, siteBrandingSchema } from "@kobe/protocol";
import {
  createSchema as createSsoProviderSchema,
  patchSchema as patchSsoProviderSchema,
  target as ssoDiscoveryTargetSchema,
} from "../../../routes/site-sso.js";
import { inviteSchema } from "../../../routes/site-invites.js";
import { settingsSchema } from "../../../routes/site-settings.js";
import { expectedStateSchema, purgeBodySchema } from "../../../routes/site-users.js";
import { createMappingSchema } from "../../../sso/mappings.js";
import { mfaRuleSchema } from "../../../sso/schemas.js";
import {
  addMembersSchema,
  createTeamSchema,
  memberRoleSchema,
  renameTeamSchema,
  siteRoleChangeSchema,
  transferOwnershipSchema,
} from "../../../teams/schemas.js";
import { jsonSchemaOf, named, untyped, type CatalogDetail } from "../build.js";
import { arr, bool, dateTime, int, nullable, obj, oneOfStrings, str, uuid } from "../json.js";

/**
 * Request and response schemas of the "Site: people" catalog area (KOBE-771): teams and their
 * members, users, invitations, site roles and grants, SSO providers, mappings, links and SCIM
 * tokens, site settings, branding files and isolation. Bodies come from the zod schemas the routes
 * validate with; most answers are built by the handlers without a schema (`untyped`, fields read
 * from the handler and the helpers it calls).
 */

const teamRole = oneOfStrings(...TEAM_ROLES);
const teamSummary = obj({ id: uuid, slug: str, name: str });
const SiteTeam = untyped("SiteTeamResponse", obj({ team: teamSummary }));

const teamMember = obj({
  userId: uuid,
  name: str,
  email: str,
  role: teamRole,
  joinedAt: dateTime,
  addedVia: nullable(oneOfStrings("skill_reviewer_grant", "idp", "site_admin")),
  deactivated: bool,
  managedBy: nullable(obj({ providerId: uuid, providerName: str })),
});

const incompleteSteps = {
  ...arr(str),
  description: "Offboarding steps that did not finish (retried later).",
};

const invitation = obj({ id: uuid, email: str, expiresAt: dateTime });
const SiteInviteSent = untyped("SiteInvitationSent", obj({ invitation, emailSent: bool }));

// --- SSO ---------------------------------------------------------------------------------

const ssoProvider = obj({
  id: uuid,
  slug: str,
  kind: oneOfStrings("entra", "oidc"),
  displayName: str,
  issuer: str,
  tenantId: nullable(str),
  clientId: str,
  subjectClaim: oneOfStrings("oid", "sub"),
  accessClaim: oneOfStrings("roles", "groups"),
  mfaRule: jsonSchemaOf(mfaRuleSchema, "output"),
  allowedEmailDomains: arr(str),
  jitProvisioning: bool,
  maxSessionHours: nullable(int),
  enabled: bool,
  managedBy: oneOfStrings("console", "helm"),
  clientSecret: {
    ...oneOfStrings("set", "missing"),
    description: "Never the secret: whether one is stored (or the Helm Secret mounted).",
  },
  redirectUri: str,
  linkedIdentities: int,
  createdAt: dateTime,
  updatedAt: dateTime,
});

/** `DiscoveryReport` (`sso/discovery.ts`); the failure codes are type unions there. */
const discovery = obj({
  ok: bool,
  issuer: nullable(str),
  checks: arr(
    obj({
      id: oneOfStrings(
        "tenant_pinned",
        "address_allowed",
        "reachable",
        "issuer_match",
        "code_flow",
        "pkce_s256",
        "endpoints_allowed",
      ),
      ok: bool,
      message: str,
    }),
  ),
  "failure?": { ...str, description: "The first failed check's code." },
  "message?": str,
});
const SsoDiscovery = untyped("SsoDiscoveryResult", obj({ discovery }));
const SsoProvider = untyped("SsoProviderResponse", obj({ provider: ssoProvider }));

const scimToken = obj({
  id: uuid,
  prefix: str,
  createdAt: dateTime,
  lastUsedAt: nullable(dateTime),
  revokedAt: nullable(dateTime),
});
const scimTokenCreated = (replaces: boolean) => ({
  token: { ...str, description: "The token itself: shown in this answer only, never again." },
  credential: scimToken,
  ...(replaces ? { replaces: uuid } : {}),
  baseUrl: str,
});

const ssoMapping = obj({
  id: uuid,
  providerId: uuid,
  claimValue: str,
  teamId: uuid,
  teamSlug: str,
  teamName: str,
  role: teamRole,
  createdAt: dateTime,
});
const appliesAt = oneOfStrings("next_sign_in");

const linkExpectation = obj({
  providerId: uuid,
  providerName: str,
  createdAt: dateTime,
  expiresAt: dateTime,
});

// --- Settings, branding, isolation ------------------------------------------------------

const SiteSettings = untyped(
  "SiteSettings",
  obj({
    requireTwoFactor: bool,
    auditPiiRetentionHours: int,
    kobeMcpMode: oneOfStrings(...KOBE_MCP_MODES),
  }),
);
const Branding = named("SiteBranding", siteBrandingSchema);
const BRANDING_FILE =
  "The site branding after the change. A wrong image type answers 415, a wrong size 422.";

const isolation = {
  oneOf: [
    obj({ state: oneOfStrings("checking"), agentsEnabled: bool, runtimeClassName: str }),
    obj({
      state: oneOfStrings("verified"),
      agentsEnabled: bool,
      runtimeClassName: str,
      handler: str,
      checkedAt: dateTime,
    }),
    obj({
      state: oneOfStrings("missing"),
      agentsEnabled: bool,
      "runtimeClassName?": str,
      message: str,
      checkedAt: dateTime,
      docs: str,
    }),
  ],
};
const Isolation = untyped("SiteIsolationStatus", isolation);

// KOBE-811: install checks for the Site console overview (one check today).
const SiteHealth = untyped(
  "SiteHealth",
  obj({
    checks: arr({
      oneOf: [
        obj({
          id: oneOfStrings("ingress_rate_limit"),
          level: oneOfStrings("ok"),
          state: oneOfStrings("configured"),
          source: oneOfStrings("chart", "external"),
        }),
        obj({
          id: oneOfStrings("ingress_rate_limit"),
          level: oneOfStrings("info"),
          state: oneOfStrings("none", "unknown"),
          docs: str,
        }),
      ],
    }),
  }),
);

const SSO_OFF = "Every SSO route answers 404 while single sign-on is switched off.";

export const sitePeopleDetails: Readonly<Record<string, CatalogDetail>> = {
  // Teams and members
  "get /v1/site/teams": {
    response: untyped(
      "SiteTeamList",
      obj({ teams: arr(obj({ id: uuid, slug: str, name: str, createdAt: dateTime })) }),
    ),
  },
  "post /v1/site/teams": {
    body: named("CreateSiteTeamBody", createTeamSchema),
    status: 201,
    response: SiteTeam,
    errors: ["404", "409"],
  },
  "patch /v1/site/teams/{teamId}": {
    body: named("RenameSiteTeamBody", renameTeamSchema),
    response: SiteTeam,
    errors: ["404"],
  },
  "get /v1/site/teams/{teamId}/candidates": {
    query: { q: { type: "string", description: "Name or email to search for (up to 200 chars)." } },
    response: untyped(
      "SiteTeamCandidateList",
      obj({ candidates: arr(obj({ userId: uuid, name: str, email: str })) }),
    ),
    responseDescription: "Active, verified users not yet in the team (never the caller).",
    errors: ["404"],
  },
  "get /v1/site/teams/{teamId}/members": {
    response: untyped("SiteTeamMemberList", obj({ members: arr(teamMember) })),
    errors: ["404"],
  },
  "post /v1/site/teams/{teamId}/members": {
    body: named("AddSiteTeamMembersBody", addMembersSchema),
    status: 201,
    response: untyped(
      "SiteTeamMembersAdded",
      obj({ added: arr(obj({ userId: uuid, role: teamRole })) }),
    ),
    responseDescription: "Added; a refusal names the `userId` it is about.",
    errors: ["404", "409"],
  },
  "delete /v1/site/teams/{teamId}/members/{userId}": {
    query: {
      expectedRole: {
        ...teamRole,
        description: "Refuse with 409 `changed_since_approval` unless the role is still this one.",
      },
    },
    status: 204,
    errors: ["404", "409"],
  },
  "patch /v1/site/teams/{teamId}/members/{userId}": {
    body: named("SiteTeamMemberRoleBody", memberRoleSchema),
    response: untyped("SiteTeamMemberRole", obj({ userId: uuid, role: teamRole })),
    errors: ["404", "409"],
  },
  "post /v1/site/teams/{teamId}/members/{userId}/take-over": {
    body: null,
    response: untyped(
      "SiteTeamMemberTakenOver",
      obj({ userId: uuid, managedBy: { type: "null" } }),
    ),
    errors: ["404", "409"],
  },

  // Users
  "get /v1/site/users": {
    response: untyped(
      "SiteUserList",
      obj({
        users: arr(
          obj({
            id: uuid,
            name: str,
            email: str,
            siteRole: oneOfStrings("owner", "admin", "user"),
            twoFactorEnabled: bool,
            deactivatedAt: nullable(dateTime),
            createdAt: dateTime,
          }),
        ),
      }),
    ),
  },
  "post /v1/site/users/{userId}/deactivate": {
    body: named("SiteUserExpectedStateBody", expectedStateSchema),
    bodyOptional: true,
    response: untyped(
      "SiteUserDeactivated",
      obj({
        userId: uuid,
        deactivated: { type: "boolean", enum: [true] },
        teamsWithoutActiveAdmin: {
          ...arr(teamSummary),
          description: "Teams whose only active team admin this was.",
        },
        incompleteSteps,
      }),
    ),
    errors: ["404", "409"],
  },
  "post /v1/site/users/{userId}/portable-memory/purge": {
    body: named("PurgePortableMemoryBody", purgeBodySchema),
    response: untyped(
      "PortableMemoryPurged",
      obj({
        userId: uuid,
        purged: int,
        kept: int,
        remaining: { ...bool, description: "More to purge: call again to continue." },
      }),
    ),
    errors: ["404", "409", "503"],
  },
  "post /v1/site/users/{userId}/reactivate": {
    body: named("SiteUserExpectedStateBody", expectedStateSchema),
    bodyOptional: true,
    response: untyped(
      "SiteUserReactivated",
      obj({ userId: uuid, deactivated: { type: "boolean", enum: [false] }, incompleteSteps }),
    ),
    errors: ["404", "409"],
  },

  // Invitations
  "get /v1/site/invites": {
    response: untyped(
      "SiteInvitationList",
      obj({
        invitations: arr(
          obj({
            id: uuid,
            email: str,
            invitedBy: obj({ id: uuid, name: str }),
            createdAt: dateTime,
            expiresAt: dateTime,
            status: oneOfStrings("pending", "expired"),
          }),
        ),
      }),
    ),
  },
  "post /v1/site/invites": {
    body: named("SiteInviteBody", inviteSchema),
    status: 201,
    response: SiteInviteSent,
    errors: ["409", "429"],
  },
  "delete /v1/site/invites/{id}": {
    query: {
      expectedEmail: {
        type: "string",
        format: "email",
        description: "Revoke only while the invitation is still for this address (else 409).",
      },
    },
    status: 204,
    errors: ["404", "409"],
  },
  "post /v1/site/invites/{id}/resend": {
    body: null,
    response: SiteInviteSent,
    errors: ["404", "429"],
  },

  // Site roles and grants
  "get /v1/site/roles": {
    response: untyped(
      "SiteRoleList",
      obj({
        roles: arr(
          obj({ userId: uuid, name: str, email: str, role: oneOfStrings("owner", "admin") }),
        ),
      }),
    ),
  },
  "put /v1/site/roles/{userId}": {
    body: named("SiteRoleChangeBody", siteRoleChangeSchema),
    response: untyped(
      "SiteRoleChanged",
      obj({ userId: uuid, role: oneOfStrings("admin", "user") }),
    ),
    errors: ["404", "409"],
  },
  "get /v1/site/roles/grants": {
    response: untyped(
      "SiteGrantList",
      obj({
        grants: arr(
          obj({
            userId: uuid,
            name: str,
            email: str,
            grant: oneOfStrings(...SITE_GRANTS),
            grantedBy: uuid,
            grantedAt: dateTime,
            deactivated: bool,
          }),
        ),
      }),
    ),
  },
  "delete /v1/site/roles/grants/{userId}/{grant}": { status: 204, errors: ["404"] },
  "put /v1/site/roles/grants/{userId}/{grant}": {
    body: null,
    response: untyped(
      "SiteGrantGiven",
      obj({ userId: uuid, grant: oneOfStrings(...SITE_GRANTS), changed: bool }),
    ),
    errors: ["404", "409"],
  },
  "post /v1/site/roles/transfer-ownership": {
    body: named("TransferSiteOwnershipBody", transferOwnershipSchema),
    response: untyped("SiteOwnershipTransferred", obj({ ownerUserId: uuid })),
    errors: ["404", "409"],
  },

  // SSO providers, mappings, SCIM tokens and links
  "get /v1/site/sso/mappings": {
    query: { providerId: { type: "string", format: "uuid", description: "One provider only." } },
    response: untyped(
      "SiteSsoMappingList",
      obj({
        providers: arr(
          obj({
            id: uuid,
            slug: str,
            displayName: str,
            accessClaim: str,
            enabled: bool,
            managedBy: str,
          }),
        ),
        mappings: arr(ssoMapping),
        appliesAt,
      }),
    ),
    responseDescription: SSO_OFF,
    errors: ["404"],
  },
  "get /v1/site/sso/providers": {
    response: untyped("SsoProviderList", obj({ providers: arr(ssoProvider) })),
    responseDescription: SSO_OFF,
    errors: ["404"],
  },
  "post /v1/site/sso/providers": {
    body: named("CreateSsoProviderBody", createSsoProviderSchema),
    status: 201,
    response: untyped("SsoProviderCreated", obj({ provider: ssoProvider, discovery })),
    responseDescription:
      "Saved after discovery passed; a failed discovery answers 422 `discovery_failed` with " +
      "the report.",
    errors: ["404", "409", "422", "429", "503"],
  },
  "delete /v1/site/sso/providers/{id}": { status: 204, errors: ["404", "409"] },
  "get /v1/site/sso/providers/{id}": { response: SsoProvider, errors: ["404"] },
  "patch /v1/site/sso/providers/{id}": {
    body: named("PatchSsoProviderBody", patchSsoProviderSchema),
    response: untyped(
      "SsoProviderUpdated",
      obj({ provider: ssoProvider, "discovery?": discovery }),
    ),
    responseDescription: "`discovery` is present when a new tenant or issuer was discovered.",
    errors: ["404", "409", "422", "429"],
  },
  "get /v1/site/sso/providers/{id}/scim": {
    response: untyped("ScimTokenList", obj({ baseUrl: str, tokens: arr(scimToken) })),
    errors: ["404"],
  },
  "post /v1/site/sso/providers/{id}/scim/tokens": {
    body: null,
    status: 201,
    response: untyped("ScimTokenCreated", obj(scimTokenCreated(false))),
    errors: ["404", "409"],
  },
  "post /v1/site/sso/providers/{id}/scim/tokens/{tokenId}/revoke": {
    body: null,
    response: untyped("ScimTokenRevoked", obj({ credential: scimToken })),
    errors: ["404", "409"],
  },
  "post /v1/site/sso/providers/{id}/scim/tokens/{tokenId}/rotate": {
    body: null,
    status: 201,
    response: untyped("ScimTokenRotated", obj(scimTokenCreated(true))),
    responseDescription: "A new token; the one it `replaces` keeps working until revoked.",
    errors: ["404", "409"],
  },
  "post /v1/site/sso/providers/{id}/test": {
    body: null,
    response: SsoDiscovery,
    errors: ["404", "429"],
  },
  "post /v1/site/sso/providers/{providerId}/mappings": {
    body: named("CreateSsoMappingBody", createMappingSchema),
    status: 201,
    response: untyped("SsoMappingCreated", obj({ mapping: ssoMapping, appliesAt })),
    errors: ["404", "409"],
  },
  "delete /v1/site/sso/providers/{providerId}/mappings/{mappingId}": {
    status: 204,
    errors: ["404"],
  },
  "post /v1/site/sso/providers/test": {
    body: named("SsoDiscoveryTargetBody", ssoDiscoveryTargetSchema),
    response: SsoDiscovery,
    errors: ["404", "429"],
  },
  "delete /v1/site/sso/users/{userId}/link-expectations/{providerId}": {
    response: untyped(
      "SsoLinkExpectationWithdrawn",
      obj({ withdrawn: { type: "boolean", enum: [true] } }),
    ),
    errors: ["404"],
  },
  "put /v1/site/sso/users/{userId}/link-expectations/{providerId}": {
    body: null,
    response: untyped("SsoLinkExpectationResponse", obj({ expectation: linkExpectation })),
    responseDescription: "Expected for 14 days, single use.",
    errors: ["404", "409"],
  },
  "get /v1/site/sso/users/{userId}/links": {
    response: untyped(
      "SsoUserLinks",
      obj({
        links: arr(
          obj({
            providerId: uuid,
            providerName: str,
            linkedVia: str,
            emailAtLink: nullable(str),
            linkedAt: dateTime,
            lastSignInAt: nullable(dateTime),
          }),
        ),
        expectations: arr(linkExpectation),
      }),
    ),
    errors: ["404"],
  },
  "delete /v1/site/sso/users/{userId}/links/{providerId}": {
    response: untyped(
      "SsoUserUnlinked",
      obj({ unlinked: { type: "boolean", enum: [true] }, sessionsEnded: int }),
    ),
    errors: ["404", "409"],
  },

  // Settings, branding, isolation
  "get /v1/site/settings": { response: SiteSettings },
  "put /v1/site/settings": {
    body: named("SiteSettingsBody", settingsSchema),
    response: SiteSettings,
  },
  "delete /v1/site/branding/assets/{kind}": {
    response: Branding,
    responseDescription: "The site branding after the change.",
    errors: ["404"],
  },
  "put /v1/site/branding/assets/{kind}": {
    body: null,
    multipart: {
      file: { type: "string", format: "binary", description: "One file part (any field name)." },
    },
    response: Branding,
    responseDescription: BRANDING_FILE,
    errors: ["404", "411", "413", "415", "422"],
  },
  "post /v1/site/branding/reset": {
    body: null,
    response: Branding,
    responseDescription: "The site branding back at the install defaults.",
  },
  "get /v1/site/isolation": { response: Isolation },
  "get /v1/site/health": {
    response: SiteHealth,
    responseDescription:
      "Install checks. `info` is a notice, not an error: `ingress_rate_limit` is `none` when the " +
      "chart's Ingress has no per-client rate limit, `unknown` when Kobe's Ingress is not managed " +
      "by the chart and no edge limit was declared.",
  },
  "post /v1/site/isolation/check": {
    body: null,
    response: Isolation,
    responseDescription: "The result of a fresh check.",
  },
};
