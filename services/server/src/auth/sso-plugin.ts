import { timingSafeEqual } from "node:crypto";
import type { BetterAuthPlugin, GenericEndpointContext } from "better-auth";
import { APIError, createAuthEndpoint, isAPIError } from "better-auth/api";
import * as oidc from "openid-client";
import { z } from "zod";
import type { KobeDb } from "@kobe/db";
import type { AuthAttemptAudit } from "../audit/attempts.js";
import { logger } from "../logger.js";
import type { SsoFailure } from "../sso/claims.js";
import { completeSsoSignIn } from "../sso/complete-sign-in.js";
import type { SsoNet } from "../sso/net.js";
import {
  OidcClients,
  SsoFlowError,
  authorizationUrl,
  exchangeCode,
  listSignInProviders,
  loadEnabledProvider,
  type SsoProvider,
} from "../sso/oidc-flow.js";
import { redirectUriFor, revealClientSecret, type ProviderStore } from "../sso/providers.js";
import { readSsoRequired } from "../sso/required.js";
import { mfaEvidence } from "../sso/mfa.js";
import { safeReturnTo } from "../sso/return-to.js";
import type { SsoSettings } from "../sso/settings.js";
import { LINK_INTENT_TTL_MS, LinkIntentBox, issueLinkIntent } from "../sso/link-intent.js";
import { resolveSsoUser } from "../sso/sign-in.js";
import { SSO_STATE_TTL_MS, SsoStateBox, consumeState, rememberState } from "../sso/state.js";
import type { AfterChangeDeps } from "../teams/after-change.js";
import { readRequireTwoFactorIn } from "./session.js";

export interface SsoPluginOptions {
  readonly db: KobeDb;
  /** Public origin of the install; the redirect URI and error pages hang off it. */
  readonly publicOrigin: string;
  /** Better Auth's secret: the flow cookie's key is derived from it (HKDF, own purpose). */
  readonly secret: string;
  readonly attempts: AuthAttemptAudit;
  /** Unset (tools and tests without SSO): every route answers 404, as with the kill switch. */
  readonly sso: SsoRuntime | undefined;
}

export interface SsoRuntime {
  readonly settings: SsoSettings;
  readonly net: SsoNet;
  readonly providers: ProviderStore;
  /** The membership side effects of the mapping engine; bound after the server deps exist. */
  readonly afterChange: () => AfterChangeDeps;
}

/** Spec sso-oidc-scim §5 rate limits (per client IP; Postgres-backed like every auth route). */
export const SSO_RATE_LIMITS = {
  "/sso/start/*": { window: 60, max: 20 },
  "/sso/callback/*": { window: 60, max: 20 },
} as const;

const slugParam = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const query = z.record(z.string(), z.unknown()).optional();

const sameText = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const notFound = () => new APIError("NOT_FOUND", { message: "Not found" });

/**
 * The `sso_error` code the browser sees. "No access" and "an account with this address exists"
 * share one code, so the page never tells whether an address has a Kaiju account (review finding
 * 9b); the audit log keeps the precise reason.
 */
export function browserSsoError(failure: SsoFailure): string {
  return failure === "no_access" || failure === "link_required" ? "not_allowed" : failure;
}

/** The link-intent cookie of the local-proof flow (§6, KOBE-630): `__Host-` on https. */
export const linkIntentCookieName = (secure: boolean): string =>
  secure ? "__Host-kobe-sso-link" : "kobe-sso-link";

