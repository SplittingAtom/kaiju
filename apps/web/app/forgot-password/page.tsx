"use client";

import { useState, type FormEvent } from "react";
import { AUTH_LINK, AuthPanel } from "../../components/auth/auth-panel";
import { useBranding } from "../../components/shell/branding-context";
import { Button, Field, Notice, TextInput } from "../../components/ui/console";
import { authClient } from "../../lib/auth-client";

const BACK = (
  <a href="/sign-in" className={AUTH_LINK}>
    Back to sign in
  </a>
);

/** Ask for a reset link. The answer never says whether the address has an account. */
export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { appName } = useBranding();

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get("email") ?? "");
    const res = await authClient.requestPasswordReset({ email });
    if (res.error?.status === 429) return setError("Too many requests. Try again in a minute.");
    setSent(true);
  }

  if (sent)
    return (
      <AuthPanel title="Check your email" footer={BACK}>
        <p className="m-0">
          If that address has a {appName} account, a reset link is on its way. It works for 30
          minutes.
        </p>
      </AuthPanel>
    );
  return (
    <AuthPanel title="Reset your password" footer={BACK}>
      {error && (
        <Notice tone="error" className="my-0">
          {error}
        </Notice>
      )}
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field label="Email">
          <TextInput
            name="email"
            type="email"
            autoComplete="username"
            required
            className="w-full min-h-9"
          />
        </Field>
        <Button type="submit" variant="primary" className="w-full min-h-9">
          Send reset link
        </Button>
      </form>
    </AuthPanel>
  );
}
