import { z } from "zod";
import { UI_RESOURCE_URI_PATTERN } from "../../connectors/ui-resources.js";
import { MAX_BUDGET_TOKENS, MAX_BUDGET_USD } from "../../schema/budgets.js";
import { DOMAIN_PATTERN_SQL } from "../../schema/egress.js";
import {
  MODEL_ALIAS_PATTERN,
  MODEL_PROVIDER_KINDS,
  PROVIDER_ID_PATTERN,
  PROVIDER_MODEL_PATTERN,
} from "../../schema/models.js";
import { PROJECT_ROLE_VALUES, PROJECT_VISIBILITY_VALUES } from "../../schema/projects.js";
import { RETENTION_PERIODS } from "../../schema/retention.js";
import {
  SEMANTIC_MEMORY_KIND_VALUES,
  SEMANTIC_MEMORY_SCOPE_VALUES,
  SEMANTIC_MEMORY_TAGS_MAX,
} from "../../schema/semantic-memory.js";
import { teamRole } from "../../schema/team-members.js";
import { SIGN_IN_METHODS } from "./vocab.js";

/** Shared zod fragments of the audit taxonomy (KOBE-701), used by the per-area event files. */

/** Where an event appears: site audit only, the team's audit view too, or either. */
export type AuditScope =
  /** `teamId` must be null: site-level (users, site settings, gallery, platform). */
  | "site"
  /** `teamId` is required: the team's audit view shows it (team admins). */
  | "team"
  /** Team when the subject is a team's (e.g. a team agent), site otherwise (personal agents). */
  | "any";

export const id = z.uuid();

/** An MCP Apps template URI (KOBE-433): `ui://...`, never another scheme. */
export const uiUri = z.string().max(2048).regex(UI_RESOURCE_URI_PATTERN);
/** A short human label (team or agent name): no control characters, bounded. */
export const label = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\p{Cc}\p{Zl}\p{Zp}]*$/u);
export const role = z.enum(teamRole.enumValues);
export const projectRole = z.enum(PROJECT_ROLE_VALUES);
export const projectVisibility = z.enum(PROJECT_VISIBILITY_VALUES);
export const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
/** A thread folder's name (KOBE-534, TF1): trimmed, 1-80 characters. */
export const folderName = z.string().min(1).max(80);
/** A catalog skill or tag name (KOBE-311): lowercase, hyphens inside, at most 64 characters. */
export const catalogName = z.string().regex(/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/);
/** Machine-readable reason (e.g. a Better Auth error code), never a free-text message. */
export const reasonCode = z.string().regex(/^[A-Za-z0-9_]{1,64}$/);

export const signInMethod = z.enum(SIGN_IN_METHODS);
export const agentScope = z.enum(["team", "personal", "gallery"]);
export const agentRef = { agentId: id, scope: agentScope, slug };
/** A published agent version number (or a draft revision): a positive integer. */
export const version = z.number().int().positive();
/** An agent on a roster (KOBE-566): the team's roster (`teamId` set) or the site's. */
export const rosterRef = { ...agentRef, roster: z.enum(["team", "site"]) };
/** A roster entry's version rule: follow the latest published version, or a pin (AR5). */
export const versionRuleRef = {
  versionRule: z.enum(["latest", "pinned"]),
  pinnedVersion: version.nullable(),
};
export const isolationState = z.enum(["checking", "verified", "missing"]);
/** A tool rule (KOBE-35) by its policy metadata; never its free-text note or arg values. */
export const toolRule = {
  ruleId: id,
  scope: z.enum(["site", "team", "user"]),
  effect: z.enum(["deny", "ask", "allow"]),
  /** Tool-name glob (e.g. `mcp__jira__*`), policy metadata. */
  toolGlob: z.string().min(1).max(512),
  /** How many `arg_pattern` entries the rule has (the patterns themselves are not recorded). */
  argPatternEntries: z.number().int().nonnegative(),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
  /** User rules (KOBE-289): the remember scope, and the thread or run a bound rule holds in. */
  rememberScope: z.enum(["thread", "today", "run", "day", "month", "forever"]).optional(),
  threadId: id.optional(),
  runId: id.optional(),
};

/** Admin limits on remembered approvals (KOBE-289): the site floor's or a team's. */
export const rememberLimits = {
  scope: z.enum(["site", "team"]),
  scopes: z.array(z.enum(["thread", "today", "run", "day", "month", "forever"])).max(6),
  maxDurationSeconds: z.number().int().positive().nullable(),
  mcpTools: z.boolean(),
  exactOnly: z.boolean(),
  approveAll: z.boolean(),
};

