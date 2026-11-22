import { RETENTION_PERIODS, TEAM_ROLES, USAGE_KINDS } from "@kobe/db";
import { REMEMBER_SCOPES, rememberLimitsSchema } from "@kobe/protocol";
import { z } from "zod";
import { teamRuleBodySchema } from "../../../policy/schemas.js";
import { bodySchema as evalSettingsBodySchema } from "../../../routes/team-eval-settings.js";
import { inviteSchema } from "../../../routes/team-invites.js";
import { bodySchema as retentionBodySchema } from "../../../routes/team-retention.js";
import { bodySchema as chatSettingsBodySchema } from "../../../routes/team-settings.js";
import { querySchema as usageQuerySchema } from "../../../routes/usage.js";
import { named, untyped, type CatalogDetail } from "../build.js";
import { arr, bool, dateTime, int, nullable, num, obj, oneOfStrings, str, uuid } from "../json.js";
import { usageTotals } from "./team-shared.js";

/**
 * Request and response schemas of the Team catalog area, second half (KOBE-771): eval gate
 * settings, invitations, departed members, tool policy and remembered approvals, retention, chat
 * settings and usage. `untyped(...)` marks answers the routes build without a schema (the fields
 * read from the handler and the store function it calls). The first half is in `team.ts`.
 */

const role = oneOfStrings(...TEAM_ROLES);
const period = oneOfStrings(...RETENTION_PERIODS);

const EvalSettings = untyped("TeamEvalSettings", obj({ enabled: bool, maxAttackSuccessRate: num }));

const argPattern = {
  type: "object",
  additionalProperties: str,
  description: "JSON Pointer into the tool input → glob.",
};

/** A team rule as `listTeamRules` / `createTeamRule` show it (`StoredRule`, scope `team`). */
const teamRule = obj({
  id: uuid,
  scope: oneOfStrings("team"),
  scope_ref: nullable(uuid),
  effect: oneOfStrings("deny", "ask", "allow"),
  tool_glob: str,
  arg_pattern: nullable(argPattern),
  note: nullable(str),
  created_by: uuid,
  created_at: dateTime,
  expires_at: nullable(dateTime),
});
const TeamRuleEnvelope = untyped("TeamPolicyRuleEnvelope", obj({ rule: teamRule }));

/** A remembered approval as `listUserRules` / `listMemberRules` show it (`MemberRuleView`). */
const rememberedRule = obj({
  id: uuid,
  user_id: uuid,
  user_name: str,
  tool_glob: str,
  arg_pattern: nullable(argPattern),
  arg_pointers: arr(str),
  remember_scope: oneOfStrings(...REMEMBER_SCOPES),
  thread_id: nullable(uuid),
  thread_title: nullable(str),
  run_id: nullable(uuid),
  created_at: dateTime,
  expires_at: nullable(dateTime),
  last_used_at: nullable(dateTime),
  masked: bool,
  applies: bool,
  ended_reason: nullable(str),
});
const RememberedRules = untyped("RememberedRuleList", obj({ rules: arr(rememberedRule) }));

const TeamRememberLimits = named(
  "TeamRememberLimits",
  z.object({
    site: rememberLimitsSchema,
    team: rememberLimitsSchema,
    effective: rememberLimitsSchema,
  }),
);

const shortening = nullable(obj({ period, effectiveAt: dateTime }));
const TeamRetention = untyped(
  "TeamRetention",
  obj({
    period,
    maximum: period,
    effective: period,
    pending: shortening,
    upcoming: shortening,
    allowed: arr(period),
  }),
);

const TeamChatSettings = untyped("TeamChatSettings", obj({ followups_enabled: bool }));

const totals = (extra: Readonly<Record<string, Record<string, unknown>>>) =>
  obj({ ...extra, ...usageTotals });

const TeamUsage = untyped(
  "TeamUsageReport",
  obj({
    range: obj({ from: dateTime, to: dateTime, bucket: oneOfStrings("hour", "day") }),
    totals: totals({}),
    series: arr(totals({ t: dateTime })),
    by_user: arr(totals({ user_id: uuid, name: nullable(str), email: nullable(str) })),
    by_model: arr(totals({ model: str })),
    by_agent: arr(
      totals({
        agent_id: nullable(uuid),
        slug: nullable(str),
        scope: nullable(oneOfStrings("team", "personal", "gallery")),
      }),
    ),
    by_kind: arr(totals({ kind: oneOfStrings(...USAGE_KINDS) })),
    retention_months: nullable(int),
  }),
);

