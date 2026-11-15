import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { audit, type AuditRequestContext } from "../audit/write.js";
import type { KobeDb, KobeTx } from "../client.js";
import type { BreakGlassStatus } from "../schema/break-glass.js";
import {
  portableMemoryItemVersions,
  portableMemoryItems,
  type SemanticMemoryKind,
  type SemanticMemoryStatus,
} from "../schema/semantic-memory.js";
import { siteBreakGlassGrants } from "../schema/site-break-glass.js";
import { teamMembers } from "../schema/team-members.js";
import { teams } from "../schema/teams.js";
import { TEAM_ID_SETTING } from "../settings.js";

/**
 * Site-level break-glass reads (KOBE-648, SM28; amends D10): the only way anyone but their owner
 * reads a person's portable memories. Portable rows are site-wide (no RLS); every other server path
 * confines them to `owner_user_id` = the caller, so this module is the whole cross-person surface.
 *
 * `readPortableWithSiteBreakGlass()` runs one read in one transaction:
 *   1. locks the grant row (`FOR SHARE`) and verifies in the same statement that it is approved,
 *      inside its window (statement time), requested by this admin, and that the admin is still an
 *      active site admin. A concurrent revocation waits for the read; a later read is refused.
 *   2. finds the Workspaces the person belongs to, visiting each team under its own RLS
 *      (transaction-local `kobe.team_id`, cleared afterwards), as `scanTeams()` does;
 *   3. records `governance.site_break_glass.read` once in the Site log and once in each of those
 *      Workspaces (their audit views), the transaction's only writes;
 *   4. switches the transaction to read-only, so nothing after this point can write;
 *   5. reads the subject's portable items (and versions), always filtered on the grant's subject.
 * A read of an item outside the grant (another person's, or no such item) throws and rolls back
 * with its audit rows: nothing was read. The transaction is never handed to the caller.
 */

export interface SiteBreakGlassAccess {
  readonly grantId: string;
  /** The signed-in site admin; must be the grant's requester. */
  readonly adminId: string;
  readonly request?: AuditRequestContext;
}

export type PortableBreakGlassRead =
  | { readonly kind: "items"; readonly afterId?: string | null; readonly limit: number }
  | { readonly kind: "item"; readonly itemId: string };

export const PORTABLE_BREAK_GLASS_ITEMS_MAX = 100;

export interface SiteBreakGlassGrantView {
  readonly id: string;
  readonly subjectUserId: string;
  readonly legalHold: boolean;
  readonly expiresAt: Date;
  /** Workspaces the read was recorded in (the person's memberships at read time). */
  readonly workspaces: number;
}

export interface PortableBreakGlassItem {
  readonly id: string;
  readonly kind: SemanticMemoryKind;
  readonly status: SemanticMemoryStatus;
  readonly supersededBy: string | null;
  readonly pinned: boolean;
  readonly tags: readonly string[];
  readonly currentVersion: number;
  /** The current version's statement. */
  readonly statement: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface PortableBreakGlassVersion {
  readonly version: number;
  readonly statement: string;
  readonly actorKind: string;
  readonly createdAt: Date;
}

export type PortableBreakGlassResult =
  | {
      readonly kind: "items";
      readonly grant: SiteBreakGlassGrantView;
      readonly items: readonly PortableBreakGlassItem[];
      readonly nextAfterId: string | null;
    }
  | {
      readonly kind: "item";
      readonly grant: SiteBreakGlassGrantView;
      readonly item: PortableBreakGlassItem;
      readonly versions: readonly PortableBreakGlassVersion[];
    };

export type SiteBreakGlassDeniedCode = "grant_not_found" | "grant_not_active" | "not_found";

export class SiteBreakGlassDenied extends Error {
  override readonly name = "SiteBreakGlassDenied";
  constructor(
    readonly code: SiteBreakGlassDeniedCode,
    readonly status?: BreakGlassStatus,
  ) {
    super(`site break-glass read refused: ${code}`);
  }
}

const uuid = z.uuid();
const readSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("items"),
    afterId: uuid.nullish(),
    limit: z.number().int().min(1).max(PORTABLE_BREAK_GLASS_ITEMS_MAX),
  }),
  z.object({ kind: z.literal("item"), itemId: uuid }),
]);

