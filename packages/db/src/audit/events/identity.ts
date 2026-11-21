import { z } from "zod";
import { siteGrant } from "../../schema/grants.js";
import { SSO_LINKED_VIA, SSO_PROVIDER_KINDS } from "../../schema/sso.js";
import {
  count,
  event,
  id,
  label,
  reasonCode,
  role,
  signInMethod,
  slug,
  type AuditEventDef,
} from "./fragments.js";

export const IDENTITY_EVENTS = {
  // ── auth: Better Auth sign-in and credential changes (actor: the user) ──
  /**
   * `mfa` (SSO only, KOBE-629 review L3): the claim value that proved MFA, e.g. `acrs:c1` or
   * `amr:mfa`; absent when the sign-in did not prove it. A rule value, never personal data.
   */
  "auth.sign_in.succeeded": event("site", {
    method: signInMethod,
    mfa: z
      .string()
      .regex(/^(amr|acr|acrs):[\x21-\x7e]{1,64}$/)
      .optional(),
  }),
  /** Actor id null (unauthenticated); `userId` only when the attempt named an existing account. */
  "auth.sign_in.failed": event("site", {
    method: signInMethod,
    reason: reasonCode,
    userId: id.optional(),
  }),
  /** Password accepted; the second factor is still outstanding (no session yet). */
  "auth.sign_in.two_factor_required": event("site", { method: signInMethod }),
  /**
   * Unauthenticated attempts are aggregated (KOBE-15 review): the first of each kind per account (or
   * per "no account") and method in a window is recorded as itself; the rest of that window become
   * one summary, so a flood from rotating IPs adds at most two rows per key and window.
   */
  "auth.attempts.summarized": event("site", {
    of: z.enum([
      "auth.sign_in.failed",
      "auth.sign_in.two_factor_required",
      "auth.password.reset_requested",
    ]),
    method: signInMethod.optional(),
    userId: id.optional(),
    /** Attempts in the window after the first (which was recorded as its own event). */
    suppressed: z.number().int().positive(),
    /** Distinct client addresses among them (counted up to 1,000). */
    distinctIps: z.number().int().nonnegative(),
    from: z.iso.datetime(),
    to: z.iso.datetime(),
  }),
  "auth.sign_out": event("site", {}),
  "auth.session.revoked": event("site", { which: z.enum(["one", "others", "all"]) }),
  "auth.password.changed": event("site", {}),
  /** Actor id null: whoever asked; only requests for an existing, active account are recorded. */
  "auth.password.reset_requested": event("site", { userId: id }),
  "auth.password.reset": event("site", { userId: id }),
  "auth.two_factor.enabled": event("site", {}),
  "auth.two_factor.disabled": event("site", {}),
  "auth.two_factor.backup_codes_regenerated": event("site", {}),
  "auth.passkey.added": event("site", {}),
  "auth.passkey.removed": event("site", { passkeyId: z.string().max(128).optional() }),

  // ── identity: users, invitations, roles, teams, membership ──
  "identity.setup.completed": event("site", { ownerUserId: id }),
  // No invitee email (personal data in an append-only log): the invitation id resolves it while
  // the invitation exists (site invitations are kept; KOBE-15 review).
  "identity.invitation.created": event("site", { invitationId: id }),
  "identity.invitation.resent": event("site", { invitationId: id }),
  "identity.invitation.revoked": event("site", { invitationId: id }),
  /** Actor: the new user. */
  "identity.invitation.accepted": event("site", { invitationId: id, userId: id }),
  "identity.user.deactivated": event("site", { userId: id }),
  "identity.user.reactivated": event("site", { userId: id }),
  "identity.site_role.granted": event("site", { userId: id, role: z.literal("admin") }),
  "identity.site_role.revoked": event("site", { userId: id, role: z.literal("admin") }),
  "identity.ownership.transferred": event("site", { fromUserId: id, toUserId: id }),
  "identity.team.created": event("team", { slug, name: label, adminUserId: id }),
  "identity.team.renamed": event("team", { name: label }),
  "identity.team_invitation.created": event("team", { invitationId: id, role }),
  "identity.team_invitation.revoked": event("team", { invitationId: id }),
  /** Actor: the invitee, who joins with `role`. */
  "identity.team_invitation.accepted": event("team", { userId: id, role, invitedBy: id }),
  /** Actor: the invitee. */
  "identity.team_invitation.declined": event("team", {}),
  /**
   * `via: "idp"`: the provider's access mappings changed a row they manage (KOBE-625, §7);
   * `via: "site_admin"`: a Site admin changed it from the Site console (KOBE-638, actor = them).
   */
  "identity.member.role_changed": event("team", {
    userId: id,
    from: role,
    to: role,
    via: z.enum(["idp", "site_admin"]).optional(),
    providerId: id.optional(),
  }),
  /**
   * `via`: Kobe removed a membership the Skill reviewer grant made when the grant was taken, or
   * the provider's access mappings no longer grant it (`idp`, KOBE-625, with `providerId`), or a
   * Site admin removed it from the Site console (`site_admin`, KOBE-638, actor = them).
   */
  "identity.member.removed": event("team", {
    userId: id,
    role,
    via: z.enum(["skill_reviewer_grant", "idp", "site_admin"]).optional(),
    providerId: id.optional(),
  }),
  /**
   * Kobe added someone to the team on its own (KOBE-331): a Skill reviewer joins the Registry
   * team as a member when granted, or when the team becomes the Registry team (SK22); or an
   * identity provider's access mapping grants the membership (`idp`, KOBE-625, with `providerId`);
   * or a Site admin added an existing user from the Site console (`site_admin`, KOBE-638, actor =
   * the Site admin, no invitation).
   */
  "identity.member.added": event("team", {
    userId: id,
    role,
    via: z.enum(["skill_reviewer_grant", "idp", "site_admin"]),
    providerId: id.optional(),
  }),
  /** A team admin took over a membership the provider managed: it is manual from now on (SSO10). */
  /** `via: "site_admin"`: a Site admin took it over from the Site console (KOBE-638). */
  "identity.member.taken_over": event("team", {
    userId: id,
    providerId: id,
    via: z.enum(["site_admin"]).optional(),
  }),
  /**
   * The Owner or a Site admin gave or took a site grant beside the role ladder (KOBE-331, SK22):
   * Skill reviewer, or Site memory steward (KOBE-380).
   */
  /** `selfGranted`: the Site's only admin gave it to themselves (flagged, KOBE-336 review). */
  "identity.site_grant.granted": event("site", {
    userId: id,
    grant: z.enum(siteGrant.enumValues),
    selfGranted: z.literal(true).optional(),
  }),
  "identity.site_grant.revoked": event("site", {
    userId: id,
    grant: z.enum(siteGrant.enumValues),
  }),

  // ── identity: single sign-on and SCIM (KOBE-625, spec sso-oidc-scim §12) ──
  // Ids and codes only: never a claim value, subject, email, client secret or SCIM token. SCIM
  // requests are recorded with the system actor and the SCIM credential's id (`credentialId`).
  "identity.sso.provider.created": event("site", {
    providerId: id,
    slug,
    kind: z.enum(SSO_PROVIDER_KINDS),
  }),
  /** `sessionsEnded`: the MFA rule changed, so the provider's SSO sessions ended (KOBE-629). */
  "identity.sso.provider.updated": event("site", {
    providerId: id,
    slug,
    sessionsEnded: count.optional(),
  }),
  "identity.sso.provider.deleted": event("site", { providerId: id, slug }),
  "identity.sso.provider.enabled": event("site", { providerId: id, slug }),
  "identity.sso.provider.disabled": event("site", { providerId: id, slug }),
  "identity.sso.mapping.created": event("site", {
    providerId: id,
    mappingId: id,
    teamId: id,
    role,
  }),
  "identity.sso.mapping.deleted": event("site", {
    providerId: id,
    mappingId: id,
    teamId: id,
    role,
  }),
  /** A mapping could not apply: a manual row wins, or the team would lose its last admin (§7). */
  "identity.sso.mapping_conflict": event("site", {
    providerId: id,
    teamId: id,
    userId: id,
    reason: z.enum(["manual_row", "last_team_admin"]),
  }),
  "identity.sso.link.created": event("site", {
    providerId: id,
    userId: id,
    method: z.enum(SSO_LINKED_VIA),
  }),
  /** `sessionsEnded`: the user's sessions signed in through the provider that ended (KOBE-630). */
  "identity.sso.link.removed": event("site", {
    providerId: id,
    userId: id,
    by: z.enum(["user", "admin", "scim"]),
    sessionsEnded: count.optional(),
  }),
  /** An admin expects the user's next sign-in from the provider to link (§6). */
  "identity.sso.link_expected": event("site", { providerId: id, userId: id }),
  /** An admin withdrew an expected link before it was used (KOBE-630). */
  "identity.sso.link_expectation.withdrawn": event("site", { providerId: id, userId: id }),
  "identity.scim.token.created": event("site", { providerId: id, credentialId: id }),
  "identity.scim.token.revoked": event("site", { providerId: id, credentialId: id }),
  "identity.scim.user.created": event("site", {
    providerId: id,
    userId: id,
    credentialId: id.optional(),
  }),
  "identity.scim.user.updated": event("site", {
    providerId: id,
    userId: id,
    credentialId: id.optional(),
  }),
  "identity.scim.user.deactivated": event("site", {
    providerId: id,
    userId: id,
    credentialId: id.optional(),
  }),
  "identity.scim.user.reactivated": event("site", {
    providerId: id,
    userId: id,
    credentialId: id.optional(),
  }),
  "identity.scim.group.created": event("site", {
    providerId: id,
    groupId: id,
    credentialId: id.optional(),
  }),
  "identity.scim.group.updated": event("site", {
    providerId: id,
    groupId: id,
    credentialId: id.optional(),
  }),
  "identity.scim.group.deleted": event("site", {
    providerId: id,
    groupId: id,
    credentialId: id.optional(),
  }),
  /** SCIM asked to deactivate the Owner or a site Admin: refused, an admin decides (SSO8). */
  "identity.scim.deactivation_refused": event("site", {
    providerId: id,
    userId: id,
    credentialId: id.optional(),
  }),
  /** SCIM asked to reactivate a user a site admin deactivated: refused (SSO11). */
  "identity.scim.reactivation_refused": event("site", {
    providerId: id,
    userId: id,
    credentialId: id.optional(),
  }),
} as const satisfies Record<string, AuditEventDef>;
