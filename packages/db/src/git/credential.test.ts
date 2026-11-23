import { describe, expect, it } from "vitest";
import { Envelope } from "../envelope/envelope.js";
import {
  GIT_CREDENTIAL_ENVELOPE_KIND,
  GitCredentialError,
  gitCredentialContext,
  gitCredentialHint,
  openGitCredential,
  rewrapGitCredential,
  sealGitCredential,
} from "./credential.js";

const KEY = "k".repeat(40);
const ref = { teamId: "11111111-1111-4111-8111-111111111111", connectionId: "c-1" };
const token = { kind: "access_token", token: "github_pat_11ABCDEFG0123456789" } as const;
const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIVATE KEY-----\n";

describe("git credential sealing (KOBE-757, G8)", () => {
  it("uses its own envelope kind, bound to the Workspace and connection", () => {
    expect(gitCredentialContext(ref)).toEqual({
      teamId: ref.teamId,
      kind: GIT_CREDENTIAL_ENVELOPE_KIND,
      recordId: "c-1",
    });
    expect(GIT_CREDENTIAL_ENVELOPE_KIND).toBe("git-hosts");
  });

  it("round-trips both credential kinds without the plaintext in the sealed text", () => {
    const env = new Envelope(KEY);
    const sealed = sealGitCredential(env, ref, token);
    expect(sealed.credentialSealed.startsWith("e1.")).toBe(true);
    expect(sealed.credentialSealed).not.toContain("github_pat");
    expect(sealed.credentialKeyId).toBe(env.currentKeyId);
    expect(openGitCredential(env, ref, sealed.credentialSealed, "access_token")).toEqual(token);
    const app = sealGitCredential(env, ref, { kind: "github_app", privateKey: PEM });
    expect(openGitCredential(env, ref, app.credentialSealed, "github_app")).toEqual({
      kind: "github_app",
      privateKey: PEM,
    });
  });

  it("does not open for another connection, Workspace, kind of secret or credential kind", () => {
    const env = new Envelope(KEY);
    const { credentialSealed } = sealGitCredential(env, ref, token);
    const fail = (f: () => unknown) => expect(f).toThrow(GitCredentialError);
    fail(() =>
      openGitCredential(env, { ...ref, connectionId: "c-2" }, credentialSealed, "access_token"),
    );
    fail(() =>
      openGitCredential(
        env,
        { ...ref, teamId: "22222222-2222-4222-8222-222222222222" },
        credentialSealed,
        "access_token",
      ),
    );
    fail(() => openGitCredential(env, ref, credentialSealed, "github_app"));
    // The same envelope under another kind (a connector grant's context) does not open as git.
    const other = env.seal(JSON.stringify(token), {
      teamId: ref.teamId,
      kind: "connector_grant",
      recordId: "c-1",
    });
    fail(() => openGitCredential(env, ref, other, "access_token"));
  });

  it("survives key rotation: the previous key opens it, rewrap moves it to the current key", () => {
    const old = new Envelope("o".repeat(40));
    const { credentialSealed } = sealGitCredential(old, ref, token);
    const rotated = new Envelope(["n".repeat(40), "o".repeat(40)]);
    expect(rotated.isCurrent(credentialSealed)).toBe(false);
    expect(openGitCredential(rotated, ref, credentialSealed, "access_token")).toEqual(token);
    const next = rewrapGitCredential(rotated, ref, credentialSealed);
    expect(next.credentialKeyId).toBe(rotated.currentKeyId);
    expect(
      openGitCredential(new Envelope("n".repeat(40)), ref, next.credentialSealed, "access_token"),
    ).toEqual(token);
  });

  it("refuses malformed secrets without echoing them", () => {
    const env = new Envelope(KEY);
    for (const bad of [
      { kind: "access_token", token: "has space" },
      { kind: "access_token", token: "" },
      { kind: "github_app", privateKey: "not a pem" },
      { kind: "access_token", token: "x", extra: 1 },
    ]) {
      expect(() => sealGitCredential(env, ref, bad as never)).toThrow(
        "the git credential has an invalid shape",
      );
    }
  });

  it("hints only the last characters of a long token, never an App key", () => {
    expect(gitCredentialHint(token)).toBe("••••6789");
    expect(gitCredentialHint({ kind: "access_token", token: "short" })).toBe("••••");
    expect(gitCredentialHint({ kind: "github_app", privateKey: PEM })).toBeNull();
  });
});