const STATEMENT_TIMEOUT = "10s";
const LOCK_TIMEOUT = "5s";

interface LockedGrant {
  readonly id: string;
  readonly subjectUserId: string;
  readonly legalHold: boolean;
  readonly expiresAt: Date;
}

/** Step 1: the active grant for this admin, row-locked against concurrent revocation. */
async function lockActiveGrant(tx: KobeTx, access: SiteBreakGlassAccess): Promise<LockedGrant> {
  const result = await tx.execute<{
    id: string;
    subject_user_id: string;
    legal_hold: boolean;
    expires_at: string;
  }>(sql`
    SELECT g.id, g.subject_user_id, g.legal_hold, g.expires_at
    FROM ${siteBreakGlassGrants} g
    JOIN users u ON u.id = g.admin_id AND u.deactivated_at IS NULL
    JOIN site_roles r ON r.user_id = g.admin_id
    WHERE g.id = ${access.grantId} AND g.admin_id = ${access.adminId}
      AND g.status = 'approved' AND g.starts_at <= statement_timestamp()
      AND g.expires_at > statement_timestamp()
    FOR SHARE OF g`);
  const row = result.rows[0];
  if (row) {
    return {
      id: row.id,
      subjectUserId: row.subject_user_id,
      legalHold: row.legal_hold,
      expiresAt: new Date(row.expires_at),
    };
  }
  const [known] = await tx
    .select({ status: siteBreakGlassGrants.status })
    .from(siteBreakGlassGrants)
    .where(
      and(
        eq(siteBreakGlassGrants.id, access.grantId),
        eq(siteBreakGlassGrants.adminId, access.adminId),
      ),
    );
  throw known
    ? new SiteBreakGlassDenied("grant_not_active", known.status)
    : new SiteBreakGlassDenied("grant_not_found");
}

/** Step 2: the person's Workspaces, each visited under its own team policy, then cleared. */
async function workspacesOf(tx: KobeTx, userId: string): Promise<string[]> {
  const all = await tx.select({ id: teams.id }).from(teams).orderBy(asc(teams.id));
  const found: string[] = [];
  for (const team of all) {
    await tx.execute(sql`SELECT set_config(${TEAM_ID_SETTING}, ${team.id}, true)`);
    const [row] = await tx
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, userId)));
    if (row) found.push(team.id);
  }
  await tx.execute(sql`SELECT set_config(${TEAM_ID_SETTING}, '', true)`);
  return found;
}

const itemColumns = {
  id: portableMemoryItems.id,
  kind: portableMemoryItems.kind,
  status: portableMemoryItems.status,
  supersededBy: portableMemoryItems.supersededBy,
  pinned: portableMemoryItems.pinned,
  tags: portableMemoryItems.tags,
  currentVersion: portableMemoryItems.currentVersion,
  statement: portableMemoryItemVersions.statement,
  createdAt: portableMemoryItems.createdAt,
  updatedAt: portableMemoryItems.updatedAt,
};

/** The subject's items joined to their current version; every query adds the owner filter. */
function itemsQuery(tx: KobeTx, where: ReturnType<typeof and>) {
  return tx
    .select(itemColumns)
    .from(portableMemoryItems)
    .innerJoin(
      portableMemoryItemVersions,
      and(
        eq(portableMemoryItemVersions.itemId, portableMemoryItems.id),
        eq(portableMemoryItemVersions.version, portableMemoryItems.currentVersion),
      ),
    )
    .where(where);
}

