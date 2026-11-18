/**
 * Who reads a Site proposal notice (KOBE-404): the same kind reaches people with different
 * pages (KOBE-403 notify.ts: `confirmed` reaches the Site's curators and the proposer; the
 * outcomes reach the proposer and the confirming Team admin). The bell asks the server once and
 * links each reader to a page they can open. Unknown (not asked yet, or the answer failed): the
 * reader's own My memory, which everyone can open.
 */
import type { KobeNotification } from "./api";
import { fetchSiteAccess, fetchTeamAccess } from "../admin/api/access";

export interface MemoryViewer {
  /** Site admin or Site memory steward: opens the Site console's Memory page. */
  readonly siteCurator: boolean;
  /** Team admin or Workspace memory steward: opens the Workspace console's Memory page. */
  readonly workspaceCurator: boolean;
}

export const UNKNOWN_VIEWER: MemoryViewer = { siteCurator: false, workspaceCurator: false };

const SITE_PROPOSAL = "memory.site_proposal.";

/** The notice's link depends on who reads it. */
export function needsViewer(n: KobeNotification): boolean {
  return n.kind.startsWith(SITE_PROPOSAL) || (n.relatedKind?.startsWith(SITE_PROPOSAL) ?? false);
}

export async function fetchMemoryViewer(fetchFn?: typeof fetch): Promise<MemoryViewer> {
  try {
    const [site, team] = await Promise.all([fetchSiteAccess(fetchFn), fetchTeamAccess(fetchFn)]);
    return {
      siteCurator:
        site.ok &&
        (site.data.siteRole !== "user" || (site.data.grants ?? []).includes("memory_steward")),
      workspaceCurator: team.ok && team.data.permissions.includes("team.memory.curate"),
    };
  } catch {
    return UNKNOWN_VIEWER;
  }
}
