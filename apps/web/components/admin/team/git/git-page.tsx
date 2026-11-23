"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { consoleHref } from "../../../../lib/admin/nav/registry";
import {
  checkGitConnection,
  isAdminView,
  listGitConnections,
  removeGitConnection,
  type GitAdminConnection,
  type GitConnectionsAnswer,
} from "../../../../lib/admin/api/team/git";
import { gitErrorMessage } from "../../../../lib/admin/git/errors";
import { hostOf } from "../../../../lib/admin/git/labels";
import { Button, EmptyState, Notice, PageHeader, Section, useConfirm } from "../../../ui/console";
import { useTeamAccess } from "../../console-context";
import { ErrorNotice } from "../../error-notice";
import { DateTime } from "../../parts";
import { useResource } from "../../use-resource";
import { CommitEmailSection } from "./commit-email-section";
import { GitConnectionsReadOnly } from "./member-view";
import { ConnectDialog } from "./connect-dialog";
import { ConnectionCard, expired, type CardAction } from "./connection-card";
import { ReplaceCredentialDialog } from "./replace-dialog";
import { SettingsDialog } from "./settings-dialog";

export const GIT_MANAGE = "team.git.manage";

type Open =
  | { readonly dialog: "connect" }
  | { readonly dialog: "settings" | "replace"; readonly id: string }
  | null;

interface Status {
  readonly tone: "success" | "error";
  readonly text: string;
}

/**
 * The Git section of the Workspace admin console (spec workspace-git §7; `/v1/team/git`,
 * KOBE-760): connect a git organization, change its settings, replace its credential, check it
 * and disconnect it. Members without `team.git.manage` see the read-only list instead.
 */
export function TeamGitPage() {
  const access = useTeamAccess();
  const teamId = access.team.id;
  const manager = access.permissions.includes(GIT_MANAGE);
  const { state, reload } = useResource(() => listGitConnections(teamId));

  return (
    <>
      <PageHeader
        title="Git"
        description="Connect this Workspace to an organization on GitHub, GitHub Enterprise Server, Gitea or Forgejo. Agents then work in that organization's repositories through Kobe: the credential is stored encrypted on the server and never enters a sandbox, a browser or a model."
      />
      {state.status === "loading" ? <p role="status">Loading git connections…</p> : null}
      {state.status === "error" ? (
        <>
          <ErrorNotice error={state.error} />
          <Button onClick={reload}>Try again</Button>
        </>
      ) : null}
      {state.status === "ready" ? (
        manager ? (
          <>
            <ManagedConnections teamId={teamId} data={state.data} reload={reload} />
            <CommitEmailSection teamId={teamId} />
          </>
        ) : (
          <>
            <Notice tone="info">
              <p className="m-0">
                Only Workspace admins can connect or change git organizations. This is what your
                agents can reach.
              </p>
            </Notice>
            <GitConnectionsReadOnly data={state.data} />
          </>
        )
      ) : null}
    </>
  );
}

