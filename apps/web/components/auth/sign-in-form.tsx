"use client";

import { KeyRoundIcon } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { getPendingSsoLink } from "../../lib/admin/api/site/sso-links";
import { authClient } from "../../lib/auth-client";
import { ssoErrorMessage } from "../../lib/sso-errors";
import { useBranding } from "../shell/branding-context";
import { Button, Field, Notice, TextInput } from "../ui/console";
import { AUTH_LINK, AuthDivider, AuthPanel } from "./auth-panel";
import { SsoButtons, useSsoProviders, type SsoProviderButton } from "./sso-sign-in";

/**
 * Whether this browser can use a passkey (WebAuthn). True for the server render and the first
 * paint, so the passkey button never pops in; dropped after hydration where WebAuthn is missing.
 */
function usePasskeys(): boolean {
  const [supported, setSupported] = useState(true);
  useEffect(() => {
    setSupported(typeof window.PublicKeyCredential === "function");
  }, []);
  return supported;
}

/**
 * The sign-in page's panel (KOBE-755): the logo and "Sign in to <name>" (the name from the Site
 * branding), email, password, **Sign in** and **Forgot your password?** first; then, after an "or"
 * divider, one full-width button per enabled identity provider (KOBE-628) in the server's order,
 * and **Sign in with a passkey**. No divider when there is nothing below it. A password sign-in
 * with 2FA enrolled continues with the authenticator code in the same panel. Errors, including a
 * failed SSO sign-in's `?sso_error=<code>`, show in the panel as an alert. Authentication itself is
 * unchanged (Better Auth's client; a pending SSO link goes to /link-sign-in first, KOBE-630 M1).
 *
 * `providers` is the server render's list (no late arrival, nothing moves), or null when it could
 * not be read there: then the browser asks the public providers route.
 */
export function SignInForm({
  providers: known = null,
}: {
  readonly providers?: readonly SsoProviderButton[] | null;
}) {
  const [step, setStep] = useState<"password" | "totp">("password");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { appName } = useBranding();
  const providers = useSsoProviders(known);
  const passkeys = usePasskeys();

  useEffect(() => {
    const message = ssoErrorMessage(new URLSearchParams(window.location.search).get("sso_error"));
    if (message) setError(message);
  }, []);

  // A local sign-in that followed an SSO attempt may have staged a link: confirm it first
  // (KOBE-630 review M1); otherwise straight to the app.
  const done = async () => {
    const pending = await getPendingSsoLink().catch(() => null);
    window.location.assign(pending?.ok && pending.data ? "/link-sign-in" : "/");
  };

  const attempt = async (run: () => Promise<void>) => {
    setBusy(true);
    try {
      await run();
    } finally {
      setBusy(false);
    }
  };

  function onPassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    void attempt(async () => {
      const res = await authClient.signIn.email({
        email: String(form.get("email") ?? ""),
        password: String(form.get("password") ?? ""),
      });
      if (res.error) return setError("Email or password is incorrect.");
      setError(null);
      if ((res.data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect)
        return setStep("totp");
      await done();
    });
  }

  function onTotp(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get("code") ?? "");
    void attempt(async () => {
      const res = await authClient.twoFactor.verifyTotp({ code });
      if (res.error) return setError("That code didn't work. Try the current one.");
      await done();
    });
  }

  function onPasskey() {
    void attempt(async () => {
      const res = await authClient.signIn.passkey();
      if (res?.error) return setError("Passkey sign-in failed.");
      await done();
    });
  }

  const alternatives = providers.length > 0 || passkeys;
  return (
    <AuthPanel title={`Sign in to ${appName}`}>
      {error && (
        <Notice tone="error" className="my-0">
          {error}
        </Notice>
      )}
      {step === "password" ? (
        <>
          <form onSubmit={onPassword} className="flex flex-col gap-4">
            <Field label="Email">
              <TextInput
                name="email"
                type="email"
                autoComplete="username webauthn"
                required
                className="w-full min-h-9"
              />
            </Field>
            <Field label="Password">
              <TextInput
                name="password"
                type="password"
                autoComplete="current-password"
                required
                className="w-full min-h-9"
              />
            </Field>
            <Button type="submit" variant="primary" loading={busy} className="w-full min-h-9">
              Sign in
            </Button>
          </form>
          <p className="m-0 text-center">
            <a href="/forgot-password" className={AUTH_LINK}>
              Forgot your password?
            </a>
          </p>
          {alternatives && (
            <>
              <AuthDivider />
              <div
                role="group"
                aria-label="Other ways to sign in"
                data-auth-alternatives=""
                className="flex flex-col gap-2"
              >
                <SsoButtons providers={providers} />
                {passkeys && (
                  <Button onClick={onPasskey} disabled={busy} className="w-full min-h-9">
                    <KeyRoundIcon aria-hidden />
                    Sign in with a passkey
                  </Button>
                )}
              </div>
            </>
          )}
        </>
      ) : (
        <form onSubmit={onTotp} className="flex flex-col gap-4">
          <p className="m-0 text-sm text-console-muted">
            Enter the 6-digit code from your authenticator app.
          </p>
          <Field label="Authenticator code">
            <TextInput
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              required
              autoFocus
              className="w-full min-h-9"
            />
          </Field>
          <Button type="submit" variant="primary" loading={busy} className="w-full min-h-9">
            Verify
          </Button>
        </form>
      )}
    </AuthPanel>
  );
}
