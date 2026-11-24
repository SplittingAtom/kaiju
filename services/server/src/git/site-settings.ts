import {
  GIT_SITE_ALLOWED_HOSTS_KEY,
  GIT_SITE_ENABLED_KEY,
  readGitSiteSettings,
  siteSettings,
  type KaijuTx,
} from "@kaiju/db";
import { recordAudit } from "../audit/record.js";

/**
 * Stores the Site ceiling for Workspace git (KOBE-757, spec G3) from the Site settings API
 * (`site.settings.manage`): the switch and the host limit (canonical patterns from
 * `gitAllowedHostsSchema`). Each effective change is audited as `site.settings.updated`. The
 * reader and the check every connection goes through (`readGitSiteSettings`, `decideGitHost`) are
 * in `@kaiju/db`.
 */
async function store(tx: KaijuTx, key: string, value: string): Promise<void> {
  await tx
    .insert(siteSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: siteSettings.key, set: { value, updatedAt: new Date() } });
}

export async function storeGitSiteSettings(
  tx: KaijuTx,
  change: { readonly enabled?: boolean; readonly allowedHosts?: readonly string[] },
): Promise<void> {
  const current = await readGitSiteSettings(tx);
  if (change.enabled !== undefined && change.enabled !== current.enabled) {
    await store(tx, GIT_SITE_ENABLED_KEY, String(change.enabled));
    await recordAudit(tx, {
      action: "site.settings.updated",
      target: { setting: "git_connections", value: change.enabled, previous: current.enabled },
    });
  }
  if (change.allowedHosts !== undefined) {
    const hosts = [...change.allowedHosts];
    if (JSON.stringify(hosts) === JSON.stringify(current.allowedHosts)) return;
    await store(tx, GIT_SITE_ALLOWED_HOSTS_KEY, JSON.stringify(hosts));
    await recordAudit(tx, {
      action: "site.settings.updated",
      target: {
        setting: "git_allowed_hosts",
        value: hosts.length,
        hosts,
        previous: current.allowedHosts.length,
        previousHosts: [...current.allowedHosts],
      },
    });
  }
}
