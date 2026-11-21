import { SignInForm } from "../../components/auth/sign-in-form";
import { getSignInProviders } from "../../lib/auth/sign-in-providers-server";

/**
 * Sign in (KOBE-755): email and password (then a TOTP code when 2FA is enrolled) first, then one
 * button per enabled identity provider (KOBE-628) and a passkey, in the themed AuthPanel. The
 * providers are read here, on the server, so the first HTML already has their buttons; when they
 * can't be, the browser reads them. A failed SSO sign-in comes back with `?sso_error=<code>`.
 */
export default async function SignInPage() {
  return <SignInForm providers={await getSignInProviders()} />;
}