/**
 * OIDC single sign-on as Better Auth endpoints (KOBE-628, spec sso-oidc-scim §5, §9, §13), so it
 * shares Better Auth's Postgres rate limits, session creation (the deactivation hook and trigger),
 * cookies and revocation:
 *
 * - `GET /api/auth/sso/providers` → the enabled providers' slug and name (sign-in buttons), and
 *   `ssoRequired` (KOBE-774: the Site requires single sign-on, so the page offers nothing else);
 * - `GET /api/auth/sso/start/:slug?returnTo=` → redirect to the IdP (code + PKCE S256, `state`,
 *   `nonce`), with the flow sealed in an HttpOnly cookie and `state` recorded for single use;
 * - `GET /api/auth/sso/callback/:slug` → checks and consumes `state`, exchanges the code,
 *   validates the ID token, resolves the user (JIT only with mapped access, never linked on email),
 *   applies the access mappings, creates the session and records `session_sso_contexts`.
 *
 * Every refusal redirects to `/sign-in?sso_error=<code>` and is audited (`method: sso`); nothing
 * from the token reaches the page or the log. `auth.sso.enabled: false` turns every route into a
 * 404 (the kill switch); local sign-in never reaches this code.
 */
export function ssoPlugin(options: SsoPluginOptions) {
  const off = { enabled: false } as const;
  const o = { ...options, settings: options.sso?.settings ?? off };
  const runtime = (): SsoRuntime => {
    if (!options.sso) throw notFound();
    return options.sso;
  };
  const box = new SsoStateBox(o.secret);
  let clientsMemo: OidcClients | undefined;
  const clients = () => (clientsMemo ??= new OidcClients(runtime().net));
  const secure = new URL(o.publicOrigin).protocol === "https:";
  const cookieName = secure ? "__Host-kobe-sso" : "kobe-sso";
  const linkCookie = linkIntentCookieName(secure);
  const linkBox = new LinkIntentBox(o.secret);
  const cookieOptions = {
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: "/",
  };

  async function refused(failure: SsoFailure, userId?: string): Promise<string> {
    await o.attempts.record({
      action: "auth.sign_in.failed",
      userId: userId ?? null,
      method: "sso",
      reason: failure,
    });
    return `${o.publicOrigin}/sign-in?sso_error=${browserSsoError(failure)}`;
  }

  async function configured(p: SsoProvider) {
    const secret = await revealClientSecret(runtime().providers, p.id);
    if (!secret) throw new SsoFlowError("provider_unavailable");
    return clients().configure(p, secret);
  }

  /**
   * Leaves the link intent of an unlinked identity: the next local sign-in in this browser may
   * link it (§6).
   */
  async function leaveLinkIntent(
    ctx: GenericEndpointContext,
    providerId: string,
    intent: { readonly subject: string; readonly email: string },
  ): Promise<void> {
    const sealedIntent = await issueLinkIntent(o.db, linkBox, { providerId, ...intent });
    ctx.setCookie(linkCookie, sealedIntent, {
      ...cookieOptions,
      maxAge: LINK_INTENT_TTL_MS / 1000,
    });
  }

  /** Runs a step; an SSO refusal or an unexpected error becomes the error page's address. */
  async function guarded(what: string, step: () => Promise<string>): Promise<string> {
    try {
      return await step();
    } catch (err) {
      if (err instanceof SsoFlowError) return refused(err.failure);
      if (
        isAPIError(err) &&
        (err.body as { code?: string } | undefined)?.code === "ACCOUNT_DEACTIVATED"
      ) {
        return refused("deactivated");
      }
      logger.error({ err: { name: (err as Error)?.name } }, `single sign-on ${what} failed`);
      return refused("sign_in_failed");
    }
  }

  return {
    id: "kobe-sso",
    endpoints: {
      ssoProviders: createAuthEndpoint("/sso/providers", { method: "GET" }, async (ctx) => {
        if (!o.settings.enabled) throw notFound();
        const providers = await listSignInProviders(o.db, runtime().settings.helmSecrets);
        ctx.setHeader("cache-control", "no-store");
        // KOBE-774: the sign-in page then offers only these buttons (no password, no passkey).
        const ssoRequired = providers.length > 0 && (await readSsoRequired(o.db));
        return ctx.json({ providers, ssoRequired });
      }),

      ssoStart: createAuthEndpoint("/sso/start/:slug", { method: "GET", query }, async (ctx) => {
        if (!o.settings.enabled) throw notFound();
        const location = await guarded("start", async () => {
          const slug = slugParam.safeParse(ctx.params?.slug);
          const p = slug.success ? await loadEnabledProvider(o.db, slug.data) : undefined;
          if (!p) throw new SsoFlowError("provider_unavailable");
          const config = await configured(p);
          const state = oidc.randomState();
          const nonce = oidc.randomNonce();
          const verifier = oidc.randomPKCECodeVerifier();
          const exp = Date.now() + SSO_STATE_TTL_MS;
          await rememberState(o.db, state, p.slug, new Date(exp));
          const sealed = box.seal({
            v: 1,
            slug: p.slug,
            providerId: p.id,
            state,
            nonce,
            verifier,
            returnTo: safeReturnTo(ctx.query?.returnTo),
            exp,
          });
          ctx.setCookie(cookieName, sealed, { ...cookieOptions, maxAge: SSO_STATE_TTL_MS / 1000 });
          return authorizationUrl(config, p, {
            redirectUri: redirectUriFor(o.publicOrigin, p.slug),
            state,
            nonce,
            codeChallenge: await oidc.calculatePKCECodeChallenge(verifier),
          }).href;
        });
        ctx.setHeader("cache-control", "no-store");
        throw ctx.redirect(location);
      }),

      ssoCallback: createAuthEndpoint(
        "/sso/callback/:slug",
        { method: "GET", query },
        async (ctx) => {
          if (!o.settings.enabled) throw notFound();
          // The flow cookie works once, whatever happens next.
          const sealed = ctx.getCookie(cookieName);
          ctx.setCookie(cookieName, "", { ...cookieOptions, maxAge: 0 });
          ctx.setHeader("cache-control", "no-store");
          const q = ctx.query ?? {};
          const location = await guarded("callback", async () => {
            const slug = String(ctx.params?.slug ?? "");
            const flow = box.open(sealed);
            const state = typeof q.state === "string" ? q.state : "";
            if (!flow || flow.slug !== slug || !sameText(flow.state, state)) {
              throw new SsoFlowError("state_invalid");
            }
            if (!(await consumeState(o.db, state, slug))) throw new SsoFlowError("state_invalid");
            if (q.error !== undefined) throw new SsoFlowError("idp_error");
            const p = await loadEnabledProvider(o.db, slug);
            if (!p || p.id !== flow.providerId) throw new SsoFlowError("provider_unavailable");
            const config = await configured(p);
            const callbackUrl = new URL(redirectUriFor(o.publicOrigin, p.slug));
            for (const [k, v] of Object.entries(q)) {
              if (typeof v === "string") callbackUrl.searchParams.set(k, v);
            }
            const identity = await exchangeCode(clients(), config, p, {
              callbackUrl,
              verifier: flow.verifier,
              state: flow.state,
              nonce: flow.nonce,
            });
            // MFA trust (§8, SSO3): the provider's mfa_rule decides whether the IdP proved MFA.
            // Not proven while the site requires 2FA → refused before any user or session is
            // made; there is no fallback to Kaiju TOTP for SSO sign-ins (SSO7).
            const mfa = mfaEvidence(p.kind, p.mfaRule, identity);
            if (mfa === null && (await readRequireTwoFactorIn(o.db))) {
              throw new SsoFlowError("mfa_missing");
            }
            const outcome = await resolveSsoUser(runtime().afterChange(), p, identity);
            if (!outcome.ok) {
              // An unlinked identity: the next local sign-in in this browser may link it (§6).
              if (outcome.linkIntent) await leaveLinkIntent(ctx, p.id, outcome.linkIntent);
              return refused(outcome.failure, outcome.userId);
            }
            // A successful SSO sign-in discards any pending link intent.
            if (ctx.getCookie(linkCookie))
              ctx.setCookie(linkCookie, "", { ...cookieOptions, maxAge: 0 });

            await completeSsoSignIn(ctx, o.db, {
              provider: p,
              userId: outcome.userId,
              identity,
              mfa,
              groupsOverage: outcome.groupsOverage === true,
            });
            return `${o.publicOrigin}${flow.returnTo}`;
          });
          throw ctx.redirect(location);
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
