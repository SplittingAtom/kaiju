"use client";

import { listGrants } from "../../../lib/admin/api/team/connector-grants";
import type {
  Connector,
  ConnectorTeamUse,
  ReprobeOutcome,
} from "../../../lib/admin/api/site/connectors";
import type { OauthReturn } from "../../../lib/connectors/oauth-return";
import { fetchMyTeams } from "../../../lib/teams";
import { connectAccount, oauthStateOf } from "../../me/oauth-connector-card";
import { Badge, Button, Section } from "../../ui/console";
import { MutationStatus } from "../error-notice";
import { OauthReturnNotice } from "../oauth-return";
import { ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";
import { ReprobeButton } from "./connector-reprobe";

/**
 * "Your account" for an OAuth connector in the Site console (KOBE-835): Kaiju lists and pins an
 * OAuth server's tools with a site admin's own connected account (KOBE-784), so a new connector
 * that nobody connected has no tools. The admin connects here (the same per-member flow, coming
 * back to the registry), then Re-probes, which pins the tools with that account. The sign-in is
 * kept in the admin's active workspace, which must have enabled the connector.
 */
interface Mine {
  readonly teamId: string | null;
  readonly teamName: string | null;
  readonly connected: "not_connected" | "connected" | "expired";
}

async function loadMine(connectorId: string) {
  let my;
  try {
    my = await fetchMyTeams();
  } catch {
    my = null;
  }
  const teamId = my?.activeTeamId ?? null;
  const teamName = my?.teams.find((t) => t.id === teamId)?.name ?? null;
  if (teamId === null) {
    const none: Mine = { teamId, teamName, connected: "not_connected" };
    return { ok: true as const, status: 200, data: none };
  }
  const grants = await listGrants(teamId);
  if (!grants.ok) return grants;
  const grant = grants.data.find((g) => g.connectorId === connectorId) ?? null;
  return {
    ok: true as const,
    status: 200,
    data: { teamId, teamName, connected: oauthStateOf(grant) } satisfies Mine,
  };
}

function Explanation({ connector: c }: { readonly connector: Connector }) {
  if (c.toolCount > 0 || c.driftedCount > 0) {
    return (
      <p className="m-0 text-sm text-console-muted">
        Kaiju checks this connector for changed tools with the connected account of the site admin
        who last pinned or approved them. Connect yours to check it with your account.
      </p>
    );
  }
  return (
    <p className="m-0 text-sm">
      <Badge tone="attention">No tools yet</Badge> Kaiju lists an OAuth server&apos;s tools with a
      site admin&apos;s own connected account, and none was used yet. Connect your account, then
      press Re-probe to list and pin its tools.
    </p>
  );
}

export function OauthConnectSection({
  connector: c,
  teams,
  returned,
  onReprobed,
}: {
  readonly connector: Connector;
  /** The teams that enabled it (null while they load). */
  readonly teams: readonly ConnectorTeamUse[] | null;
  /** The sign-in result for this connector, when the admin just came back from it. */
  readonly returned: OauthReturn | null;
  readonly onReprobed: (connector: Connector, outcome: ReprobeOutcome) => void;
}) {
  const { state } = useResource(() => loadMine(c.id));
  const mutation = useMutation();
  return (
    <Section level={3} title="Your account" className="mt-4">
      {returned !== null ? <OauthReturnNotice result={returned} name={c.name} /> : null}
      <Explanation connector={c} />
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="your account">
        {(mine: Mine) => {
          const enabledHere =
            mine.teamId !== null && (teams ?? []).some((t) => t.id === mine.teamId);
          const blocked =
            mine.teamId === null
              ? "Choose a workspace with the workspace switcher first: Kaiju keeps your sign-in in your active workspace."
              : teams !== null && !enabledHere
                ? `Kaiju keeps your sign-in in your active workspace, ${mine.teamName ?? "this one"}, which has not enabled ${c.name}. Enable it there (Team console, Connectors) or switch to a workspace that has, then connect.`
                : null;
          return (
            <>
              <p className="m-0 mt-2 flex flex-wrap items-center gap-2 text-sm">
                <Badge tone={mine.connected === "connected" ? "done" : "neutral"}>
                  {mine.connected === "connected"
                    ? "Connected"
                    : mine.connected === "expired"
                      ? "Sign-in expired, reconnect"
                      : "Not connected"}
                </Badge>
                {mine.teamName !== null ? (
                  <span className="text-console-muted">In {mine.teamName}</span>
                ) : null}
              </p>
              {blocked !== null ? <p className="m-0 mt-2 text-sm">{blocked}</p> : null}
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant={mine.connected === "not_connected" ? "primary" : "secondary"}
                  disabled={mutation.pending || blocked !== null || mine.teamId === null}
                  onClick={() =>
                    mine.teamId === null
                      ? undefined
                      : void connectAccount(mutation, mine.teamId, c.id, "site")
                  }
                >
                  {mine.connected === "not_connected"
                    ? "Connect your account"
                    : "Reconnect your account"}
                  <span className="sr-only"> to {c.name}</span>
                </Button>
                <ReprobeButton connector={c} mutation={mutation} onDone={onReprobed} />
              </div>
            </>
          );
        }}
      </ResourceView>
    </Section>
  );
}
