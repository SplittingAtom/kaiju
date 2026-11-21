"use client";

import { useEffect, useState, type FormEvent } from "react";
import { AUTH_LINK, AuthPanel } from "../../components/auth/auth-panel";
import { useBranding } from "../../components/shell/branding-context";
import { Button, Field, Notice, TextInput } from "../../components/ui/console";
import { validateSetup } from "../../lib/setup";

/** First-run wizard: creates the Owner while Kobe has no users, then disables itself. */
export default function SetupPage() {
  const [required, setRequired] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { appName } = useBranding();
  const [done, setDone] = useState(false);

  useEffect(() => {
    fetch("/v1/setup")
      .then((r) => r.json() as Promise<{ required: boolean }>)
      .then((d) => setRequired(d.required))
      .catch(() => setError(`Could not reach the ${appName} server.`));
  }, []);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const setupToken = String(form.get("setupToken") ?? "").trim();
    const input = {
      email: String(form.get("email") ?? ""),
      name: String(form.get("name") ?? ""),
      password: String(form.get("password") ?? ""),
    };
    const problem = validateSetup(input);
    if (problem) return setError(problem);
    const res = await fetch("/v1/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...input, setupToken }),
    });
    if (res.status === 201) setDone(true);
    else if (res.status === 409) setRequired(false);
    else if (res.status === 403)
      setError("The setup token is wrong. Copy it from the command in the Helm install notes.");
    else setError("Setup failed. Check the details and try again.");
  }

  const signIn = (
    <a href="/sign-in" className={AUTH_LINK}>
      Sign in
    </a>
  );
  if (done)
    return (
      <AuthPanel title="Owner created">
        <p className="m-0">
          {signIn} to finish setting up {appName}.
        </p>
      </AuthPanel>
    );
  if (required === false)
    return (
      <AuthPanel title={`${appName} is set up`}>
        <p className="m-0">{signIn}</p>
      </AuthPanel>
    );
  if (required === null)
    return (
      <AuthPanel>
        {error ? (
          <Notice tone="error" className="my-0">
            {error}
          </Notice>
        ) : (
          <p className="m-0" role="status">
            Loading…
          </p>
        )}
      </AuthPanel>
    );
  return (
    <AuthPanel title={`Set up ${appName}`}>
      <p className="m-0">Create the Owner account. You can invite everyone else afterwards.</p>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field
          label="Setup token"
          hint={
            <>
              Prove you control this site: run the <code>kubectl … setup-token</code> command
              printed by <code>helm install</code>.
            </>
          }
        >
          <TextInput
            name="setupToken"
            autoComplete="off"
            spellCheck={false}
            required
            className="w-full min-h-9"
          />
        </Field>
        <Field label="Name">
          <TextInput name="name" autoComplete="name" required className="w-full min-h-9" />
        </Field>
        <Field label="Email">
          <TextInput
            name="email"
            type="email"
            autoComplete="email"
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
            required
            className="w-full min-h-9"
          />
        </Field>
        {error && (
          <Notice tone="error" className="my-0">
            {error}
          </Notice>
        )}
        <Button type="submit" variant="primary" className="w-full min-h-9">
          Create Owner
        </Button>
      </form>
    </AuthPanel>
  );
}
