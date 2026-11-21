import { providersOf, type SsoProviderButton } from "../../components/auth/sso-sign-in-data";
import { webConfig } from "../config";

/**
 * The sign-in page's identity providers for the server render (KOBE-755), so the page's first HTML
 * already holds the provider buttons and nothing moves when they would otherwise arrive: the
 * server's public `GET ${KOBE_SERVER_URL}/api/auth/sso/providers` (the same list the browser
 * reads, enabled providers in the server's order), with a short timeout. A 404 means single
 * sign-on is off: none. Any other failure, or no server URL, is null: the page then asks the
 * route from the browser as before. Kept per web process for {@link PROVIDERS_CACHE_MS}, so sign-in
 * traffic never reaches the server's per-address rate limit from this one address; a provider an
 * admin turns on shows within that time.
 */
export const PROVIDERS_PATH = "/api/auth/sso/providers";
export const PROVIDERS_TIMEOUT_MS = 1000;
export const PROVIDERS_CACHE_MS = 15_000;

export interface ProvidersLoaderOptions {
  readonly serverUrl: string | null;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

export type ProvidersLoader = () => Promise<readonly SsoProviderButton[] | null>;

export function createProvidersLoader(options: ProvidersLoaderOptions): ProvidersLoader {
  const { serverUrl, timeoutMs = PROVIDERS_TIMEOUT_MS } = options;
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let kept: { readonly at: number; readonly providers: readonly SsoProviderButton[] } | undefined;

  return async () => {
    if (serverUrl === null) return null;
    if (kept !== undefined && now() - kept.at < PROVIDERS_CACHE_MS) return kept.providers;
    try {
      const res = await doFetch(`${serverUrl}${PROVIDERS_PATH}`, {
        headers: { accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 404) {
        kept = { at: now(), providers: [] };
        return kept.providers;
      }
      if (!res.ok) return null;
      kept = { at: now(), providers: providersOf(await res.json()) };
      return kept.providers;
    } catch {
      return null;
    }
  };
}

let loader: ProvidersLoader | undefined;

/** The providers for this render, or null when the browser should ask. Never throws. */
export function getSignInProviders(): Promise<readonly SsoProviderButton[] | null> {
  loader ??= createProvidersLoader({ serverUrl: webConfig().serverUrl });
  return loader();
}
