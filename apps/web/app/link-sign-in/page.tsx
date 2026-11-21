import { AuthPanel } from "../../components/auth/auth-panel";
import { ConfirmSsoLink } from "../../components/auth/confirm-sso-link";

/** Confirm linking an organization sign-in after a local sign-in (KOBE-630 review M1). */
export default function LinkSignInPage() {
  return (
    <AuthPanel title="Link your organization sign-in">
      <ConfirmSsoLink />
    </AuthPanel>
  );
}
