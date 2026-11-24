import type { GitCredentialSecret, GitProvider, GitSiteSettings } from "@kaiju/db";
import type { GitHostAdapter } from "../git-hosts/adapter.js";
import { createGiteaAdapter } from "../git-hosts/gitea/adapter.js";
import { createGitHubAdapter } from "../git-hosts/github/adapter.js";
import {
  forgetGitHubAppCredential,
  type GitHubAppCredential,
  type InstallationTokenCache,
} from "../git-hosts/github/app-auth.js";
import type { GitHostNet } from "../git-hosts/http.js";
import { gitHostTarget } from "../git-hosts/target.js";

/**
 * Builds the provider adapter for one connection and one operation (KOBE-760): a fresh Site
 * decision (`gitHostTarget()`, G3) from the settings read for this operation, then the adapter with
 * the credential the caller opened (or was just given). Nothing is cached here but the GitHub
 * App's in-memory installation tokens, which {@link forgetGitCredential} drops when a credential
 * is removed or replaced.
 */
export interface GitConnectionSubject {
  readonly provider: GitProvider;
  readonly baseUrl: string;
  readonly organization: string;
  /** GitHub App ids (G5), stored in clear; null for a token. */
  readonly githubAppId: number | null;
  readonly githubInstallationId: number | null;
}

export interface GitAdapterOptions {
  readonly tokenCache?: InstallationTokenCache;
  readonly now?: () => number;
}

function appCredential(subject: GitConnectionSubject, privateKey: string): GitHubAppCredential {
  return {
    kind: "github_app",
    appId: String(subject.githubAppId ?? ""),
    installationId: String(subject.githubInstallationId ?? ""),
    privateKeyPem: privateKey,
  };
}

/** Throws a `GitHostError` when the Site refuses the host or the input is not valid. */
export function gitAdapterFor(
  settings: GitSiteSettings,
  net: GitHostNet,
  subject: GitConnectionSubject,
  secret: GitCredentialSecret,
  options: GitAdapterOptions = {},
): GitHostAdapter {
  const target = gitHostTarget(settings, subject.baseUrl, { allowHttp: net.policy.allowHttp });
  const common = {
    target,
    organization: subject.organization,
    net,
    ...(options.now ? { now: options.now } : {}),
  };
  if (subject.provider === "github") {
    return createGitHubAdapter({
      ...common,
      credential:
        secret.kind === "github_app"
          ? appCredential(subject, secret.privateKey)
          : { kind: "access_token", token: secret.token },
      ...(options.tokenCache ? { tokenCache: options.tokenCache } : {}),
    });
  }
  if (secret.kind !== "access_token") {
    // The table's CHECK and the route schema refuse this too (G7: no apps on Gitea or Forgejo).
    throw new TypeError("Gitea and Forgejo connections use an access token");
  }
  return createGiteaAdapter({ ...common, provider: subject.provider, token: secret.token });
}

/** Drops cached installation tokens of a GitHub App credential (nothing to do for a token). */
export function forgetGitCredential(
  subject: GitConnectionSubject,
  secret: GitCredentialSecret,
  cache?: InstallationTokenCache,
): void {
  if (secret.kind !== "github_app") return;
  forgetGitHubAppCredential(appCredential(subject, secret.privateKey), cache);
}
