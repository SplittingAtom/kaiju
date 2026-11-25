import { auditActorKind, auditQuerySchema, legalHoldStatus } from "@kaiju/db";
import { SEMANTIC_MEMORY_KINDS, SEMANTIC_MEMORY_STATUSES } from "@kaiju/protocol";
import { exportQuerySchema } from "../../../audit/export/http.js";
import { FORWARD_DESTINATIONS } from "../../../audit/forward/types.js";
import {
  grantEntriesQuerySchema,
  grantThreadsQuerySchema,
  listGrantsQuerySchema,
  requestGrantSchema,
} from "../../../break-glass/schemas.js";
import {
  requestHoldSchema,
  requestReleaseSchema,
  requestSiteHoldSchema,
} from "../../../legal-hold/schemas.js";
import { RETENTION_PERIODS } from "../../../retention/periods.js";
import { bodySchema as retentionBodySchema } from "../../../routes/site-retention.js";
import {
  listSiteGrantsQuerySchema,
  requestSiteGrantSchema,
  siteGrantItemsQuerySchema,
} from "../../../site-break-glass/schemas.js";
import { named, untyped, type CatalogDetail, type ErrorStatus } from "../build.js";
import {
  any,
  arr,
  bool,
  dateTime,
  int,
  nullable,
  obj,
  oneOfStrings,
  refTo,
  str,
  uuid,
} from "../json.js";

/**
 * Request and response schemas of the "Site: compliance" catalog area (KOBE-771): the site audit
 * log, Workspace and portable-memory break-glass, Workspace and Site-wide legal holds, and the
 * retention maximum. Bodies and queries come from the zod schemas the routes validate with; the
 * answers are built by the handlers without a schema (`untyped`, fields read from the handlers).
 */

// --- Audit -------------------------------------------------------------------------------

const auditEvent = obj({
  id: uuid,
  seq: int,
  at: dateTime,
  teamId: nullable(uuid),
  actor: obj({
    kind: oneOfStrings(...auditActorKind.enumValues),
    id: nullable(str),
    name: nullable(str),
    email: nullable(str),
  }),
  action: str,
  target: {
    type: "object",
    description:
      "The event's metadata. Workspace events show only allow-listed keys here (no thread, " +
      "entry or run ids); the Workspace's own log keeps the full record.",
  },
  ip: nullable(str),
  userAgent: nullable(str),
  prevHash: str,
  hash: str,
  "viaAgent?": obj({ threadId: uuid, runId: str, toolCallId: str, threadOpen: bool }),
});

const forwardingDestination = obj({
  destination: oneOfStrings(...FORWARD_DESTINATIONS),
  status: oneOfStrings("ok", "retrying", "failing", "pending"),
  behind: { ...nullable(int), description: "Events recorded but not yet delivered." },
  "seq?": int,
  "delivered?": int,
  "failures?": int,
  "nextAttemptAt?": nullable(dateTime),
  "lastSuccessAt?": nullable(dateTime),
  "lastErrorAt?": nullable(dateTime),
  "lastError?": nullable(str),
});

// --- Break-glass -------------------------------------------------------------------------

const person = obj({ id: uuid, name: str, email: str });
const grantStatus = oneOfStrings("pending", "active", "denied", "revoked", "expired");

/** Fields both kinds of break-glass grant share (`grantJson` in either route file). */
const grantCommon = {
  requestedBy: person,
  approvedBy: nullable(person),
  decidedBy: nullable(person),
  reason: str,
  legalHold: bool,
  durationMinutes: int,
  status: grantStatus,
  selfApproved: bool,
  requestedAt: dateTime,
  requestExpiresAt: dateTime,
  decidedAt: nullable(dateTime),
  startsAt: nullable(dateTime),
  expiresAt: nullable(dateTime),
  endedAt: nullable(dateTime),
  actions: {
    ...obj({ approve: bool, deny: bool, revoke: bool, read: bool }),
    description: "What the viewer may do (a courtesy; the server decides again).",
  },
};

const teamGrant = obj({
  id: uuid,
  team: obj({ id: uuid, slug: str, name: str }),
  scope: oneOfStrings("team", "user", "thread"),
  subject: nullable(person),
  threadId: nullable(uuid),
  ...grantCommon,
});
const portableGrant = obj({ id: uuid, subject: person, ...grantCommon });

