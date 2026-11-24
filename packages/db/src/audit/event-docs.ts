import { AUDIT_ACTIONS, AUDIT_EVENTS, type AuditAction } from "./events.js";
import type { AuditEventDoc } from "./events/fragments.js";
import { AGENTS_EVENT_DOCS } from "./events/agents.doc.js";
import { CONNECTOR_GRANTS_EVENT_DOCS } from "./events/connector-grants.doc.js";
import { CONNECTORS_EVENT_DOCS } from "./events/connectors.doc.js";
import { EGRESS_EVENT_DOCS } from "./events/egress.doc.js";
import { GIT_EVENT_DOCS } from "./events/git.doc.js";
import { GOVERNANCE_EVENT_DOCS } from "./events/governance.doc.js";
import { IDENTITY_EVENT_DOCS } from "./events/identity.doc.js";
import { MCP_EVENT_DOCS } from "./events/mcp.doc.js";
import { MEMORY_EVENT_DOCS } from "./events/memory.doc.js";
import { MODELS_EVENT_DOCS } from "./events/models.doc.js";
import { PLATFORM_EVENT_DOCS } from "./events/platform.doc.js";
import { RUNS_EVENT_DOCS } from "./events/runs.doc.js";
import { SANDBOX_WIRE_EVENT_DOCS } from "./events/sandbox-wire.doc.js";
import { SKILLS_EVENT_DOCS } from "./events/skills.doc.js";
import { THREADS_EVENT_DOCS } from "./events/threads.doc.js";

export type { AuditEventDoc } from "./events/fragments.js";

/**
 * Every audit event's row in the docs/audit-log.md taxonomy table (KOBE-815). Each area keeps its
 * rows in `events/<area>.doc.ts`, beside its definitions and typed against them, so an event
 * without a row (or a row without an event) fails the typecheck. The table between the markers
 * below is generated from these by `pnpm --filter @kaiju/db audit:doc` (`--check` to verify;
 * `events.test.ts` fails when the page is stale). One unpadded row per event, sorted by name and
 * excluded from prettier, so two branches that each add an event touch different lines.
 */
export const AUDIT_EVENT_DOCS: Readonly<Record<AuditAction, AuditEventDoc>> = {
  ...IDENTITY_EVENT_DOCS,
  ...PLATFORM_EVENT_DOCS,
  ...EGRESS_EVENT_DOCS,
  ...MODELS_EVENT_DOCS,
  ...MCP_EVENT_DOCS,
  ...THREADS_EVENT_DOCS,
  ...GOVERNANCE_EVENT_DOCS,
  ...RUNS_EVENT_DOCS,
  ...SANDBOX_WIRE_EVENT_DOCS,
  ...AGENTS_EVENT_DOCS,
  ...SKILLS_EVENT_DOCS,
  ...CONNECTORS_EVENT_DOCS,
  ...MEMORY_EVENT_DOCS,
  ...CONNECTOR_GRANTS_EVENT_DOCS,
  ...GIT_EVENT_DOCS,
};

/** Every area's rows, for the per-area checks in `events.test.ts`. */
export const AUDIT_EVENT_DOC_AREAS: readonly Readonly<Record<string, AuditEventDoc>>[] = [
  IDENTITY_EVENT_DOCS,
  PLATFORM_EVENT_DOCS,
  EGRESS_EVENT_DOCS,
  MODELS_EVENT_DOCS,
  MCP_EVENT_DOCS,
  THREADS_EVENT_DOCS,
  GOVERNANCE_EVENT_DOCS,
  RUNS_EVENT_DOCS,
  SANDBOX_WIRE_EVENT_DOCS,
  AGENTS_EVENT_DOCS,
  SKILLS_EVENT_DOCS,
  CONNECTORS_EVENT_DOCS,
  MEMORY_EVENT_DOCS,
  CONNECTOR_GRANTS_EVENT_DOCS,
  GIT_EVENT_DOCS,
];

export const AUDIT_TABLE_START =
  "<!-- audit-events:start: generated from packages/db/src/audit/events/*.doc.ts by `pnpm --filter @kaiju/db audit:doc`; do not edit by hand -->";
export const AUDIT_TABLE_END = "<!-- audit-events:end -->";

/** Plain code-point order, the same on every machine and locale. */
export function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cell(action: string, which: keyof AuditEventDoc, value: string): string {
  if (/[|\r\n]/.test(value)) {
    throw new Error(`audit doc for ${action}: ${which} must be one line without "|"`);
  }
  if (which === "when" && value.trim() === "") {
    throw new Error(`audit doc for ${action}: when is empty`);
  }
  return value.trim() === "" ? "—" : value.trim();
}

/** The generated block: markers, prettier-ignore range and one row per action, sorted by name. */
export function renderAuditEventTable(): string {
  const rows = [...AUDIT_ACTIONS].sort(compareNames).map((action) => {
    const doc = AUDIT_EVENT_DOCS[action];
    const fields = cell(action, "fields", doc.fields);
    const when = cell(action, "when", doc.when);
    return `| \`${action}\` | ${AUDIT_EVENTS[action].scope} | ${fields} | ${when} |`;
  });
  return [
    AUDIT_TABLE_START,
    "<!-- prettier-ignore-start -->",
    "",
    "| Action | Scope | Target fields (allowlist) | Recorded when |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    "<!-- prettier-ignore-end -->",
    AUDIT_TABLE_END,
  ].join("\n");
}

/**
 * The page with its generated block replaced by the current one. Everything between the start
 * and end marker lines is replaced, so leftover conflict markers inside the block go too.
 */
export function withAuditEventTable(markdown: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => l.startsWith("<!-- audit-events:start"));
  const end = lines.findIndex((l) => l === AUDIT_TABLE_END);
  if (start < 0 || end < start) {
    throw new Error(
      "docs/audit-log.md: missing the audit-events:start / audit-events:end marker lines",
    );
  }
  return [...lines.slice(0, start), renderAuditEventTable(), ...lines.slice(end + 1)].join("\n");
}
