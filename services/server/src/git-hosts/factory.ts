import type { GitConnectionRecord, GitCredentialSecret } from "@kaiju/db";
import { GitHostError, type GitHostAdapter } from "./adapter.js";
import { createGiteaAdapter } from "./gitea/adapter.js";
import { createGitHubAdapter } from "./github/adapter.js";
import type { GitHostNet } from "./http.js";
import type { GitHostTarget } from "./target.js";

/**
 * The adapter for one stored connection (KOBE-763; GIT-4 and GIT-6 use it too): the provider
 * picks the adapter, the opened credential its mode. The credential is used for this adapter only
 * and never kept by the caller. Throws a {@link GitHostError} when the row and the credential do
 * not fit together (an App on Gitea, an App row without its ids).
 */
export interface GitAdapterInput {
  readonly connection: Pick<
    GitConnectionRecord,
    "provider" | "organization" | "githubAppId" | "githubInstallationId"
  >;
  readonly secret: GitCredentialSecret;
  readonly target: GitHostTarget;
  readonly net: GitHostNet;
}

export function gitHostAdapter(input: GitAdapterInput): GitHostAdapter {
  const { connection, secret, target, net } = input;
  if (connection.provider === "github") {
    if (secret.kind === "access_token") {
      return createGitHubAdapter({
        target,
        organization: connection.organization,
        credential: { kind: "access_token", token: secret.token },
        net,
      });
    }
    if (connection.githubAppId === null || connection.githubInstallationId === null) {
      throw new GitHostError("invalid_request", "The GitHub App connection has no App ids.");
    }
    return createGitHubAdapter({
      target,
      organization: connection.organization,
      credential: {
        kind: "github_app",
        appId: String(connection.githubAppId),
        installationId: String(connection.githubInstallationId),
        privateKeyPem: secret.privateKey,
      },
      net,
    });
  }
  if (secret.kind !== "access_token") {
    throw new GitHostError("invalid_request", "Gitea and Forgejo connections use a token.");
  }
  return createGiteaAdapter({
    provider: connection.provider,
    target,
    organization: connection.organization,
    token: secret.token,
    net,
  });
}
