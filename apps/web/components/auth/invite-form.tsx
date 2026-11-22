"use client";

import { useEffect, useState, type FormEvent } from "react";
import { tokenFromHash, validateNewPassword } from "../../lib/invites";
import { useBranding } from "../shell/branding-context";
import { Button, Field, Notice, TextInput } from "../ui/console";
import { AuthPanel } from "./auth-panel";
import { SsoButtons, useSignInOptions } from "./sso-sign-in";

type State =
  | { readonly step: "checking" }
  | { readonly step: "invalid" }
  | { readonly step: "form"; readonly token: string; readonly email: string };

/**
 * Accept a site invitation (U1): choose a name and password, then land signed in. While the Site
 * requires single sign-on (KOBE-774) the invited person signs in with the identity provider
 * instead: the provider buttons replace the form (the server refuses a password invitation).
 */
export function InviteForm() {
  const [state, setState] = useState<State>({ step: "checking" });
  const [error, setError] = useState<string | null>(null);
  const { appName } = useBranding();
  const { providers, ssoRequired } = useSignInOptions();

  useEffect(() => {
    const token = tokenFromHash(window.location.hash);
    // Keep the token out of the address bar and history.
    window.history.replaceState(null, "", window.location.pathname);
    if (!token) return setState({ step: "invalid" });
    fetch("/api/auth/invitation/lookup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then(async (r) => {
        if (!r.ok) return setState({ step: "invalid" });
        const { email } = (await r.json()) as { email: string };
        setState({ step: "form", token, email });
      })
      .catch(() => setError(`Could not reach the ${appName} server.`));
  }, []);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (state.step !== "form") return;
    const form = new FormData(e.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const password = String(form.get("password") ?? "");
    const problem = validateNewPassword(password, String(form.get("confirm") ?? ""));
    if (!name) return setError("Enter your name.");
    if (problem) return setError(problem);
    const res = await fetch("/api/auth/invitation/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: state.token, name, password }),
    });
    if (res.ok) return window.location.assign("/");
    if (res.status === 429) return setError("Too many attempts. Wait a minute and try again.");
    setState({ step: "invalid" });
  }

  if (state.step === "checking")
    return (
      <AuthPanel>
        {error ? (
          <Notice tone="error" className="my-0">
            {error}
          </Notice>
        ) : (
          <p className="m-0" role="status">
            Checking your invitation…
          </p>
        )}
      </AuthPanel>
    );
  if (state.step === "invalid")
    return (
      <AuthPanel title="Invitation not valid">
        <p className="m-0">
          This invitation link is invalid, already used, or expired. Ask an admin for a new one.
        </p>
      </AuthPanel>
    );
  if (ssoRequired)
    return (
      <AuthPanel title={`Join ${appName}`}>
        <p className="m-0">
          You were invited as <strong>{state.email}</strong>. This site requires single sign-on:
          sign in with your organization&apos;s account.
        </p>
        <SsoButtons providers={providers} />
      </AuthPanel>
    );
  return (
    <AuthPanel title={`Join ${appName}`}>
      <p className="m-0">
        You were invited as <strong>{state.email}</strong>. Choose a name and a password; you can
        add a passkey after signing in.
      </p>
      {error && (
        <Notice tone="error" className="my-0">
          {error}
        </Notice>
      )}
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field label="Name">
          <TextInput
            name="name"
            autoComplete="name"
            maxLength={100}
            required
            className="w-full min-h-9"
          />
        </Field>
        <Field label="Password">
          <TextInput
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            required
            className="w-full min-h-9"
          />
        </Field>
        <Field label="Confirm password">
          <TextInput
            name="confirm"
            type="password"
            autoComplete="new-password"
            required
            className="w-full min-h-9"
          />
        </Field>
        <Button type="submit" variant="primary" className="w-full min-h-9">
          Create account
        </Button>
      </form>
    </AuthPanel>
  );
}
