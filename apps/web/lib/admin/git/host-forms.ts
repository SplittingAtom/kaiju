/**
 * Where on the git host the admin creates the credential (spec G5-G7: "a link to the host's
 * form"), and the exact permissions or scopes to choose there (KOBE-758 and KOBE-759 ledgers:
 * what the adapters need, nothing more). Links open the host's own page; nothing is pre-filled
 * with anything secret.
 */
import type { GitProvider } from "../api/team/git";

const ORG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The host's page for a new GitHub App (in the organization when it is known). */
export function githubAppFormUrl(webBase: string, organization: string): string {
  return ORG.test(organization)
    ? `${webBase}/organizations/${organization}/settings/apps/new`
    : `${webBase}/settings/apps/new`;
}

/** The host's page for a new fine-grained personal access token. */
export function githubTokenFormUrl(webBase: string): string {
  return `${webBase}/settings/personal-access-tokens/new`;
}

/** Gitea's and Forgejo's token page (Settings › Applications of the signed-in account). */
export function giteaTokenFormUrl(webBase: string): string {
  return `${webBase}/user/settings/applications`;
}

export interface PermissionRow {
  readonly name: string;
  readonly level: string;
  readonly why: string;
}

/** GitHub App repository permissions; no organization or account permissions (KOBE-758). */
export const GITHUB_PERMISSIONS: readonly PermissionRow[] = [
  { name: "Metadata", level: "Read", why: "Required by GitHub; listing and reading repositories." },
  { name: "Contents", level: "Read and write", why: "Clone and fetch (read), push (write)." },
  { name: "Pull requests", level: "Read and write", why: "Open pull requests and comment." },
  { name: "Issues", level: "Read and write", why: "Create issues and comment." },
  {
    name: "Administration",
    level: "Read and write",
    why: "Only if agents may create repositories. GitHub requires it for that; it would also allow deleting repositories, which Kaiju never does.",
  },
];

/** Gitea and Forgejo token scopes for the bot account (KOBE-759). */
export const GITEA_SCOPES: readonly PermissionRow[] = [
  { name: "read:user", level: "", why: "The bot account's own name." },
  {
    name: "read:organization",
    level: "",
    why: "The organization, its repositories and the bot's role.",
  },
  {
    name: "write:organization",
    level: "",
    why: "Only if agents may create repositories.",
  },
  {
    name: "write:repository",
    level: "",
    why: "Read and push repositories, open pull requests.",
  },
  { name: "write:issue", level: "", why: "Create issues and comment, also on pull requests." },
];

/** Oldest versions the adapter accepts (KOBE-759 `gitea/version.ts`). */
export const MINIMUM_VERSION: Readonly<Record<Exclude<GitProvider, "github">, string>> = {
  gitea: "1.26.0",
  forgejo: "15.0.0",
};
