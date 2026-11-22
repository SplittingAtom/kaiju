import type { SignInProtection, SiteUser } from "../../../lib/admin/api/site/users";
import { Notice } from "../../ui/console";
import { DateTime } from "../parts";

/**
 * Site console › Users (KOBE-812): accounts whose sign-in is slowed down after repeated failed
 * attempts (10 in 15 minutes, then one a minute), and requests that arrived without a client
 * address Kobe can trust (per-address limits are then shared by everyone).
 */
export function SignInProtectionNotices({
  protection,
  users,
}: {
  readonly protection: SignInProtection;
  readonly users: readonly SiteUser[];
}) {
  const names = protection.throttled.map(
    (t) => users.find((u) => u.id === t.userId)?.name ?? "a removed account",
  );
  return (
    <>
      {protection.unknownClientIp && (
        <Notice tone="warn">
          Since <DateTime value={protection.unknownClientIp.since} />, some sign-in or SCIM requests
          arrived without a client address Kobe can trust, so limits per address are shared by
          everyone who signs in. Check the trusted proxies setting (<code>auth.trustedProxies</code>{" "}
          in the Helm values) against the proxies in front of Kobe.
        </Notice>
      )}
      {names.length > 0 && (
        <Notice tone="warn">
          {`Sign-in is slowed down for ${names.join(", ")} after 10 failed attempts in 15 minutes. ` +
            "They can try once a minute until it clears, or sign in with a passkey or single sign-on. " +
            "A password reset or a successful sign-in clears it."}
        </Notice>
      )}
    </>
  );
}