function ManagedConnections({
  teamId,
  data,
  reload,
}: {
  readonly teamId: string;
  readonly data: GitConnectionsAnswer;
  readonly reload: () => void;
}) {
  const access = useTeamAccess();
  const connections = data.connections.filter(isAdminView);
  const [open, setOpen] = useState<Open>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, confirmDialog] = useConfirm();
  const trigger = useRef<HTMLElement | null>(null);
  const connectButton = useRef<HTMLButtonElement>(null);
  const siteOn = data.site.enabled;
  const full = connections.length >= data.limit;
  const canConnect = siteOn && data.envelopeConfigured && !full;
  // The connection the last settings or replace dialog was for: kept after it closes, so the
  // dialog stays mounted while it closes and gives focus back to the button that opened it.
  const [lastId, setLastId] = useState<string | null>(null);
  const current = connections.find((c) => c.id === lastId);
  const expiring = connections.filter((c) => c.credential.expiresSoon);

  async function act(action: CardAction, c: GitAdminConnection, from: HTMLElement | null) {
    trigger.current = from;
    setStatus(null);
    if (action === "settings" || action === "replace") {
      setLastId(c.id);
      setOpen({ dialog: action, id: c.id });
      return;
    }
    if (action === "check") {
      setBusy(true);
      try {
        const res = await checkGitConnection(teamId, c.id);
        if (!res.ok) setStatus({ tone: "error", text: gitErrorMessage(res.error) });
        else if (res.data.error) {
          const e = res.data.error;
          setStatus({
            tone: "error",
            text: `Check failed for ${c.displayName}: ${gitErrorMessage(
              { status: 422, code: e.code, message: e.message },
              e.test,
              { organization: c.organization },
            )}`,
          });
        } else {
          setStatus({ tone: "success", text: `${c.displayName} works: checked just now.` });
        }
        reload();
      } finally {
        setBusy(false);
      }
      return;
    }
    const yes = await confirm(
      {
        title: `Disconnect ${c.displayName}?`,
        description: `Kobe deletes the stored credential and agents lose access to ${c.organization} on ${hostOf(c.baseUrl)}. Nothing on the host is changed: repositories there stay. Sandboxes already working with the organization may keep their access for up to 30 seconds.`,
        confirmLabel: "Disconnect",
      },
      from,
    );
    if (!yes) return;
    setBusy(true);
    try {
      const res = await removeGitConnection(teamId, c.id);
      if (!res.ok) setStatus({ tone: "error", text: gitErrorMessage(res.error) });
      else {
        const kept = res.data.repositoriesKept;
        setStatus({
          tone: "success",
          text: `Disconnected ${c.displayName}.${kept > 0 ? ` ${kept} repository record(s) kept, marked unreachable.` : ""}`,
        });
        reload();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {!siteOn ? (
        <Notice tone="warn" title="Git connections are turned off for this Site">
          <p className="m-0">
            Nothing can be connected, tested or checked, and agents cannot use existing connections
            until a Site admin turns git connections on again. Stored credentials are kept.
          </p>
          {access.siteAdmin ? (
            <p className="m-0 mt-1">
              <Link href={`${consoleHref("site")}/settings#git-connections`}>
                Open Site settings
              </Link>
            </p>
          ) : (
            <p className="m-0 mt-1">Ask a Site admin if you need it.</p>
          )}
        </Notice>
      ) : null}
      {siteOn && !data.envelopeConfigured ? (
        <Notice tone="warn" title="Credentials cannot be stored yet">
          <p className="m-0">
            This Site has no encryption key for stored credentials, so nothing can be connected. Ask
            whoever runs Kobe to configure one.
          </p>
        </Notice>
      ) : null}
      {expiring.map((c) => (
        <Notice
          key={c.id}
          tone="warn"
          title={expired(c) ? "Credential expired" : "Credential expires soon"}
        >
          <p className="m-0">
            The credential of {c.displayName} {expired(c) ? "expired on" : "expires on"}{" "}
            <DateTime value={c.credential.expiresAt} />. Create a new one on the host and use
            Replace credential.
          </p>
        </Notice>
      ))}
      <div role="status">
        {status?.tone === "success" ? <Notice tone="success">{status.text}</Notice> : null}
      </div>
      {status?.tone === "error" ? (
        <Notice tone="error">
          <p className="m-0">{status.text}</p>
        </Notice>
      ) : null}
      <Section
        title="Connections"
        description={`${connections.length} of ${data.limit}. One connection per organization and host.`}
        actions={
          <Button
            ref={connectButton}
            variant="primary"
            disabled={!canConnect}
            onClick={() => {
              setStatus(null);
              setOpen({ dialog: "connect" });
            }}
          >
            Connect a git organization
          </Button>
        }
      >
        {full ? (
          <p className="m-0 mb-2 text-sm text-console-muted">
            This Workspace has {data.limit} connections, the most it can have. Disconnect one to
            connect another.
          </p>
        ) : null}
        {data.site.allowedHosts && data.site.allowedHosts.length > 0 ? (
          <p className="m-0 mb-2 text-sm text-console-muted">
            This Site allows connections to: {data.site.allowedHosts.join(", ")}.
          </p>
        ) : null}
        {connections.length === 0 ? (
          <EmptyState title="No git organization is connected">
            Connect one so agents can create repositories, open pull requests, clone and push, with
            no credential in their sandboxes.
          </EmptyState>
        ) : (
          <div className="flex flex-col gap-3">
            {connections.map((c) => (
              <ConnectionCard
                key={c.id}
                connection={c}
                allowedHosts={data.site.allowedHosts}
                busy={busy}
                onAction={(a, from) => void act(a, c, from)}
              />
            ))}
          </div>
        )}
      </Section>
      <ConnectDialog
        open={open?.dialog === "connect"}
        onOpenChange={(o) => setOpen(o ? { dialog: "connect" } : null)}
        teamId={teamId}
        allowedHosts={data.site.allowedHosts}
        returnFocus={() => connectButton.current}
        onConnected={(saved) => {
          setStatus({
            tone: "success",
            text: `Connected ${saved.connection.displayName}. The credential is stored encrypted and will not be shown again.`,
          });
          reload();
        }}
      />
      {current ? (
        <SettingsDialog
          open={open?.dialog === "settings"}
          onOpenChange={(o) => !o && setOpen(null)}
          teamId={teamId}
          connection={current}
          returnFocus={() => trigger.current}
          onSaved={(saved) => {
            setStatus({ tone: "success", text: `Saved the settings of ${saved.displayName}.` });
            reload();
          }}
        />
      ) : null}
      {current ? (
        <ReplaceCredentialDialog
          open={open?.dialog === "replace"}
          onOpenChange={(o) => !o && setOpen(null)}
          teamId={teamId}
          connection={current}
          returnFocus={() => trigger.current}
          onReplaced={(saved) => {
            setStatus({
              tone: "success",
              text: `Replaced the credential of ${saved.connection.displayName}. The old one is discarded.`,
            });
            reload();
          }}
        />
      ) : null}
      {confirmDialog}
    </>
  );
}