const TeamGrantChanged = untyped(
  "BreakGlassGrantChanged",
  obj({
    grant: teamGrant,
    notified: obj({ recipients: int, "teamAdmins?": int }),
    warnings: arr(obj({ code: oneOfStrings("no_team_admin_notified"), message: str })),
  }),
);
const TeamGrant = untyped("BreakGlassGrantResponse", obj({ grant: teamGrant }));
const PortableGrantChanged = untyped(
  "PortableBreakGlassGrantChanged",
  obj({ grant: portableGrant, notified: obj({ recipients: int }) }),
);
const PortableGrant = untyped("PortableBreakGlassGrantResponse", obj({ grant: portableGrant }));

/** What a reader sees of the grant it reads under (`readGrantJson`). */
const readGrant = obj({
  id: uuid,
  team_id: uuid,
  scope: oneOfStrings("team", "user", "thread"),
  user_id: nullable(uuid),
  thread_id: nullable(uuid),
  expires_at: dateTime,
});
const portableReadGrant = obj({
  id: uuid,
  subject_user_id: uuid,
  expires_at: dateTime,
  workspaces: { ...int, description: "How many Workspaces the person belongs to." },
});
const portableItem = obj({
  id: uuid,
  kind: oneOfStrings(...SEMANTIC_MEMORY_KINDS),
  status: oneOfStrings(...SEMANTIC_MEMORY_STATUSES),
  superseded_by: nullable(uuid),
  pinned: bool,
  tags: arr(str),
  current_version: int,
  statement: str,
  created_at: dateTime,
  updated_at: dateTime,
});

/** Request, approve, deny, revoke: the grant's own refusals (404, 409 state, 429 caps). */
const DECIDE_ERRORS: readonly ErrorStatus[] = ["404", "409"];
/** Reads: unknown grant or thread (404), not active (403, default), per-minute cap (429). */
const READ_ERRORS: readonly ErrorStatus[] = ["404", "429"];

// --- Legal holds -------------------------------------------------------------------------

const holdCommon = {
  reason: str,
  status: oneOfStrings(...legalHoldStatus.enumValues),
  requestedBy: person,
  requestedAt: dateTime,
  approvedBy: nullable(person),
  approvedAt: nullable(dateTime),
  selfApproved: bool,
  closedBy: nullable(person),
  closedAt: nullable(dateTime),
  release: nullable(
    obj({ requestedBy: nullable(person), requestedAt: nullable(dateTime), reason: nullable(str) }),
  ),
  releasedBy: nullable(person),
  releasedAt: nullable(dateTime),
  releaseSelfApproved: bool,
  actions: {
    ...obj({
      approve: bool,
      deny: bool,
      withdraw: bool,
      requestRelease: bool,
      approveRelease: bool,
      denyRelease: bool,
      withdrawRelease: bool,
    }),
    description: "What the viewer may do (a courtesy; the server decides again).",
  },
};
const workspaceHold = obj({
  id: uuid,
  team: obj({ id: uuid, slug: str, name: str }),
  scope: oneOfStrings("team", "user"),
  subject: nullable(person),
  ...holdCommon,
});
const siteHold = obj({ id: uuid, ...holdCommon });
const Hold = untyped("LegalHoldResponse", obj({ hold: workspaceHold }));
const SiteHold = untyped("SiteLegalHoldResponse", obj({ hold: siteHold }));
const HOLD_ERRORS: readonly ErrorStatus[] = ["404", "409"];
const holdDecision = { body: null, response: Hold, errors: HOLD_ERRORS } as const;
const siteHoldDecision = { body: null, response: SiteHold, errors: HOLD_ERRORS } as const;
const ReleaseBody = named("LegalHoldReleaseBody", requestReleaseSchema);

// --- Retention ---------------------------------------------------------------------------

const period = oneOfStrings(...RETENTION_PERIODS);
const maximumView = {
  maximum: { ...period, description: "The maximum as chosen (in force or pending)." },
  applied: { ...period, description: "In force now." },
  pending: nullable(obj({ maximum: period, effectiveAt: dateTime })),
};
const RetentionMaximum = untyped("SiteRetentionMaximum", obj(maximumView));

/** KOBE-826: the built-in connectors' Pi server segments before the rename → since. */
export const RENAMED_TOOL_SEGMENTS = {
  type: "object",
  additionalProperties: str,
  description:
    "Pi server segments of the built-in connectors before the rename, each with the segment it " +
    "has had since (`kobe` → `kaiju`); empty when the upgrade renamed nothing. Events keep the " +
    "tool names they were recorded with, so `mcp__kobe__docs_index` is today's " +
    "`mcp__kaiju__docs_index`.",
};

