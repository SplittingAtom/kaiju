"use client";

import { useEffect, useState } from "react";
import { cn } from "../../lib/utils";
import { buttonVariants } from "../ui/console";
import { providersOf, ssoStartHref, type SsoProviderButton } from "./sso-sign-in-data";

export { providersOf, ssoStartHref, type SsoProviderButton };

/**
 * The enabled providers, in the server's order: `known` when the server render already had them
 * (KOBE-755: then nothing arrives late and nothing moves), else read in the browser from the
 * public `/api/auth/sso/providers` (404 while single sign-on is off: none).
 */
export function useSsoProviders(
  known: readonly SsoProviderButton[] | null = null,
): readonly SsoProviderButton[] {
  const [fetched, setFetched] = useState<readonly SsoProviderButton[]>([]);
  useEffect(() => {
    if (known !== null) return undefined;
    let live = true;
    fetch("/api/auth/sso/providers", { credentials: "same-origin" })
      .then(async (res) => (res.ok ? ((await res.json()) as unknown) : null))
      .then((body) => {
        if (live && body !== null) setFetched(providersOf(body));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [known]);
  return known ?? fetched;
}

/**
 * "Sign in with <provider>" buttons (KOBE-628, spec sso-oidc-scim §5): one full-width button per
 * enabled provider, in the given order, labelled with its configured display name. Each is a
 * plain link: the server redirects to the identity provider. Nothing when there is none.
 */
export function SsoButtons({
  providers,
  returnTo = "/",
}: {
  readonly providers: readonly SsoProviderButton[];
  readonly returnTo?: string;
}) {
  if (providers.length === 0) return null;
  return (
    <ul aria-label="Single sign-on" className="m-0 flex list-none flex-col gap-2 p-0">
      {providers.map((p) => (
        <li key={p.slug}>
          <a
            href={ssoStartHref(p.slug, returnTo)}
            className={cn(buttonVariants({ variant: "secondary" }), "w-full min-h-9")}
          >
            Sign in with {p.displayName}
          </a>
        </li>
      ))}
    </ul>
  );
}

/** The provider buttons, read in the browser (pages without the server's list). */
export function SsoSignIn({ returnTo = "/" }: { readonly returnTo?: string }) {
  return <SsoButtons providers={useSsoProviders()} returnTo={returnTo} />;
}
