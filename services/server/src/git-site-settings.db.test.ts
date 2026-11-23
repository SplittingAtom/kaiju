import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  GIT_SITE_ALLOWED_HOSTS_KEY,
  GIT_SITE_ENABLED_KEY,
  decideGitHost,
  readGitSiteSettings,
} from "@kobe/db";
import { KobeMcpHarness } from "./testing/kobe-mcp-harness.js";

/**
 * KOBE-757 (Workspace git G3): the Site switch and host limit through the Site settings API,
 * validated and audited on the server, and read back by the check every connection goes through.
 */
const h = new KobeMcpHarness();

beforeAll(() => h.setup(), 120_000);
afterAll(() => h.teardown());
beforeEach(() => h.reset());

describe("Site settings: Workspace git ceiling (KOBE-757)", () => {
  it("defaults to on with any host, validates, audits each change once, applies at once", async () => {
    const w = await h.world();
    await h.setSite(GIT_SITE_ENABLED_KEY, null);
    await h.setSite(GIT_SITE_ALLOWED_HOSTS_KEY, null);
    await h.fx.admin.query(
      `INSERT INTO site_roles (user_id, role) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`,
      [w.admin.id],
    );
    const before = await w.admin.browser.get("/v1/site/settings");
    expect(before.json).toMatchObject({ gitConnectionsEnabled: true, gitAllowedHosts: [] });

    const put = await w.admin.browser.put("/v1/site/settings", {
      gitConnectionsEnabled: false,
      gitAllowedHosts: ["GitHub.com", "*.example.com", "github.com"],
    });
    expect(put.status, JSON.stringify(put.json)).toBe(200);
    expect(put.json).toMatchObject({
      gitConnectionsEnabled: false,
      gitAllowedHosts: ["*.example.com", "github.com"],
    });

    const db = h.fx.replica(0).deps.database.db;
    const settings = await readGitSiteSettings(db);
    expect(decideGitHost(settings, "https://github.com")).toMatchObject({ code: "git_disabled" });
    await w.admin.browser.put("/v1/site/settings", { gitConnectionsEnabled: true });
    const on = await readGitSiteSettings(db);
    expect(decideGitHost(on, "https://github.com").ok).toBe(true);
    expect(decideGitHost(on, "https://git.example.com/forgejo").ok).toBe(true);
    expect(decideGitHost(on, "https://gitlab.com")).toMatchObject({ code: "host_not_allowed" });

    for (const bad of [
      { gitAllowedHosts: ["10.0.0.1"] },
      { gitAllowedHosts: ["https://github.com"] },
      { gitAllowedHosts: "github.com" },
      { gitConnectionsEnabled: "yes" },
    ]) {
      const res = await w.admin.browser.put("/v1/site/settings", bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect(
      (await w.member.browser.put("/v1/site/settings", { gitConnectionsEnabled: false })).status,
    ).toBe(403);

    // Unchanged values write no second event.
    await w.admin.browser.put("/v1/site/settings", {
      gitAllowedHosts: ["github.com", "*.example.com"],
    });
    const { rows } = await h.fx.admin.query<{ target: Record<string, unknown> }>(
      `SELECT target FROM audit_log WHERE action = 'site.settings.updated'
        AND target ->> 'setting' IN ('git_connections', 'git_allowed_hosts') ORDER BY seq`,
    );
    expect(rows.map((r) => r.target)).toEqual([
      { setting: "git_connections", value: false, previous: true },
      {
        setting: "git_allowed_hosts",
        value: 2,
        hosts: ["*.example.com", "github.com"],
        previous: 0,
        previousHosts: [],
      },
      { setting: "git_connections", value: true, previous: false },
    ]);
  });
});
