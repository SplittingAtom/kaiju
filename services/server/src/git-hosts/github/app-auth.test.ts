import { describe, expect, it } from "vitest";
import {
  InstallationTokenCache,
  credentialGroupKey,
  forgetGitHubAppCredential,
  type GitHubAppCredential,
} from "./app-auth.js";

/** KOBE-760: a removed or replaced App credential's cached installation tokens are dropped. */
describe("InstallationTokenCache.forgetGroup", () => {
  const a: GitHubAppCredential = {
    kind: "github_app",
    appId: "1",
    installationId: "2",
    privateKeyPem: "pem-a",
  };
  const b: GitHubAppCredential = { ...a, privateKeyPem: "pem-b" };
  const token = (t: string) => ({ token: t, expiresAt: new Date(Date.now() + 3600_000) });

  it("drops every token and check of one credential and keeps the others", () => {
    const cache = new InstallationTokenCache();
    const now = Date.now();
    cache.set("a1", token("x"), now, credentialGroupKey(a));
    cache.set("a2", token("y"), now, credentialGroupKey(a));
    cache.markVerified("a-check", now, credentialGroupKey(a));
    cache.set("b1", token("z"), now, credentialGroupKey(b));
    forgetGitHubAppCredential(a, cache);
    expect(cache.get("a1", now)).toBeUndefined();
    expect(cache.get("a2", now)).toBeUndefined();
    expect(cache.isVerified("a-check", now)).toBe(false);
    expect(cache.get("b1", now)?.token).toBe("z");
    expect(credentialGroupKey(a)).not.toContain("pem-a");
  });
});
