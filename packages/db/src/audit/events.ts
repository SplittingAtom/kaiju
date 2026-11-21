import type { z } from "zod";
import { IDENTITY_EVENTS } from "./events/identity.js";
import { PLATFORM_EVENTS } from "./events/platform.js";
import { EGRESS_EVENTS } from "./events/egress.js";
import { MODELS_EVENTS } from "./events/models.js";
import { MCP_EVENTS } from "./events/mcp.js";
import { THREADS_EVENTS } from "./events/threads.js";
import { GOVERNANCE_EVENTS } from "./events/governance.js";
import { RUNS_EVENTS } from "./events/runs.js";
import { SANDBOX_WIRE_EVENTS } from "./events/sandbox-wire.js";
import { AGENTS_EVENTS } from "./events/agents.js";
import { SKILLS_EVENTS } from "./events/skills.js";
import { CONNECTORS_EVENTS } from "./events/connectors.js";
import { MEMORY_EVENTS } from "./events/memory.js";
import { CONNECTOR_GRANTS_EVENTS } from "./events/connector-grants.js";

export * from "./events/vocab.js";
export type { AuditScope } from "./events/fragments.js";

/**
 * The audit event taxonomy (KOBE-15, spec D31). Every audited action is one entry: its dotted name,
 * which audit view it belongs to, and the **allowlist** of metadata fields it may record. Targets
 * are strict zod objects of ids, enums, booleans, counts and short labels, so a secret, token,
 * password, prompt or message text can't be recorded by accident: unknown keys are rejected and
 * the write fails (with the action it was meant to record).
 *
 * Adding an event: add an entry to its area's file in `events/` (a new area is a new file, listed
 * in both `AUDIT_EVENT_AREAS` and `AUDIT_EVENTS` below). Never reuse or rename a published action
 * (export and SIEM consumers key on it); call `audit()` in the transaction that performs the
 * action, and test it.
 * The one rename so far (KOBE-255, "install" became "site") is listed in
 * `HISTORICAL_AUDIT_ACTIONS`: old rows keep their names, readers accept both.
 */

/**
 * Every area's events in one place, in taxonomy order. Each area keeps its own file so parallel
 * tickets adding events don't edit one file; `events.test.ts` checks that no action name appears
 * in two areas (a spread would silently let the later one win).
 */
export const AUDIT_EVENT_AREAS = [
  IDENTITY_EVENTS,
  PLATFORM_EVENTS,
  EGRESS_EVENTS,
  MODELS_EVENTS,
  MCP_EVENTS,
  THREADS_EVENTS,
  GOVERNANCE_EVENTS,
  RUNS_EVENTS,
  SANDBOX_WIRE_EVENTS,
  AGENTS_EVENTS,
  SKILLS_EVENTS,
  CONNECTORS_EVENTS,
  MEMORY_EVENTS,
  CONNECTOR_GRANTS_EVENTS,
] as const;

export const AUDIT_EVENTS = {
  ...IDENTITY_EVENTS,
  ...PLATFORM_EVENTS,
  ...EGRESS_EVENTS,
  ...MODELS_EVENTS,
  ...MCP_EVENTS,
  ...THREADS_EVENTS,
  ...GOVERNANCE_EVENTS,
  ...RUNS_EVENTS,
  ...SANDBOX_WIRE_EVENTS,
  ...AGENTS_EVENTS,
  ...SKILLS_EVENTS,
  ...CONNECTORS_EVENTS,
  ...MEMORY_EVENTS,
  ...CONNECTOR_GRANTS_EVENTS,
} as const;

export type AuditAction = keyof typeof AUDIT_EVENTS;
export type AuditTarget<A extends AuditAction> = z.input<(typeof AUDIT_EVENTS)[A]["target"]>;

export const AUDIT_ACTIONS = Object.keys(AUDIT_EVENTS) as AuditAction[];

/** Top-level categories (`auth`, `identity`, …), for filtering. */
export const AUDIT_CATEGORIES = [...new Set(AUDIT_ACTIONS.map((a) => a.split(".")[0] ?? a))];

export function isAuditAction(value: string): value is AuditAction {
  return Object.hasOwn(AUDIT_EVENTS, value);
}

/**
 * Action names rows were recorded under before KOBE-255 renamed the "install" scope to "site",
 * each with the action that replaced it. Never written again; historical rows keep them (the hash
 * chain covers the stored name), so filters for either name find both (`auditActionNames`).
 */
export const HISTORICAL_AUDIT_ACTIONS: Readonly<Record<string, AuditAction>> = Object.freeze({
  "install.settings.updated": "site.settings.updated",
  "identity.install_role.granted": "identity.site_role.granted",
  "identity.install_role.revoked": "identity.site_role.revoked",
  "memory.install_settings_changed": "memory.site_settings_changed",
});

/** Categories of historical rows by the category that replaced them (`install` → `site`). */
const HISTORICAL_CATEGORIES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  site: ["install"],
});

/** The current action for a current or historical name, or null for an unknown name. */
export function currentAuditAction(value: string): AuditAction | null {
  if (isAuditAction(value)) return value;
  return Object.hasOwn(HISTORICAL_AUDIT_ACTIONS, value)
    ? (HISTORICAL_AUDIT_ACTIONS[value] ?? null)
    : null;
}

/** Every stored name of an action: the current one first, then the historical ones. */
export function auditActionNames(action: AuditAction): string[] {
  const old = Object.keys(HISTORICAL_AUDIT_ACTIONS).filter(
    (name) => HISTORICAL_AUDIT_ACTIONS[name] === action,
  );
  return [action, ...old];
}

/** The current category for a current or historical one (`install` → `site`), or null. */
export function currentAuditCategory(value: string): string | null {
  if (AUDIT_CATEGORIES.includes(value)) return value;
  const found = Object.entries(HISTORICAL_CATEGORIES).find(([, old]) => old.includes(value));
  return found ? found[0] : null;
}

/** Every stored category a filter on `category` matches: the current one, then historical ones. */
export function auditCategoryNames(category: string): string[] {
  return [category, ...(HISTORICAL_CATEGORIES[category] ?? [])];
}
