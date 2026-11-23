import { defineDomain } from "./types.js";

/**
 * Workspace git (KOBE-757..769, spec docs/specs/workspace-git.md §8): a Workspace's connections to
 * git organizations (sealed credential, envelope kind `git-hosts`), the repositories it works
 * with on them, Convert to repo attempts (KOBE-765), and members' pull-request branches and Repo working copies (KOBE-767). All are team tables; there is no
 * site-wide git table (the Site switch and host limit are `site_settings` keys).
 */
export const git = defineDomain({
  team: [
    "git_connections",
    "git_repositories",
    "git_conversions",
    "git_commit_branches",
    "git_working_copies",
  ],
  siteWide: [],
  grants: {},
  teamReferencing: {},
});
