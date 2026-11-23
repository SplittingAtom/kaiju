import { describe, expect, it } from "vitest";
import {
  GIT_SITE_ALLOWED_HOSTS_KEY,
  GIT_SITE_ENABLED_KEY,
  decideGitHost,
  gitAllowedHostsSchema,
  parseGitBaseUrl,
  parseGitSiteSettings,
} from "./site-settings.js";

describe("git base URL (KOBE-757, G1)", () => {
  it.each([
    ["https://github.com", "https://github.com"],
    ["https://GitHub.com/", "https://github.com"],
    ["  https://git.example.com:8443/forgejo/ ", "https://git.example.com:8443/forgejo"],
    ["https://codeberg.org", "https://codeberg.org"],
  ])("canonicalizes %s", (raw, expected) => {
    expect(parseGitBaseUrl(raw)).toMatchObject({ ok: true, baseUrl: expected });
  });

  it.each([
    "http://github.com",
    "https://user:pw@github.com",
    "https://github.com/?x=1",
    "https://github.com/#a",
    "https://10.0.0.1",
    "https://[::1]",
    "ssh://git@github.com",
    "github.com",
    "",
  ])("refuses %s", (raw) => {
    expect(parseGitBaseUrl(raw).ok).toBe(false);
  });
});

describe("git Site ceiling (G3)", () => {
  it("defaults to on with any host", () => {
    expect(parseGitSiteSettings(new Map())).toEqual({ enabled: true, allowedHosts: [] });
  });

  it("parses stored rows; an unreadable host list allows nothing", () => {
    const rows = new Map([
      [GIT_SITE_ENABLED_KEY, "false"],
      [GIT_SITE_ALLOWED_HOSTS_KEY, '["github.com","*.example.com"]'],
    ]);
    expect(parseGitSiteSettings(rows)).toEqual({
      enabled: false,
      allowedHosts: ["*.example.com", "github.com"],
    });
    const broken = parseGitSiteSettings(new Map([[GIT_SITE_ALLOWED_HOSTS_KEY, "{"]]));
    expect(decideGitHost(broken, "https://github.com")).toMatchObject({
      ok: false,
      code: "host_not_allowed",
    });
  });

  it("refuses everything while the switch is off", () => {
    expect(decideGitHost({ enabled: false, allowedHosts: [] }, "https://github.com")).toMatchObject(
      { ok: false, code: "git_disabled" },
    );
  });

  it("limits hosts by exact name or subdomain pattern", () => {
    const s = { enabled: true, allowedHosts: ["github.com", "*.example.com"] };
    expect(decideGitHost(s, "https://GITHUB.com/")).toEqual({
      ok: true,
      baseUrl: "https://github.com",
      host: "github.com",
    });
    expect(decideGitHost(s, "https://git.example.com/forgejo").ok).toBe(true);
    expect(decideGitHost(s, "https://example.com")).toMatchObject({ code: "host_not_allowed" });
    expect(decideGitHost(s, "https://evilgithub.com")).toMatchObject({ code: "host_not_allowed" });
    expect(decideGitHost(s, "http://github.com")).toMatchObject({ code: "invalid_base_url" });
  });

  it("validates an admin's host list: canonical, unique, sorted; no IPs, schemes or paths", () => {
    expect(gitAllowedHostsSchema.parse(["GitHub.com", "github.com", "*.example.com"])).toEqual([
      "*.example.com",
      "github.com",
    ]);
    for (const bad of [["10.0.0.1"], ["https://github.com"], ["github.com/acme"], ["*.com"]]) {
      expect(gitAllowedHostsSchema.safeParse(bad).success).toBe(false);
    }
    expect(
      gitAllowedHostsSchema.safeParse(Array.from({ length: 51 }, (_, i) => `h${i}.example.com`))
        .success,
    ).toBe(false);
  });
});
