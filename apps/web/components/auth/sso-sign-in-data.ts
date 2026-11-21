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
