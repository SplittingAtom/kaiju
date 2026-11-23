"use client";

import { GitBranchIcon } from "lucide-react";
import { listGitConnections, type GitConnectionsAnswer } from "../../../../lib/admin/api/team/git";
import {
  ACCESS_LABEL,
  HEALTH_LABEL,
  HEALTH_TONE,
  hostOf,
  providerName,
} from "../../../../lib/admin/git/labels";
import { Badge, EmptyState, Notice, Section } from "../../../ui/console";
import { ErrorNotice } from "../../error-notice";
import { useResource } from "../../use-resource";

/**
 * Which git organizations the Workspace is connected to, read-only (spec §7: members see what
 * their agents can reach). Host, organization, access level and whether it works; no settings and
 * nothing about the credential.
 */
export function GitConnectionsReadOnly({ data }: { readonly data: GitConnectionsAnswer }) {
  if (data.connections.length === 0) {
    return (
      <EmptyState title="This Workspace is not connected to a git organization">
        Workspace admins connect one in the Workspace admin console&apos;s Git section.
      </EmptyState>
    );
  }
  return (
    <>
      {!data.site.enabled ? (
        <Notice tone="warn" role="none">
          <p className="m-0">
            Git connections are turned off for this Site, so agents cannot use them for now.
          </p>
        </Notice>
      ) : null}
      <ul aria-label="Git organizations" className="m-0 flex list-none flex-col gap-2 p-0">
        {data.connections.map((c) => {
          const status = "status" in c ? c.status : c.health.status;
          return (
            <li
              key={c.id}
              aria-label={c.displayName}
              className="kobe-panel box-border flex flex-wrap items-center gap-2 rounded-lg border border-console-border bg-console-bg p-3"
            >
              <GitBranchIcon aria-hidden className="size-4 shrink-0 text-console-muted" />
              <span className="font-medium">{c.displayName}</span>
              <span className="text-sm text-console-muted">
                <code>{c.organization}</code> on {providerName(c.provider, c.baseUrl)} (
                <code>{hostOf(c.baseUrl)}</code>)
              </span>
              <Badge tone={c.accessLevel === "off" ? "neutral" : "accent"}>
                {c.accessLevel === "off" ? "Not in use" : ACCESS_LABEL[c.accessLevel]}
              </Badge>
              <Badge tone={HEALTH_TONE[status]}>{HEALTH_LABEL[status]}</Badge>
            </li>
          );
        })}
      </ul>
      <p className="m-0 mt-2 text-sm text-console-muted">
        With Read, your sandbox can fetch (clone and pull) repositories there; with Read and write
        it can also push, if your role is Contributor or above (and, for a Repo, you are an editor
        or owner of its project). A connection limited to chosen agents is not available to git in
        sandboxes. The credential never enters your sandbox.
      </p>
    </>
  );
}

/** The members' section on My connector keys (spec §7), loading the list itself. */
export function MyGitConnections({ teamId }: { readonly teamId: string }) {
  const { state } = useResource(() => listGitConnections(teamId));
  return (
    <Section
      title="Git organizations"
      description="Where this Workspace's agents can work with repositories. Set up by Workspace admins; nothing to do here."
    >
      {state.status === "loading" ? <p role="status">Loading git organizations…</p> : null}
      {state.status === "error" ? <ErrorNotice error={state.error} /> : null}
      {state.status === "ready" ? <GitConnectionsReadOnly data={state.data} /> : null}
    </Section>
  );
}
