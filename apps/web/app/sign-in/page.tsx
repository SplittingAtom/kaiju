import { SignInForm } from "../../components/auth/sign-in-form";
import { getSignInOptions } from "../../lib/auth/sign-in-providers-server";

/**
 * Sign in (KOBE-755): email and password (then a TOTP code when 2FA is enrolled) first, then one
 * button per enabled identity provider (KOBE-628) and a passkey, in the themed AuthPanel. While
 * the Site requires single sign-on (KOBE-774) only the provider buttons. The providers are read
 * here, on the server, so the first HTML already has their buttons; when they can't be, the
 * browser reads them. A failed SSO sign-in comes back with `?sso_error=<code>`.
 */
export default async function SignInPage() {
  const options = await getSignInOptions();
  return (
    <SignInForm providers={options?.providers ?? null} ssoRequired={options?.ssoRequired ?? null} />
  );
}
