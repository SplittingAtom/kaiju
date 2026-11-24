"use client";

import { GitBranchIcon } from "lucide-react";
import type { GitAdminConnection } from "../../../../lib/admin/api/team/git";
import { hostAllowed } from "../../../../lib/admin/git/address";
import { healthMessage } from "../../../../lib/admin/git/errors";
import {
  ACCESS_LABEL,
  HEALTH_LABEL,
  HEALTH_TONE,
  hostOf,
  providerName,
} from "../../../../lib/admin/git/labels";
import { Badge, Button, Card, Notice, eventTrigger } from "../../../ui/console";
import { DateTime } from "../../parts";
import { CapabilityList } from "./test-report";

export type CardAction = "settings" | "replace" | "check" | "disconnect";

/** Whether the credential's expiry has passed. */
export function expired(c: GitAdminConnection, now: number = Date.now()): boolean {
  const at = c.credential.expiresAt;
  return at !== null && new Date(at).getTime() <= now;
}

/** One connection as a Workspace admin sees it (spec §7): host, credential, level, health. */
export function ConnectionCard({
  connection: c,
  allowedHosts,
  busy,
  onAction,
}: {
  readonly connection: GitAdminConnection;
  readonly allowedHosts: readonly string[] | undefined;
  readonly busy: boolean;
  readonly onAction: (action: CardAction, trigger: HTMLElement | null) => void;
}) {
  const host = hostOf(c.baseUrl);
  const health = c.health.status;
  const blocked = !hostAllowed(allowedHosts, host.replace(/:\d+$/, ""));
  return (
    <Card role="article" aria-label={c.displayName}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <GitBranchIcon aria-hidden className="size-5 shrink-0 text-console-muted" />
        <h3 className="m-0 text-base font-semibold">{c.displayName}</h3>
        <Badge tone={c.accessLevel === "off" ? "neutral" : "accent"}>
          {ACCESS_LABEL[c.accessLevel]}
        </Badge>
        <Badge tone={HEALTH_TONE[health]}>{HEALTH_LABEL[health]}</Badge>
        {c.credential.expiresSoon ? (
          <Badge tone="attention">{expired(c) ? "Credential expired" : "Expires soon"}</Badge>
        ) : null}
      </div>
      {health === "not_allowed" || blocked ? (
        <Notice tone="warn" role="none">
          <p className="m-0">
            {c.health.lastError?.endsWith("site_git_off")
              ? "Git connections are turned off for this Site: agents cannot use this connection, and Kaiju sends nothing to the host, until a Site admin turns them on again in the Site console's Settings."
              : `The Site does not allow git connections to ${host} any more: agents cannot use this connection, and Kaiju sends nothing to the host. Ask a Site admin to add the host to the Site's allowed git hosts, or disconnect it.`}
          </p>
        </Notice>
      ) : null}
      {health === "failing" ? (
        <Notice tone="error" role="none">
          <p className="m-0">
            {healthMessage(c.health.lastError)} Check the credential on the host, then use Check now
            or Replace credential.
          </p>
        </Notice>
      ) : null}
      <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-console-muted">Provider</dt>
        <dd className="m-0">{providerName(c.provider, c.baseUrl)}</dd>
        <dt className="text-console-muted">Host</dt>
        <dd className="m-0">
          <code>{host}</code>
        </dd>
        <dt className="text-console-muted">Organization</dt>
        <dd className="m-0">
          <code>{c.organization}</code>
        </dd>
        <dt className="text-console-muted">Credential</dt>
        <dd className="m-0">
          {c.credential.kind === "github_app"
            ? `GitHub App ${c.credential.githubAppId ?? ""}, installation ${c.credential.githubInstallationId ?? ""}`
            : `Access token ${c.credential.hint ?? ""}`}
          <span className="text-console-muted">
            {" "}
            (updated <DateTime value={c.credential.updatedAt} />)
          </span>
        </dd>
        <dt className="text-console-muted">Expires</dt>
        <dd className="m-0">
          {c.credential.expiresAt ? (
            <DateTime value={c.credential.expiresAt} />
          ) : c.credential.kind === "github_app" ? (
            "Never (one-hour tokens are minted per use)"
          ) : (
            "No expiry reported"
          )}
        </dd>
        <dt className="text-console-muted">Last checked</dt>
        <dd className="m-0">
          {c.health.lastCheckedAt ? <DateTime value={c.health.lastCheckedAt} /> : "Never"}
          {c.health.lastOkAt && health === "failing" ? (
            <span className="text-console-muted">
              {" "}
              (last worked <DateTime value={c.health.lastOkAt} />)
            </span>
          ) : null}
        </dd>
      </dl>
      <div className="mt-2">
        <CapabilityList
          capabilities={c.capabilities}
          label={`What the credential of ${c.displayName} may do`}
        />
        {c.excessPermissions.length > 0 ? (
          <p className="m-0 mt-1 text-sm text-console-muted">
            More than Kaiju needs: {c.excessPermissions.join(", ")}.
          </p>
        ) : null}
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {(
          [
            ["settings", "Settings"],
            ["replace", "Replace credential"],
            ["check", "Check now"],
          ] as const
        ).map(([action, label]) => (
          <Button
            key={action}
            size="sm"
            disabled={busy}
            onClick={(e) => onAction(action, eventTrigger(e))}
          >
            {label}
            <span className="sr-only"> for {c.displayName}</span>
          </Button>
        ))}
        <Button
          size="sm"
          variant="danger"
          disabled={busy}
          onClick={(e) => onAction("disconnect", eventTrigger(e))}
        >
          Disconnect<span className="sr-only"> {c.displayName}</span>
        </Button>
      </div>
    </Card>
  );
}
