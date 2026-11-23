/**
 * Words for Workspace git connections (KOBE-761, spec workspace-git §3, §4, §7), shared by the Git
 * section, the members' view and the tests. Plain product terms, never wire values.
 */
import type { GitAccessLevel, GitCapabilities, GitProvider, GitVisibility } from "../api/team/git";

/** What the Connect dialog offers: Enterprise Server is provider `github` with its own address. */
export type GitHostChoice = "github" | "github_enterprise" | "gitea" | "forgejo";

export const GIT_HOST_CHOICES: readonly GitHostChoice[] = [
  "github",
  "github_enterprise",
  "gitea",
  "forgejo",
];

export const HOST_CHOICE_LABEL: Readonly<Record<GitHostChoice, string>> = {
  github: "GitHub",
  github_enterprise: "GitHub Enterprise Server",
  gitea: "Gitea",
  forgejo: "Forgejo",
};

export const HOST_CHOICE_HINT: Readonly<Record<GitHostChoice, string>> = {
  github: "An organization on github.com.",
  github_enterprise: "Your own GitHub server, at its web address.",
  gitea: "A Gitea server (1.26 or later), at its web address.",
  forgejo: "A Forgejo server such as Codeberg (15 or later), at its web address.",
};

export const PROVIDER_LABEL: Readonly<Record<GitProvider, string>> = {
  github: "GitHub",
  gitea: "Gitea",
  forgejo: "Forgejo",
};

export const GITHUB_COM = "https://github.com";

export function providerOfChoice(choice: GitHostChoice): GitProvider {
  return choice === "github_enterprise" ? "github" : choice;
}

/** A stored connection's provider and address, as the dialog's choice. */
export function choiceOf(provider: GitProvider, baseUrl: string): GitHostChoice {
  if (provider !== "github") return provider;
  return baseUrl === GITHUB_COM ? "github" : "github_enterprise";
}

/** "GitHub", "GitHub Enterprise Server", "Forgejo"… for a stored connection. */
export function providerName(provider: GitProvider, baseUrl: string): string {
  return HOST_CHOICE_LABEL[choiceOf(provider, baseUrl)];
}

/** The host name of a base URL (`git.example.com`); the URL itself if it does not parse. */
export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

export const ACCESS_LEVELS: readonly GitAccessLevel[] = ["off", "read", "read_write"];

export const ACCESS_LABEL: Readonly<Record<GitAccessLevel, string>> = {
  off: "Off",
  read: "Read",
  read_write: "Read and write",
};

export const ACCESS_HINT: Readonly<Record<GitAccessLevel, string>> = {
  off: "Connected but unused: sandboxes can neither fetch from nor push to the organization.",
  read: "Any member's sandbox may fetch (clone and pull) the organization's repositories.",
  read_write:
    "Sandboxes may also push. Pushing needs the Contributor role and, for a Repo, editor or owner of its project.",
};

export const VISIBILITY_LABEL: Readonly<Record<GitVisibility, string>> = {
  private: "Private",
  internal: "Internal (visible to the organization's members)",
};

export type GitCapabilityName = keyof GitCapabilities;

export const CAPABILITY_LABEL: Readonly<Record<GitCapabilityName, string>> = {
  read: "Read repositories",
  write: "Push and open pull requests and issues",
  create: "Create repositories",
  admin: "Administer the organization or its repositories",
};

export const CAPABILITY_ORDER: readonly GitCapabilityName[] = ["read", "write", "create", "admin"];

export const CAPABILITY_VALUE_LABEL = {
  yes: "Yes",
  no: "No",
  unknown: "Not known until first use",
} as const;

/** Health as words: never colour alone. */
export const HEALTH_LABEL = {
  ok: "Working",
  failing: "Failing",
  unchecked: "Not checked yet",
  not_allowed: "Not allowed by the Site",
} as const;

/** Badge tones per health; the label carries the meaning. */
export const HEALTH_TONE = {
  ok: "running",
  failing: "failed",
  unchecked: "neutral",
  not_allowed: "attention",
} as const;

/** The minimum push size limit input, and the most a Workspace admin may set (10 GiB). */
export const PUSH_LIMIT_MIB = { min: 1, max: 10 * 1024, default: 1024 } as const;
const MIB = 1024 * 1024;

export function mibOf(bytes: number): number {
  return Math.max(1, Math.round(bytes / MIB));
}

export function bytesOf(mib: number): number {
  return mib * MIB;
}
