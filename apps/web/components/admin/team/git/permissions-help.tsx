"use client";

import type { GitCredentialKind, GitProvider } from "../../../../lib/admin/api/team/git";
import {
  GITEA_SCOPES,
  GITHUB_PERMISSIONS,
  MINIMUM_VERSION,
  giteaTokenFormUrl,
  githubAppFormUrl,
  githubTokenFormUrl,
  type PermissionRow,
} from "../../../../lib/admin/git/host-forms";
import { PROVIDER_LABEL } from "../../../../lib/admin/git/labels";

/** An external link to the host's own form; opens in a new tab and says so. */
function HostLink({ href, children }: { readonly href: string; readonly children: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

function Rows({
  rows,
  caption,
}: {
  readonly rows: readonly PermissionRow[];
  readonly caption: string;
}) {
  return (
    <ul aria-label={caption} className="m-0 my-1 flex list-disc flex-col gap-0.5 ps-5 text-sm">
      {rows.map((r) => (
        <li key={r.name}>
          <strong>{r.level ? `${r.name}: ${r.level}` : <code>{r.name}</code>}</strong> — {r.why}
        </li>
      ))}
    </ul>
  );
}

/**
 * The exact minimum the credential needs on the host (spec G5-G7; KOBE-758/759 ledgers), with a
 * link to the host's form. Shown beside the credential fields in the Connect and Replace dialogs.
 */
export function PermissionsHelp({
  provider,
  kind,
  webBase,
  organization,
}: {
  readonly provider: GitProvider;
  readonly kind: GitCredentialKind;
  readonly webBase: string | null;
  readonly organization: string;
}) {
  if (provider !== "github") {
    const label = PROVIDER_LABEL[provider];
    return (
      <div className="text-sm" data-testid="git-permissions-help">
        <p className="m-0">
          Create a bot account that is a member of only this organization, sign in as it and create
          an access token
          {webBase ? (
            <>
              {" "}
              under <HostLink href={giteaTokenFormUrl(webBase)}>Settings › Applications</HostLink>
            </>
          ) : null}{" "}
          with these scopes:
        </p>
        <Rows rows={GITEA_SCOPES} caption={`${label} token scopes`} />
        <p className="m-0 text-console-muted">
          The token is the whole grant: Kobe cannot narrow it, and actions appear as the bot
          account. Kobe supports {label} {MINIMUM_VERSION[provider]} and later.
        </p>
      </div>
    );
  }
  if (kind === "github_app") {
    return (
      <div className="text-sm" data-testid="git-permissions-help">
        <p className="m-0">
          Create a GitHub App in the organization
          {webBase ? (
            <>
              {" "}
              (<HostLink href={githubAppFormUrl(webBase, organization)}>New GitHub App</HostLink>)
            </>
          ) : null}{" "}
          with these repository permissions and no organization or account permissions:
        </p>
        <Rows rows={GITHUB_PERMISSIONS} caption="GitHub App permissions" />
        <p className="m-0 text-console-muted">
          At Read, Read is enough for Contents, Pull requests and Issues, and Administration is not
          needed. Install the App on the organization (all repositories when agents create
          repositories), generate a private key, and copy the App ID and the installation ID (the
          number at the end of the installation&apos;s settings address). Kobe mints a one-hour
          token per use, limited to the repository and permissions that use needs; actions appear as
          the App&apos;s bot.
        </p>
      </div>
    );
  }
  return (
    <div className="text-sm" data-testid="git-permissions-help">
      <p className="m-0">
        Create a fine-grained personal access token
        {webBase ? (
          <>
            {" "}
            (<HostLink href={githubTokenFormUrl(webBase)}>New fine-grained token</HostLink>)
          </>
        ) : null}{" "}
        with the organization as resource owner (an organization owner may have to approve it),
        access to all repositories (or the ones agents may use), an expiry date, and these
        repository permissions and no organization permissions:
      </p>
      <Rows rows={GITHUB_PERMISSIONS} caption="Fine-grained token permissions" />
      <p className="m-0 text-console-muted">
        The token is the whole grant: Kobe cannot narrow it per use, and actions appear as the
        token&apos;s owner. Kobe shows the expiry and emails Workspace admins 14 days before it. A
        classic token works but is flagged for its extra scopes.
      </p>
    </div>
  );
}
