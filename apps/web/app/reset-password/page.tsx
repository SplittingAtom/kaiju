"use client";

import { useEffect, useState, type FormEvent } from "react";
import { AUTH_LINK, AuthPanel } from "../../components/auth/auth-panel";
import { Button, Field, Notice, TextInput } from "../../components/ui/console";
import { authClient } from "../../lib/auth-client";
import { tokenFromHash, validateNewPassword } from "../../lib/invites";

/** Choose a new password from a reset link (`#token=…`). Resetting signs out every session. */
export default function ResetPasswordPage() {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setToken(tokenFromHash(window.location.hash));
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!token) return;
    const form = new FormData(e.currentTarget);
    const newPassword = String(form.get("password") ?? "");
    const problem = validateNewPassword(newPassword, String(form.get("confirm") ?? ""));
    if (problem) return setError(problem);
    const res = await authClient.resetPassword({ newPassword, token });
    if (res.error) return setError("This reset link is invalid or has expired. Request a new one.");
    setDone(true);
  }

  if (token === undefined)
    return (
      <AuthPanel>
        <p className="m-0" role="status">
          Loading…
        </p>
      </AuthPanel>
    );
  if (done)
    return (
      <AuthPanel title="Password changed">
        <p className="m-0">
          You were signed out everywhere.{" "}
          <a href="/sign-in" className={AUTH_LINK}>
            Sign in
          </a>{" "}
          with your new password.
        </p>
      </AuthPanel>
    );
  if (token === null)
    return (
      <AuthPanel title="Link not valid">
        <p className="m-0">
          <a href="/forgot-password" className={AUTH_LINK}>
            Request a new reset link.
          </a>
        </p>
      </AuthPanel>
    );
  return (
    <AuthPanel title="Choose a new password">
      {error && (
        <Notice tone="error" className="my-0">
          {error}
        </Notice>
      )}
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field label="New password">
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
          Change password
        </Button>
      </form>
    </AuthPanel>
  );
}
