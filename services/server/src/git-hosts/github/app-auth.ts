import { createHash, createPrivateKey, sign, type KeyObject } from "node:crypto";
import type { GitCredentialKind } from "@kobe/db";
import { GitHostError } from "../adapter.js";
import { hostRequest, type GitHostNet } from "../http.js";
import type { GitHostTarget } from "../target.js";
import { githubError } from "./errors.js";

/**
 * GitHub App authentication (spec workspace-git G5, G8; KOBE-758). The server signs a short JWT
 * with the App's private key (RS256, Node crypto) and mints an installation token for each use,
 * limited to the repositories and permissions that use needs. Tokens are held in memory only, in
 * a cache keyed by a hash of the whole credential (so a Workspace that names someone else's
 * installation with a different key never gets their tokens), until shortly before they expire.
 */

export interface GitHubAppCredential {
  readonly kind: Extract<GitCredentialKind, "github_app">;
  readonly appId: string;
  readonly installationId: string;
  /** PEM, as GitHub hands it out (PKCS#1 or PKCS#8). */
  readonly privateKeyPem: string;
}

export type GitHubPermissionLevel = "read" | "write";

/** What one use needs: repository names (none = every repository of the installation), permissions. */
export interface InstallationScope {
  readonly repositories?: readonly string[];
  readonly permissions: Readonly<Record<string, GitHubPermissionLevel>>;
}

export interface InstallationToken {
  readonly token: string;
  readonly expiresAt: Date;
}

/** A cached token is reused only while it has more than this left. */
export const TOKEN_EXPIRY_MARGIN_MS = 5 * 60_000;
/** GitHub accepts at most 10 minutes; issue for 9 with a minute of clock skew backwards. */
const JWT_LIFETIME_S = 9 * 60;
const JWT_BACKDATE_S = 60;
const MAX_CACHE_ENTRIES = 500;
const NUMERIC_ID = /^\d{1,20}$/;
const VERIFIED_FOR_MS = 60 * 60_000;

/** In-memory installation tokens (never persisted). One per process by default. */
export class InstallationTokenCache {
  private readonly entries = new Map<string, InstallationToken>();
  private readonly pending = new Map<string, Promise<InstallationToken>>();
  private readonly verified = new Map<string, number>();
  /** Keys per credential ({@link credentialGroupKey}), so a removed credential can be forgotten. */
  private readonly groups = new Map<string, Set<string>>();

  private remember(group: string | undefined, key: string): void {
    if (group === undefined) return;
    const keys = this.groups.get(group) ?? new Set<string>();
    keys.add(key);
    if (!this.groups.has(group) && this.groups.size >= MAX_CACHE_ENTRIES) this.groups.clear();
    this.groups.set(group, keys);
  }

  get(key: string, nowMs: number): InstallationToken | undefined {
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt.getTime() - nowMs > TOKEN_EXPIRY_MARGIN_MS) return hit;
    if (hit) this.entries.delete(key);
    return undefined;
  }

  set(key: string, token: InstallationToken, nowMs: number, group?: string): void {
    this.remember(group, key);
    for (const [k, v] of this.entries) {
      if (v.expiresAt.getTime() - nowMs <= TOKEN_EXPIRY_MARGIN_MS) this.entries.delete(k);
    }
    while (this.entries.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, token);
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  /** Mints once for concurrent callers of the same key. */
  async once(key: string, mint: () => Promise<InstallationToken>): Promise<InstallationToken> {
    const running = this.pending.get(key);
    if (running) return running;
    const p = mint().finally(() => this.pending.delete(key));
    this.pending.set(key, p);
    return p;
  }

  /** Remembers that a credential's installation belongs to the connected account (an hour). */
  markVerified(key: string, nowMs: number, group?: string): void {
    this.remember(group, key);
    if (this.verified.size >= MAX_CACHE_ENTRIES) this.verified.clear();
    this.verified.set(key, nowMs + VERIFIED_FOR_MS);
  }

  isVerified(key: string, nowMs: number): boolean {
    const until = this.verified.get(key);
    return until !== undefined && until > nowMs;
  }

  /**
   * Drops every token and installation check of one credential (KOBE-760: a connection removed or
   * its credential replaced), in this process. Other replicas never use them again either: every
   * use reads the connection's current credential first, and a different credential hashes to
   * other keys; their tokens lapse within the hour.
   */
  forgetGroup(group: string): void {
    for (const key of this.groups.get(group) ?? []) {
      this.entries.delete(key);
      this.verified.delete(key);
    }
    this.groups.delete(group);
  }

  clear(): void {
    this.entries.clear();
    this.verified.clear();
    this.groups.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

export const sharedTokenCache = new InstallationTokenCache();

const b64url = (data: Buffer | string) => Buffer.from(data).toString("base64url");

function privateKey(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: pem, format: "pem" });
  } catch {
    // The parser's error may quote the input: never pass it on.
    throw new GitHostError("auth_failed", "The GitHub App private key is not a valid key.", {
      reason: "invalid_private_key",
    });
  }
  if (key.asymmetricKeyType !== "rsa") {
    throw new GitHostError("auth_failed", "The GitHub App private key must be an RSA key.", {
      reason: "invalid_private_key",
    });
  }
  return key;
}

