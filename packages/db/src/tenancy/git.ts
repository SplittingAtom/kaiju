import { defineDomain } from "./types.js";

/**
 * Workspace git (KOBE-757..769, spec docs/specs/workspace-git.md §8): a Workspace's connections to
 * git organizations (sealed credential, envelope kind `git-hosts`) and the repositories it works
 * with on them. Both are team tables; there is no site-wide git table (the Site switch and host
 * limit are `site_settings` keys).
 */
export const git = defineDomain({
  team: ["git_connections", "git_repositories"],
  siteWide: [],
  grants: {},
  teamReferencing: {},
});
