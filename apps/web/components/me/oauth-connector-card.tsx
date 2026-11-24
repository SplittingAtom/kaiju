"use client";

import {
  browserNavigation,
  isAuthorizationUrl,
  removeGrant,
  startOauthConnect,
  type ConnectorGrant,
} from "../../lib/admin/api/team/connector-grants";
import type { TeamConnector } from "../../lib/admin/api/team/connectors";
import { DateTime } from "../admin/parts";
import type { Mutation } from "../admin/use-resource";
import { Badge, Button, Card, eventTrigger, useConfirm } from "../ui/console";

/** A member's OAuth sign-in for one connector, as My connectors shows it (KOBE-835). */
export type OauthState = "not_connected" | "connected" | "expired";

export function oauthStateOf(grant: ConnectorGrant | null, now: Date = new Date()): OauthState {
  // A grant of another kind (an API key from before the connector moved to OAuth) is no sign-in.
  if (grant === null || (grant.kind !== undefined && grant.kind !== "oauth")) {
    return "not_connected";
  }
  if (grant.expiresAt && new Date(grant.expiresAt).getTime() <= now.getTime()) return "expired";
  return "connected";
}

const STATE_LABEL: Readonly<Record<OauthState, string>> = {
  not_connected: "Not connected",
  connected: "Connected",
  expired: "Sign-in expired",
};

/**
 * Starts the connect flow and sends the browser to the authorization server; errors (422, 429,
 * 502, 503) show the server's own sentence through the shared mutation. False when it did not go.
 */
export async function connectAccount(
  mutation: Mutation,
  teamId: string,
  connectorId: string,
  returnTo: "me" | "site" = "me",
): Promise<boolean> {
  let target: string | null = null;
  const done = await mutation.run(
    () => startOauthConnect(teamId, connectorId, returnTo),
    (url) => {
      target = isAuthorizationUrl(url) ? url : null;
      return target === null ? "The connector's sign-in page could not be opened." : null;
    },
  );
  if (!done || target === null) return false;
  browserNavigation.assign(target);
  return true;
}

/**
 * An OAuth connector on My connectors (KOBE-835): whether the member's own account is connected,
 * with Connect, Reconnect and Disconnect. The tokens never reach the browser; the sign-in happens
 * at the service, and the callback brings the member back here with the result.
 */
export function OauthConnectorCard({
  teamId,
  connector: c,
  grant,
  mutation,
  onChanged,
}: {
  readonly teamId: string;
  readonly connector: TeamConnector;
  readonly grant: ConnectorGrant | null;
  readonly mutation: Mutation;
  readonly onChanged: () => void;
}) {
  const [confirm, confirmDialog] = useConfirm();
  const state = oauthStateOf(grant);

  async function disconnect(trigger: HTMLElement | null) {
    const yes = await confirm(
      {
        title: `Disconnect your account from ${c.name}?`,
        description:
          "Kobe deletes your sign-in for it in this workspace. Your runs can't use it until you connect again.",
        confirmLabel: "Disconnect",
      },
      trigger,
    );
    if (!yes) return;
    const done = await mutation.run(
      () => removeGrant(teamId, c.id),
      () => `Disconnected from ${c.name}.`,
    );
    if (done) onChanged();
  }

  return (
    <Card role="article" aria-label={c.name} title={c.name} level={2}>
      <p className="m-0 flex flex-wrap items-center gap-2 text-sm text-console-muted">
        <Badge
          tone={state === "connected" ? "done" : state === "expired" ? "attention" : "neutral"}
        >
          {STATE_LABEL[state]}
        </Badge>
        {state === "not_connected" ? (
          <span>Sign in with your own account at the service (OAuth). No key to copy.</span>
        ) : state === "expired" ? (
          <span>
            Kobe renews the sign-in by itself when the service allows it. If the connector still
            fails, reconnect.
          </span>
        ) : grant ? (
          <span>
            Since <DateTime value={grant.updatedAt} />
          </span>
        ) : null}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          variant="primary"
          disabled={mutation.pending}
          onClick={() => void connectAccount(mutation, teamId, c.id)}
        >
          {state === "not_connected" ? "Connect" : "Reconnect"}
          <span className="sr-only"> {c.name}</span>
        </Button>
        {state === "not_connected" ? null : (
          <Button
            variant="danger"
            disabled={mutation.pending}
            onClick={(e) => void disconnect(eventTrigger(e))}
          >
            Disconnect<span className="sr-only"> {c.name}</span>
          </Button>
        )}
      </div>
      {confirmDialog}
    </Card>
  );
}