export function assertAppIds(credential: GitHubAppCredential): void {
  if (!NUMERIC_ID.test(credential.appId) || !NUMERIC_ID.test(credential.installationId)) {
    throw new GitHostError("invalid_request", "App ID and installation ID must be numbers.");
  }
}

/** The App's JWT (RS256): `iss` the App ID, valid for nine minutes. */
export function appJwt(credential: GitHubAppCredential, nowMs: number): string {
  assertAppIds(credential);
  const key = privateKey(credential.privateKeyPem);
  const now = Math.floor(nowMs / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(
    JSON.stringify({ iat: now - JWT_BACKDATE_S, exp: now + JWT_LIFETIME_S, iss: credential.appId }),
  );
  const signature = sign("sha256", Buffer.from(`${head}.${body}`), key);
  return `${head}.${body}.${b64url(signature)}`;
}

/** The cache key: a hash of API root, whole credential and scope; never the credential itself. */
export function scopeKey(
  apiRoot: string,
  c: GitHubAppCredential,
  scope: InstallationScope,
): string {
  const repositories = [...(scope.repositories ?? [])].map((r) => r.toLowerCase()).sort();
  const permissions = Object.entries(scope.permissions).sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha256")
    .update(
      JSON.stringify([
        apiRoot,
        c.appId,
        c.installationId,
        c.privateKeyPem,
        repositories,
        permissions,
      ]),
    )
    .digest("hex");
}

/** One credential's group in the cache: a hash of App ID, installation ID and private key. */
export function credentialGroupKey(c: GitHubAppCredential): string {
  return createHash("sha256")
    .update(JSON.stringify(["group", c.appId, c.installationId, c.privateKeyPem]))
    .digest("hex");
}

/** Forgets a GitHub App credential's cached installation tokens (removed or replaced, KOBE-760). */
export function forgetGitHubAppCredential(
  c: GitHubAppCredential,
  cache: InstallationTokenCache = sharedTokenCache,
): void {
  cache.forgetGroup(credentialGroupKey(c));
}

export interface AppAuthContext {
  readonly net: GitHostNet;
  /** The Site's decision for the connection (G3); every request re-checks against it. */
  readonly target: GitHostTarget;
  readonly apiRoot: string;
  readonly credential: GitHubAppCredential;
  readonly cache: InstallationTokenCache;
  readonly now: () => number;
}

/** Headers for a request signed as the App itself (installation metadata, token minting). */
export function appHeaders(ctx: AppAuthContext): Record<string, string> {
  return {
    authorization: `Bearer ${appJwt(ctx.credential, ctx.now())}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };
}

async function mint(ctx: AppAuthContext, scope: InstallationScope): Promise<InstallationToken> {
  const url = `${ctx.apiRoot}/app/installations/${ctx.credential.installationId}/access_tokens`;
  const res = await hostRequest(ctx.net, ctx.target, ctx.apiRoot, url, {
    method: "POST",
    headers: appHeaders(ctx),
    body: {
      ...(scope.repositories && scope.repositories.length > 0
        ? { repositories: [...scope.repositories] }
        : {}),
      permissions: scope.permissions,
    },
  });
  if (res.status === 404) {
    throw new GitHostError("auth_failed", "The GitHub App installation was not found.", {
      status: 404,
      reason: "installation_removed",
    });
  }
  if (res.status === 422) {
    const text = JSON.stringify(res.json ?? "").toLowerCase();
    if (text.includes("permission")) {
      throw new GitHostError("forbidden", "The GitHub App lacks a permission this needs.", {
        status: 422,
        missingPermission: Object.entries(scope.permissions)
          .map(([k, v]) => `${k}=${v}`)
          .join(", "),
      });
    }
    throw new GitHostError("not_found", "Not found in the connected organization.", {
      status: 422,
    });
  }
  if (res.status !== 201 && res.status !== 200) throw githubError(res, ctx.now());
  const json = res.json as { token?: unknown; expires_at?: unknown } | undefined;
  const expiresAt = typeof json?.expires_at === "string" ? new Date(json.expires_at) : null;
  if (typeof json?.token !== "string" || !expiresAt || Number.isNaN(expiresAt.getTime())) {
    throw new GitHostError("unexpected", "GitHub returned no installation token.");
  }
  return { token: json.token, expiresAt };
}

/** An installation token for `scope`, from the cache while it has time left, else minted. */
export async function installationToken(
  ctx: AppAuthContext,
  scope: InstallationScope,
): Promise<InstallationToken> {
  const key = scopeKey(ctx.apiRoot, ctx.credential, scope);
  const hit = ctx.cache.get(key, ctx.now());
  if (hit) return hit;
  return ctx.cache.once(key, async () => {
    const token = await mint(ctx, scope);
    ctx.cache.set(key, token, ctx.now(), credentialGroupKey(ctx.credential));
    return token;
  });
}

/** Drops a cached token the host rejected (revoked or expired early). */
export function forgetAppToken(ctx: AppAuthContext, scope: InstallationScope): void {
  ctx.cache.delete(scopeKey(ctx.apiRoot, ctx.credential, scope));
}
