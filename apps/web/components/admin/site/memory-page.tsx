"use client";

import { useState } from "react";
import { isUuid } from "../../../lib/memory/ids";
import { fetchMyTeams } from "../../../lib/teams";
import { CuratorMemories } from "../../memory/curator-memories";
import { ExportPanel } from "../../memory/export-panel";
import { ImportPanel } from "../../memory/import-panel";
import { MemoryQuality } from "../../memory/quality/memory-quality";
import { PageHeader, Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/console";
import { useSiteAccess } from "../console-context";
import { SiteProposals } from "./memory-proposals/site-proposals";
import { ResourceView } from "../parts";
import { useResource } from "../use-resource";

/** Site roles that set Policy (`site.memory.policy`: Site admins and the Owner). */
const POLICY_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

/**
 * Site console › Memory (KOBE-385; SM8, SM21, SM23): the Site's memories for Site admins and Site
 * memory stewards, with filters, edit, archive, restore, pin, tags, import and export, and the
 * Policy budget. **Proposals** (KOBE-405): what Team admins confirmed for the Site, to approve,
 * merge, reject or send back; `?site_proposal=<id>` (the bell) opens it there. Only Site admins make an item Policy or change one (the `site.memory.policy`
 * guard; the server refuses anyone else). The memory switches stay in Settings.
 *
 * Requests carry the session's active Workspace when there is one (`X-Kobe-Team`, which the
 * server needs on writes then); its switches don't limit curation (they govern what reaches its
 * runs).
 */
export function SiteMemoryPage() {
  const access = useSiteAccess();
  const canSetPolicy = POLICY_ROLES.has(access.siteRole);
  const active = useResource(async () => {
    try {
      const my = await fetchMyTeams();
      return { ok: true as const, status: 200, data: my?.activeTeamId ?? null };
    } catch {
      return { ok: true as const, status: 200, data: null };
    }
  });
  const [generation, setGeneration] = useState(0);
  const [proposal] = useState(() => proposalFromLocation());
  return (
    <>
      <PageHeader title="Memory" />
      <ResourceView state={active.state} label="memory">
        {(activeTeamId) => {
          const teamId = activeTeamId ?? undefined;
          return (
            <Tabs defaultValue={proposal === null ? "memories" : "proposals"}>
              <TabsList label="Memory">
                <TabsTrigger value="memories">Memories</TabsTrigger>
                <TabsTrigger value="proposals">Proposals</TabsTrigger>
                <TabsTrigger value="quality">Quality</TabsTrigger>
                <TabsTrigger value="transfer">Import and export</TabsTrigger>
              </TabsList>
              <TabsContent value="memories">
                <p className="m-0 mb-4 text-console-muted">
                  Knowledge Kobe gives agents in every workspace that has Site memories on. Policy
                  reaches every workspace, always.
                  {canSetPolicy
                    ? " You can make a memory Policy and change Policy."
                    : " Only Site admins make a memory Policy or change Policy."}
                </p>
                <CuratorMemories
                  key={generation}
                  teamId={teamId}
                  scopes={[{ scope: "site", curate: true }]}
                  canSetPolicy={canSetPolicy}
                />
              </TabsContent>
              <TabsContent value="proposals">
                <SiteProposals
                  teamId={teamId}
                  userId={access.user.id}
                  canSetPolicy={canSetPolicy}
                  focusId={proposal}
                  onDecided={() => setGeneration((g) => g + 1)}
                />
              </TabsContent>
              <TabsContent value="quality">
                <MemoryQuality level="site" teamId={teamId} />
              </TabsContent>
              <TabsContent value="transfer">
                <ImportPanel
                  teamId={teamId}
                  scope="site"
                  onImported={() => setGeneration((g) => g + 1)}
                />
                <ExportPanel teamId={teamId} scope="site" />
              </TabsContent>
            </Tabs>
          );
        }}
      </ResourceView>
    </>
  );
}

/** `?site_proposal=<uuid>`: the bell's Open the Site proposal. */
function proposalFromLocation(): string | null {
  const id = new URLSearchParams(window.location.search).get("site_proposal");
  return id !== null && isUuid(id) ? id.toLowerCase() : null;
}