async function readItems(
  tx: KobeTx,
  grant: SiteBreakGlassGrantView,
  read: Extract<PortableBreakGlassRead, { kind: "items" }>,
): Promise<PortableBreakGlassResult> {
  const rows = await itemsQuery(
    tx,
    and(
      eq(portableMemoryItems.ownerUserId, grant.subjectUserId),
      read.afterId ? sql`${portableMemoryItems.id} > ${read.afterId}::uuid` : undefined,
    ),
  )
    .orderBy(asc(portableMemoryItems.id))
    .limit(read.limit + 1);
  const page = rows.slice(0, read.limit);
  return {
    kind: "items",
    grant,
    items: page,
    nextAfterId: rows.length > read.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

async function readItem(
  tx: KobeTx,
  grant: SiteBreakGlassGrantView,
  itemId: string,
): Promise<PortableBreakGlassResult> {
  const [item] = await itemsQuery(
    tx,
    and(
      eq(portableMemoryItems.ownerUserId, grant.subjectUserId),
      eq(portableMemoryItems.id, itemId),
    ),
  );
  if (!item) throw new SiteBreakGlassDenied("not_found");
  const versions = await tx
    .select({
      version: portableMemoryItemVersions.version,
      statement: portableMemoryItemVersions.statement,
      actorKind: portableMemoryItemVersions.actorKind,
      createdAt: portableMemoryItemVersions.createdAt,
    })
    .from(portableMemoryItemVersions)
    .where(
      and(
        eq(portableMemoryItemVersions.itemId, item.id),
        eq(portableMemoryItemVersions.actorUserId, grant.subjectUserId),
      ),
    )
    .orderBy(asc(portableMemoryItemVersions.version));
  return { kind: "item", grant, item, versions };
}

/**
 * Reads one person's portable memories under an active Site-level grant (see the module comment).
 * Throws `SiteBreakGlassDenied` when the grant isn't usable by this admin right now or the item is
 * not the subject's, and `AuditBusyError` when the audit rows can't be written.
 */
export async function readPortableWithSiteBreakGlass(
  db: KobeDb,
  access: SiteBreakGlassAccess,
  read: PortableBreakGlassRead,
): Promise<PortableBreakGlassResult> {
  if (!uuid.safeParse(access.grantId).success || !uuid.safeParse(access.adminId).success) {
    throw new SiteBreakGlassDenied("grant_not_found");
  }
  const parsed = readSchema.parse(read) as PortableBreakGlassRead;
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('statement_timeout', ${STATEMENT_TIMEOUT}, true),
                                set_config('lock_timeout', ${LOCK_TIMEOUT}, true)`);
    const team = await tx.execute<{ team: string | null }>(
      sql`SELECT NULLIF(current_setting(${TEAM_ID_SETTING}, true), '') AS team`,
    );
    if (team.rows[0]?.team) {
      throw new Error("readPortableWithSiteBreakGlass: already inside a team context");
    }
    const locked = await lockActiveGrant(tx, access);
    const workspaces = await workspacesOf(tx, locked.subjectUserId);
    const grant: SiteBreakGlassGrantView = { ...locked, workspaces: workspaces.length };

    const object = parsed.kind === "items" ? "portable_items" : "portable_item";
    const itemId = parsed.kind === "item" ? parsed.itemId : undefined;
    const actor = { kind: "user", id: access.adminId } as const;
    const request = access.request ? { request: access.request } : {};
    // Workspace rows never name the person under legal hold (their admins may be the person).
    const shown = locked.legalHold ? {} : { subjectUserId: locked.subjectUserId };
    for (const teamId of workspaces) {
      await audit(tx, {
        action: "governance.site_break_glass.read",
        actor,
        teamId,
        target: {
          grantId: locked.id,
          object,
          ...shown,
          ...(itemId && !locked.legalHold ? { itemId } : {}),
        },
        ...request,
      });
    }
    await audit(tx, {
      action: "governance.site_break_glass.read",
      actor,
      teamId: null,
      target: {
        grantId: locked.id,
        object,
        ...shown,
        // Not under legal hold either: a held site admin reads the Site log (security review).
        ...(itemId && !locked.legalHold ? { itemId } : {}),
        workspaces: workspaces.length,
      },
      ...request,
    });
    // From here on the transaction can't write (the audit rows above are its only writes).
    await tx.execute(sql`SET LOCAL transaction_read_only = on`);

    return parsed.kind === "items"
      ? readItems(tx, grant, parsed)
      : readItem(tx, grant, parsed.itemId);
  });
}
