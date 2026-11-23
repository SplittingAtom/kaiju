import { defineDomain } from "./types.js";

/**
 * Workspace git (KOBE-757..769, spec docs/specs/workspace-git.md §8): a Workspace's connections to
 * git organizations (sealed credential, envelope kind `git-hosts`), the repositories it works
 * with on them, and Convert to repo attempts (KOBE-765). All are team tables; there is no
 * site-wide git table (the Site switch and host limit are `site_settings` keys).
 */
export const git = defineDomain({
  team: ["git_connections", "git_repositories", "git_conversions"],
  siteWide: [],
  grants: {},
  teamReferencing: {},
});
