import { z } from "zod";
import {
  BUDGET_PERIODS,
  BUDGET_SCOPES,
  BUDGET_UNITS,
  MAX_BUDGET_TOKENS,
} from "../../schema/budgets.js";
import { THINKING_CONTROLS, THINKING_LEVELS, THINKING_LOWEST } from "../../schema/models.js";
import {
  count,
  endpointHost,
  event,
  id,
  modelAlias,
  providerId,
  providerKind,
  providerModel,
  tokenAmount,
  usdAmount,
  type AuditEventDef,
} from "./fragments.js";

export const MODELS_EVENTS = {
  // ── models: providers and catalog (site), team enablement (team; KOBE-40, D6, D30) ──
  // Never the API key itself: only whether one is set or changed.
  "models.provider.added": event("site", {
    providerId,
    kind: providerKind,
    keySet: z.boolean(),
    privateNetwork: z.boolean(),
    endpointHost,
  }),
  "models.provider.changed": event("site", {
    providerId,
    kind: providerKind,
    keyChanged: z.boolean(),
    baseUrlChanged: z.boolean(),
    privateNetwork: z.boolean(),
    /** The endpoint's host after the change (where the stored key is sent). */
    endpointHost,
  }),
  "models.provider.removed": event("site", { providerId, kind: providerKind }),
  /**
   * A site admin had the gateway call the provider's list-models API with the stored key
   * (KOBE-44 model picker). The outcome only: never the provider's answer or the key.
   */
  "models.provider.models_refreshed": event("site", {
    providerId,
    kind: providerKind,
    outcome: z.enum(["ok", "failed", "unavailable"]),
    models: count,
  }),
  /** A catalog alias was added, re-pointed or removed (removal also disables it for every team). */
  "models.catalog.changed": event("site", {
    alias: modelAlias,
    change: z.enum(["added", "updated", "removed"]),
    providerId: providerId.optional(),
    model: providerModel.optional(),
    /** Its prices were set or changed (KOBE-43; the amounts are in the catalog). */
    pricesChanged: z.boolean().optional(),
    /** Its input modalities (image input, KOBE-191) changed. */
    imageSupportChanged: z.boolean().optional(),
    /** Its output limit, context window or reasoning flag changed (KOBE-259). */
    limitsChanged: z.boolean().optional(),
    /** Its thinking settings when added or changed (KOBE-260). */
    thinking: z
      .strictObject({
        control: z.enum(THINKING_CONTROLS),
        allowed: z.boolean(),
        default: z.enum(THINKING_LEVELS).nullable(),
        max: z.enum(THINKING_LEVELS).nullable(),
        lowest: z.enum(THINKING_LOWEST),
      })
      .optional(),
  }),
  /** A team admin enabled or disabled a catalog alias for the team, or changed its default. */
  "models.team.changed": event("team", {
    alias: modelAlias,
    enabled: z.boolean(),
    isDefault: z.boolean(),
    /** The team's thinking maximum for the model (KOBE-260); null: the site's. */
    thinkingMax: z.enum(THINKING_LEVELS).nullable().optional(),
  }),
  /** A team admin turned post-run follow-up suggestions on or off for the team (KOBE-222, CE21). */
  "models.followups.changed": event("team", { enabled: z.boolean() }),
  /**
   * A team admin chose the team's default agent for new threads from its roster, or went back to
   * the site default (`agentId` null) (KOBE-571, agents-roster §7.7). Ids only.
   */
  "team.default_agent_changed": event("team", {
    agentId: id.nullable(),
    previousAgentId: id.nullable(),
  }),
  /**
   * A budget or rate limit was set, changed or removed (KOBE-42, D30): the site's (install
   * admins; no team), the team's or one member's (team admins). Amounts in dollars; null = none.
   */
  "models.budget.changed": event("any", {
    scope: z.enum(BUDGET_SCOPES),
    userId: id.optional(),
    monthlyUsd: usdAmount.nullable(),
    dailyUsd: usdAmount.nullable(),
    /** Token budgets (named "volume": audit field names never say "token"). */
    monthlyVolume: tokenAmount.nullable().optional(),
    dailyVolume: tokenAmount.nullable().optional(),
    /** The team's default member budget (team scope only). */
    memberDefault: z
      .strictObject({
        monthlyUsd: usdAmount.nullable(),
        dailyUsd: usdAmount.nullable(),
        monthlyVolume: tokenAmount.nullable(),
        dailyVolume: tokenAmount.nullable(),
      })
      .optional(),
    /** Per-user requests per minute (site and team levels only); null = the site's. */
    requestsPerMinute: z.number().int().positive().nullable().optional(),
    removed: z.literal(true).optional(),
  }),
  /**
   * A budget was used up (actor: system): from now on new model calls and new runs are refused at
   * its level and active runs end after their current step (D30). Once per budget and period.
   */
  "models.budget.reached": event("any", {
    scope: z.enum(BUDGET_SCOPES),
    userId: id.optional(),
    period: z.enum(BUDGET_PERIODS),
    periodStart: z.iso.date(),
    /** Dollars or tokens. */
    unit: z.enum(BUDGET_UNITS),
    limit: z.number().nonnegative().max(MAX_BUDGET_TOKENS),
    spent: z.number().nonnegative(),
  }),
} as const satisfies Record<string, AuditEventDef>;
