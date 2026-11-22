/** The providers the sign-in page offers and how their buttons link (KOBE-628, KOBE-755). */
export interface SsoProviderButton {
  readonly slug: string;
  readonly displayName: string;
}

/** Where a provider's sign-in starts; the server sanitizes `returnTo` again. */
export function ssoStartHref(slug: string, returnTo = "/"): string {
  return `/api/auth/sso/start/${encodeURIComponent(slug)}?returnTo=${encodeURIComponent(returnTo)}`;
}

/** The well-formed entries of the providers route's `providers` (anything else is dropped). */
export function providersOf(body: unknown): SsoProviderButton[] {
  const list = (body as { providers?: unknown } | null)?.providers;
  if (!Array.isArray(list)) return [];
  return list
    .filter(
      (p): p is SsoProviderButton =>
        typeof p === "object" &&
        p !== null &&
        typeof (p as SsoProviderButton).slug === "string" &&
        typeof (p as SsoProviderButton).displayName === "string",
    )
    .map(({ slug, displayName }) => ({ slug, displayName }));
}

/**
 * What the sign-in page offers (KOBE-774): the providers, and whether the Site requires single
 * sign-on (then nothing else: no password form, reset link or passkey). Required only counts with
 * a provider to offer, as on the server.
 */
export interface SignInOptions {
  readonly providers: readonly SsoProviderButton[];
  readonly ssoRequired: boolean;
}

export const NO_SIGN_IN_OPTIONS: SignInOptions = { providers: [], ssoRequired: false };

/** The providers route's body as {@link SignInOptions}. */
export function signInOptionsOf(body: unknown): SignInOptions {
  const providers = providersOf(body);
  const required = (body as { ssoRequired?: unknown } | null)?.ssoRequired === true;
  return { providers, ssoRequired: required && providers.length > 0 };
}