/** An egress domain pattern or host (the `egress_domains` grammar): never a URL or path. */
export const egressDomain = z.string().max(253).regex(new RegExp(DOMAIN_PATTERN_SQL));
export const count = z.number().int().nonnegative();
/**
 * A project's explicit role set (GV4): how many rows of each role, never who. `reader` only on rows
 * before KOBE-587 (no reader rows since: every member reads every project).
 */
export const projectRoleCounts = z.strictObject({
  owner: count,
  editor: count,
  reader: count.optional(),
});
/** A budget amount in dollars (KOBE-42). */
export const usdAmount = z.number().nonnegative().max(MAX_BUDGET_USD);
/** A token budget (KOBE-42, user decision: token budgets beside dollar budgets). */
export const tokenAmount = z.number().int().nonnegative().max(MAX_BUDGET_TOKENS);
/** Model gateway (KOBE-40): ids and names as the `model_providers` / `model_catalog` grammar. */
export const providerId = z.string().max(32).regex(new RegExp(PROVIDER_ID_PATTERN));
export const providerKind = z.enum(MODEL_PROVIDER_KINDS);
export const modelAlias = z.string().max(64).regex(new RegExp(MODEL_ALIAS_PATTERN));
/** A learning pass's extractor prompt version, e.g. `memory-extractor-v1` (KOBE-393). */
export const memoryPromptVersion = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);

/** The Site embedding model (KOBE-409): a gateway model id, `<provider>/<model>` (protocol's pattern). */
export const embeddingModel = z.union([
  modelAlias,
  z
    .string()
    .max(256)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._:/-]{0,190}$/),
]);
export const providerModel = z.string().max(200).regex(new RegExp(PROVIDER_MODEL_PATTERN));
/** A provider endpoint's host (name or IP literal, no path or credentials); null: vendor default. */
export const endpointHost = z
  .string()
  .max(255)
  .regex(/^[A-Za-z0-9.:[\]-]+$/)
  .nullable();

/** A break-glass grant (KOBE-16) by its scope; never the free-text reason. */
export const breakGlassScope = {
  grantId: id,
  scope: z.enum(["team", "user", "thread"]),
  subjectUserId: id.optional(),
  threadId: id.optional(),
  legalHold: z.boolean(),
};

/**
 * A legal hold (KOBE-17) by its id only: never the team, the scope, the held user or the reason
 * (a held site admin reads the site log; the console resolves the id).
 */
export const legalHoldRef = { holdId: id };

/** How many people a break-glass change queued notifications for (outbox rows), and how many of them are the team's admins. */
export const notified = {
  recipients: z.number().int().nonnegative(),
  teamAdmins: z.number().int().nonnegative().optional(),
};

/** A Pi tool call id (`idSchema` in @kaiju/protocol): no control characters, ≤ 128. */
export const toolCallId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[^\p{Cc}]*$/u);
/** A tool name as Pi sees it (`bash`, `mcp__jira__create_issue`): policy metadata. */
export const toolName = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\p{Cc}\p{Zl}\p{Zp}]*$/u);

export const retentionPeriod = z.enum(RETENTION_PERIODS);
/** What a purge deleted (counts only). */
export const purgeCounts = {
  entries: count,
  runs: count,
  events: count,
  blobs: count,
  /** MCP Apps results of the purged threads (KOBE-438); absent from earlier rows. */
  appResults: count.optional(),
};

export const semanticMemoryScope = z.enum(SEMANTIC_MEMORY_SCOPE_VALUES);
/**
 * A Site item's row-level fields, recorded before and after a change under a Site hold. Tags as a
 * count and an HMAC-SHA-256 (server key) of the sorted, lowercased list (JSON), never the values
 * (memory events carry no tag or statement).
 */
export const heldItemMetadata = z.strictObject({
  kind: z.enum(SEMANTIC_MEMORY_KIND_VALUES),
  tagCount: z.number().int().nonnegative().max(SEMANTIC_MEMORY_TAGS_MAX),
  tagsHmac: z.string().regex(/^[0-9a-f]{64}$/),
  policy: z.boolean(),
  asOf: z.iso.date().nullable(),
});

export const event = <const S extends AuditScope, T extends z.ZodRawShape>(scope: S, shape: T) => ({
  scope,
  target: z.strictObject(shape),
});

/** The shape every audit event definition has: where it appears and its strict target. */
export type AuditEventDef = { readonly scope: AuditScope; readonly target: z.ZodType };

/**
 * An event's row in the docs/audit-log.md taxonomy table (KOBE-815), kept per area in
 * `events/<area>.doc.ts` and rendered by `pnpm --filter @kaiju/db audit:doc`. Markdown on one line.
 */
export interface AuditEventDoc {
  /** The target fields, with values or meanings where they help; empty for none (shown as "—"). */
  readonly fields: string;
  /** When the event is recorded (and by whom, when not the signed-in user). */
  readonly when: string;
}
