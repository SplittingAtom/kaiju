import type { AuditEventDoc } from "./fragments.js";
import type { IDENTITY_EVENTS } from "./identity.js";

/**
 * The docs/audit-log.md rows of the identity area's events (KOBE-815), in name order; the table is
 * generated from these (`pnpm --filter @kaiju/db audit:doc`). Add an event's row here in name order.
 */
export const IDENTITY_EVENT_DOCS = {
  "auth.attempts.summarized": {
    fields: "`of`, `method?`, `userId?`, `suppressed`, `distinctIps`, `from`, `to`",
    when: "The other attempts of one key in a 5-minute window, summarized (system)",
  },
  "auth.passkey.added": { fields: "", when: "Passkey registered" },
  "auth.passkey.removed": { fields: "`passkeyId?`", when: "Passkey deleted" },
  "auth.password.changed": { fields: "", when: "Password change" },
  "auth.password.reset": { fields: "`userId`", when: "Reset completed" },
  "auth.password.reset_requested": {
    fields: "`userId`",
    when: "Reset requested for an existing, active account (actor null; aggregated)",
  },
  "auth.session.revoked": {
    fields: "`which` (one, others, all)",
    when: "The user revokes sessions",
  },
  "auth.sign_in.failed": {
    fields: "`method`, `reason` (error code), `userId?`",
    when: "First failed sign-in step per key and window (aggregated); `userId` only if the email names an account",
  },
  "auth.sign_in.succeeded": {
    fields:
      "`method` (password, totp, backup_code, passkey, invitation, sso), `mfa?` (SSO: the claim value that proved MFA, e.g. `acrs:c1`)",
    when: "A session is created",
  },
  "auth.sign_in.throttled": {
    fields: "`userId`, `until`",
    when: "An account passed 10 failed password or second-factor attempts in 15 minutes (all addresses together) and gets one attempt a minute until `until`; once per window (actor null; KOBE-812)",
  },
  "auth.sign_in.two_factor_required": {
    fields: "`method`",
    when: "Password accepted, TOTP still outstanding (aggregated)",
  },
  "auth.sign_out": { fields: "", when: "Sign-out" },
  "auth.two_factor.backup_codes_regenerated": { fields: "", when: "New backup codes" },
  "auth.two_factor.disabled": { fields: "", when: "2FA turned off" },
  "auth.two_factor.enabled": { fields: "", when: "TOTP enrollment verified" },
  "identity.invitation.accepted": {
    fields: "`invitationId`, `userId`",
    when: "Account created from it (actor: the new user)",
  },
  "identity.invitation.created": { fields: "`invitationId`", when: "Site invitation sent" },
  "identity.invitation.resent": { fields: "`invitationId`", when: "Re-sent (new token)" },
  "identity.invitation.revoked": { fields: "`invitationId`", when: "Revoked" },
  "identity.member.added": {
    fields: "`userId`, `role`, `via` (skill_reviewer_grant, idp, site_admin), `providerId?`",
    when: "Kaiju added a Skill reviewer to the Registry team (KOBE-331, SK22), or an identity provider's access mapping granted the membership (KOBE-625), or a site admin added an existing user from the Site console (`site_admin`, KOBE-638; actor = the site admin)",
  },
  "identity.member.removed": {
    fields: "`userId`, `role`, `via?` (skill_reviewer_grant, idp, site_admin), `providerId?`",
    when: "Member removed",
  },
  "identity.member.role_changed": {
    fields: "`userId`, `from`, `to`, `via?` (idp, site_admin), `providerId?`",
    when: "Team role changed",
  },
  "identity.member.taken_over": {
    fields: "`userId`, `providerId`, `via?` (site_admin)",
    when: "A team admin (or a site admin, `via: site_admin`) took over a membership the identity provider managed; it is manual from now on (KOBE-625, SSO10)",
  },
  "identity.ownership.transferred": {
    fields: "`fromUserId`, `toUserId`",
    when: "Ownership transfer",
  },
  "identity.scim.deactivation_refused": {
    fields: "`providerId`, `userId`, `credentialId?`",
    when: "SCIM asked to deactivate the Owner or a site Admin: refused, a site admin decides (SSO8)",
  },
  "identity.scim.group.created": {
    fields: "`providerId`, `groupId`, `credentialId?`",
    when: "SCIM pushed a group",
  },
  "identity.scim.group.deleted": {
    fields: "`providerId`, `groupId`, `credentialId?`",
    when: "SCIM deleted a group; the memberships it produced are removed",
  },
  "identity.scim.group.updated": {
    fields: "`providerId`, `groupId`, `credentialId?`",
    when: "SCIM changed a group or its members",
  },
  "identity.scim.reactivation_refused": {
    fields: "`providerId`, `userId`, `credentialId?`",
    when: "SCIM asked to reactivate a user a site admin deactivated: refused, the user stays deactivated (SSO11)",
  },
  "identity.scim.token.created": {
    fields: "`providerId`, `credentialId`",
    when: "SCIM token issued (stored as a hash, shown once)",
  },
  "identity.scim.token.revoked": {
    fields: "`providerId`, `credentialId`",
    when: "SCIM token revoked",
  },
  "identity.scim.user.created": {
    fields: "`providerId`, `userId`, `credentialId?`",
    when: "SCIM created a user (system actor)",
  },
  "identity.scim.user.deactivated": {
    fields: "`providerId`, `userId`, `credentialId?`",
    when: "SCIM deactivated a user; their sessions end at once",
  },
  "identity.scim.user.reactivated": {
    fields: "`providerId`, `userId`, `credentialId?`",
    when: "SCIM reactivated a user",
  },
  "identity.scim.user.updated": {
    fields: "`providerId`, `userId`, `credentialId?`",
    when: "SCIM changed a user",
  },
  "identity.setup.completed": {
    fields: "`ownerUserId`",
    when: "First-run setup created the Owner",
  },
  "identity.site_grant.granted": {
    fields: "`userId`, `grant` (skill_reviewer, memory_steward), `selfGranted?`",
    when: "The Owner or a Site admin gave a site grant (KOBE-331, SK22); `selfGranted`: the single admin gave it to themselves",
  },
  "identity.site_grant.revoked": {
    fields: "`userId`, `grant` (skill_reviewer, memory_steward)",
    when: "The Owner or a Site admin took a site grant (KOBE-331, SK22)",
  },
  "identity.site_role.granted": { fields: "`userId`, `role` (admin)", when: "Admin granted" },
  "identity.site_role.revoked": { fields: "`userId`, `role` (admin)", when: "Admin revoked" },
  "identity.sso.link.created": {
    fields: "`providerId`, `userId`, `method` (jit, local_proof, admin_expected, scim)",
    when: "A Kaiju user was linked to an identity at the provider",
  },
  "identity.sso.link.removed": {
    fields: "`providerId`, `userId`, `by` (user, admin, scim), `sessionsEnded`?",
    when: "Link removed; the provider's sessions of that user end",
  },
  "identity.sso.link_expectation.withdrawn": {
    fields: "`providerId`, `userId`",
    when: "An admin withdrew an expected link before it was used",
  },
  "identity.sso.link_expected": {
    fields: "`providerId`, `userId`",
    when: "An admin expects the user's next sign-in from the provider to link",
  },
  "identity.sso.mapping.created": {
    fields: "`providerId`, `mappingId`, `teamId`, `role`",
    when: "Access mapping added: a claim value grants a team role",
  },
  "identity.sso.mapping.deleted": {
    fields: "`providerId`, `mappingId`, `teamId`, `role`",
    when: "Access mapping removed",
  },
  "identity.sso.mapping_conflict": {
    fields: "`providerId`, `teamId`, `userId`, `reason` (manual_row, last_team_admin)",
    when: "A mapping could not apply: a manual membership wins, or the team would lose its last admin",
  },
  "identity.sso.provider.created": {
    fields: "`providerId`, `slug`, `kind` (entra, oidc)",
    when: "Single sign-on provider added (KOBE-625)",
  },
  "identity.sso.provider.deleted": {
    fields: "`providerId`, `slug`",
    when: "Provider deleted (only while no identity is linked)",
  },
  "identity.sso.provider.disabled": {
    fields: "`providerId`, `slug`",
    when: "Provider turned off; its sessions end",
  },
  "identity.sso.provider.enabled": { fields: "`providerId`, `slug`", when: "Provider turned on" },
  "identity.sso.provider.updated": {
    fields: "`providerId`, `slug`, `sessionsEnded?`",
    when: "Provider settings changed; `sessionsEnded` when the MFA rule changed and the provider's SSO sessions ended",
  },
  "identity.sso.required.disabled": {
    fields:
      "`reason` (`admin`, `last_provider`, `owner_unlinked`, `break_glass`), `providerId`, `slug`, `byUserId`, `operator`",
    when: '"Require single sign-on" turned off: by the Owner, by the last enabled provider being disabled or deleted (`byUserId`: the admin who did it in the console; system actor when the chart did it), by the chart leaving the Owner without an identity at an enabled provider (`owner_unlinked`, system actor), or by `kaiju sso allow-local-sign-in` (system actor, `operator`)',
  },
  "identity.sso.required.enabled": {
    fields: "`sessionsEnded`",
    when: '"Require single sign-on" turned on (KOBE-774); sessions not signed in through an identity provider end',
  },
  "identity.team.created": {
    fields: "`slug`, `name`, `adminUserId`",
    when: "Team created with its first team admin",
  },
  "identity.team.renamed": { fields: "`name`", when: "Team renamed" },
  "identity.team_invitation.accepted": {
    fields: "`userId`, `role`, `invitedBy`",
    when: "Invitee joined (actor: the invitee)",
  },
  "identity.team_invitation.created": {
    fields: "`invitationId`, `role`",
    when: "Team invitation sent or renewed",
  },
  "identity.team_invitation.declined": {
    fields: "",
    when: "Invitee declined (actor: the invitee)",
  },
  "identity.team_invitation.revoked": { fields: "`invitationId`", when: "Revoked by a team admin" },
  "identity.user.deactivated": { fields: "`userId`", when: "Deactivation" },
  "identity.user.reactivated": { fields: "`userId`", when: "Reactivation" },
} satisfies Record<keyof typeof IDENTITY_EVENTS, AuditEventDoc>;