const ruleId = ["404"] as const;

export const teamAdminDetails: Readonly<Record<string, CatalogDetail>> = {
  "get /v1/team/eval-settings": { response: EvalSettings },
  "put /v1/team/eval-settings": {
    body: named("TeamEvalSettingsBody", evalSettingsBodySchema),
    response: EvalSettings,
  },

  "get /v1/team/invites": {
    response: untyped(
      "TeamInviteList",
      obj({
        invitations: arr(
          obj({
            id: uuid,
            email: str,
            role,
            expiresAt: dateTime,
            invitedBy: obj({ id: uuid, name: str }),
            createdAt: dateTime,
            status: oneOfStrings("pending", "expired"),
          }),
        ),
      }),
    ),
  },
  "post /v1/team/invites": {
    body: named("CreateTeamInviteBody", inviteSchema),
    status: 202,
    response: untyped(
      "TeamInviteSent",
      obj({ invitation: obj({ id: uuid, email: str, role, expiresAt: dateTime }) }),
    ),
    responseDescription:
      "Sent (or renewed); the same answer whether or not the address has an account.",
    errors: ["409", "429"],
  },
  "delete /v1/team/invites/{id}": {
    query: {
      expectedRole: {
        type: "string",
        enum: [...TEAM_ROLES],
        description: "Revoke only while the invitation still offers this role.",
      },
    },
    status: 204,
    errors: ["404", "409"],
  },

  "get /v1/team/offboarded": {
    response: untyped(
      "OffboardedMemberList",
      obj({
        members: arr(
          obj({ userId: uuid, name: nullable(str), retainUntil: dateTime, files: int, bytes: int }),
        ),
      }),
    ),
  },
  "get /v1/team/offboarded/{userId}/export": {
    produces: "application/zip",
    responseDescription: "The departed member's workspace files as a zip attachment.",
    errors: ["404", "503"],
  },

  "get /v1/team/policy/member-rules": { response: RememberedRules },
  "delete /v1/team/policy/member-rules/{id}": { status: 204, errors: ruleId },
  "get /v1/team/policy/my-rules": { response: RememberedRules },
  "delete /v1/team/policy/my-rules/{id}": { status: 204, errors: ruleId },
  "get /v1/team/policy/remember-limits": { response: TeamRememberLimits },
  "put /v1/team/policy/remember-limits": {
    body: named("TeamRememberLimitsBody", rememberLimitsSchema),
    response: TeamRememberLimits,
    responseDescription:
      "The limits after the change; 400 `limits_above_floor` names the looser fields.",
  },
  "get /v1/team/policy/rules": {
    response: untyped("TeamPolicyRuleList", obj({ rules: arr(teamRule) })),
  },
  "post /v1/team/policy/rules": {
    body: named("TeamPolicyRuleBody", teamRuleBodySchema),
    status: 201,
    response: TeamRuleEnvelope,
    errors: ["409"],
  },
  "delete /v1/team/policy/rules/{id}": { status: 204, errors: ruleId },
  "put /v1/team/policy/rules/{id}": {
    body: named("TeamPolicyRuleBody", teamRuleBodySchema),
    response: TeamRuleEnvelope,
    errors: ["404", "409"],
  },

  "get /v1/team/retention": { response: TeamRetention },
  "put /v1/team/retention": {
    body: named("SetTeamRetentionBody", retentionBodySchema),
    response: TeamRetention,
    errors: ["409"],
  },
  "delete /v1/team/retention/pending": { response: TeamRetention, errors: ["404"] },

  "get /v1/team/settings": { response: TeamChatSettings },
  "put /v1/team/settings": {
    body: named("TeamChatSettingsBody", chatSettingsBodySchema),
    response: TeamChatSettings,
  },

  "get /v1/team/usage": { query: usageQuerySchema, response: TeamUsage },
};