export const siteComplianceDetails: Readonly<Record<string, CatalogDetail>> = {
  // Audit
  "get /v1/site/audit": {
    query: auditQuerySchema,
    response: untyped(
      "SiteAuditPage",
      obj({
        events: arr(auditEvent),
        nextCursor: {
          ...nullable(str),
          description: "Opaque: pass as `before` (or `after`) for the next page.",
        },
        renamedToolSegments: RENAMED_TOOL_SEGMENTS,
      }),
    ),
  },
  "get /v1/site/audit/export": {
    query: exportQuerySchema,
    produces: "text/csv",
    responseDescription:
      "The log as an attachment: `text/csv` for `format=csv`, `application/x-ndjson` for " +
      "`format=jsonl`. Streamed; `since` must not be after `until`.",
    errors: ["429"],
  },
  "get /v1/site/audit/forwarding": {
    response: untyped(
      "AuditForwardingHealth",
      obj({ enabled: bool, head: int, destinations: arr(forwardingDestination) }),
    ),
  },
  "get /v1/site/audit/integrity": {
    response: untyped(
      "AuditChainIntegrity",
      obj({
        ok: bool,
        checked: int,
        head: nullable(obj({ seq: int, hash: str })),
        "problem?": obj({
          seq: int,
          kind: oneOfStrings(
            "gap",
            "prev_hash_mismatch",
            "hash_mismatch",
            "pii_mismatch",
            "seal_mismatch",
            "extra_seal",
          ),
        }),
        anchor: {
          ...nullable(obj({ seq: int, hash: str, at: dateTime, mac: str })),
          description: "The head attested with a key outside the database (null for an empty log).",
        },
      }),
    ),
    errors: ["429"],
  },

  // Workspace break-glass
  "get /v1/site/break-glass": {
    query: listGrantsQuerySchema,
    response: untyped(
      "BreakGlassGrantList",
      obj({ grants: arr(teamGrant), selfApprovalAllowed: bool }),
    ),
  },
  "post /v1/site/break-glass": {
    body: named("RequestBreakGlassBody", requestGrantSchema),
    status: 201,
    response: TeamGrantChanged,
    errors: ["404", "429"],
  },
  "get /v1/site/break-glass/{id}": { response: TeamGrant, errors: ["404"] },
  "post /v1/site/break-glass/{id}/approve": {
    body: null,
    response: TeamGrantChanged,
    errors: DECIDE_ERRORS,
  },
  "post /v1/site/break-glass/{id}/deny": {
    body: null,
    response: TeamGrantChanged,
    errors: DECIDE_ERRORS,
  },
  "post /v1/site/break-glass/{id}/revoke": {
    body: null,
    response: TeamGrantChanged,
    errors: DECIDE_ERRORS,
  },
  "get /v1/site/break-glass/{id}/threads": {
    query: grantThreadsQuerySchema,
    response: untyped(
      "BreakGlassThreadPage",
      obj({ grant: readGrant, threads: arr(refTo("Thread")), next_cursor: nullable(str) }),
    ),
    errors: READ_ERRORS,
  },
  "get /v1/site/break-glass/{id}/threads/{threadId}": {
    response: untyped("BreakGlassThread", obj({ grant: readGrant, thread: refTo("Thread") })),
    errors: READ_ERRORS,
  },
  "get /v1/site/break-glass/{id}/threads/{threadId}/entries": {
    query: grantEntriesQuerySchema,
    response: untyped(
      "BreakGlassEntryPage",
      obj({
        grant: readGrant,
        entries: arr(
          obj({
            entry_id: str,
            parent_id: nullable(str),
            seq: int,
            type: str,
            payload: { ...any, description: "`{}` when the body was offloaded to object storage." },
            payload_offloaded: bool,
            created_at: dateTime,
          }),
        ),
        next_after: nullable(int),
      }),
    ),
    errors: READ_ERRORS,
  },

  // Portable-memory break-glass
  "get /v1/site/portable-break-glass": {
    query: listSiteGrantsQuerySchema,
    response: untyped(
      "PortableBreakGlassGrantList",
      obj({ grants: arr(portableGrant), selfApprovalAllowed: bool }),
    ),
  },
  "post /v1/site/portable-break-glass": {
    body: named("RequestPortableBreakGlassBody", requestSiteGrantSchema),
    status: 201,
    response: PortableGrantChanged,
    errors: ["404", "429"],
  },
  "get /v1/site/portable-break-glass/{id}": { response: PortableGrant, errors: ["404"] },
  "post /v1/site/portable-break-glass/{id}/approve": {
    body: null,
    response: PortableGrantChanged,
    errors: DECIDE_ERRORS,
  },
  "post /v1/site/portable-break-glass/{id}/deny": {
    body: null,
    response: PortableGrantChanged,
    errors: DECIDE_ERRORS,
  },
  "get /v1/site/portable-break-glass/{id}/items": {
    query: siteGrantItemsQuerySchema,
    response: untyped(
      "PortableBreakGlassItemPage",
      obj({ grant: portableReadGrant, items: arr(portableItem), next_after: nullable(uuid) }),
    ),
    errors: READ_ERRORS,
  },
  "get /v1/site/portable-break-glass/{id}/items/{itemId}": {
    response: untyped(
      "PortableBreakGlassItem",
      obj({
        grant: portableReadGrant,
        item: portableItem,
        versions: arr(obj({ version: int, statement: str, actor_kind: str, created_at: dateTime })),
      }),
    ),
    errors: READ_ERRORS,
  },
  "post /v1/site/portable-break-glass/{id}/revoke": {
    body: null,
    response: PortableGrantChanged,
    errors: DECIDE_ERRORS,
  },

  // Workspace legal holds
  "get /v1/site/legal-hold": {
    response: untyped(
      "LegalHoldList",
      obj({ holds: arr(workspaceHold), selfApprovalAllowed: bool }),
    ),
    responseDescription: "Holds about the viewer are not listed. No query parameters accepted.",
  },
  "post /v1/site/legal-hold": {
    body: named("RequestLegalHoldBody", requestHoldSchema),
    status: 201,
    response: Hold,
    errors: ["404"],
  },
  "get /v1/site/legal-hold/{id}": { response: Hold, errors: ["404"] },
  "post /v1/site/legal-hold/{id}/approve": holdDecision,
  "post /v1/site/legal-hold/{id}/deny": holdDecision,
  "post /v1/site/legal-hold/{id}/release": { ...holdDecision, body: ReleaseBody },
  "post /v1/site/legal-hold/{id}/release/approve": holdDecision,
  "post /v1/site/legal-hold/{id}/release/deny": holdDecision,
  "post /v1/site/legal-hold/{id}/release/withdraw": holdDecision,
  "post /v1/site/legal-hold/{id}/withdraw": holdDecision,

  // Site-wide legal holds
  "get /v1/site/site-legal-hold": {
    response: untyped(
      "SiteLegalHoldList",
      obj({
        holds: arr(siteHold),
        active: { ...bool, description: "Site memory is held now." },
        selfApprovalAllowed: bool,
      }),
    ),
    responseDescription: "No query parameters accepted.",
  },
  "post /v1/site/site-legal-hold": {
    body: named("RequestSiteLegalHoldBody", requestSiteHoldSchema),
    status: 201,
    response: SiteHold,
  },
  "get /v1/site/site-legal-hold/{id}": { response: SiteHold, errors: ["404"] },
  "post /v1/site/site-legal-hold/{id}/approve": siteHoldDecision,
  "post /v1/site/site-legal-hold/{id}/deny": siteHoldDecision,
  "post /v1/site/site-legal-hold/{id}/release": { ...siteHoldDecision, body: ReleaseBody },
  "post /v1/site/site-legal-hold/{id}/release/approve": siteHoldDecision,
  "post /v1/site/site-legal-hold/{id}/release/deny": siteHoldDecision,
  "post /v1/site/site-legal-hold/{id}/release/withdraw": siteHoldDecision,
  "post /v1/site/site-legal-hold/{id}/withdraw": siteHoldDecision,

  // Retention maximum
  "get /v1/site/retention": {
    response: untyped(
      "SiteRetentionState",
      obj({
        ...maximumView,
        paused: { ...bool, description: "Retention sweeps are paused on this site." },
      }),
    ),
  },
  "put /v1/site/retention": {
    body: named("SiteRetentionBody", retentionBodySchema),
    response: RetentionMaximum,
    responseDescription:
      "Lowering is scheduled after the grace period (`pending`); raising applies now.",
  },
  "delete /v1/site/retention/pending": {
    response: RetentionMaximum,
    errors: ["404"],
  },
};
