"use client";

import { getSsoSettings, putSsoSettings } from "../../../lib/admin/api/site/sso";
import { canTurnOffRequiredSso } from "../../../lib/admin/rules";
import { Notice, Section, Switch, useConfirm } from "../../ui/console";
import { useSiteAccess } from "../console-context";
import { MutationStatus } from "../error-notice";
import { ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";

/** The break-glass command the confirmation names (packages/cli, KOBE-774). */
export const BREAK_GLASS_COMMAND = "kobe sso allow-local-sign-in";

/**
 * "Require single sign-on" (KOBE-774, `/v1/site/sso/settings`): turns password and passkey
 * sign-in off. It turns on only from a session signed in through an enabled identity provider,
 * and only the Owner turns it off. The confirmation names the break-glass path: with cluster
 * access, `kobe sso allow-local-sign-in` turns it off when nobody can sign in.
 */
export function SsoRequiredSection() {
  const { state, reload } = useResource(getSsoSettings);
  const access = useSiteAccess();
  const mutation = useMutation();
  const [confirm, confirmDialog] = useConfirm();

  async function change(next: boolean, trigger: HTMLElement | null) {
    const yes = await confirm(
      next
        ? {
            title: "Require single sign-on?",
            description: (
              <>
                Password and passkey sign-in stop, password resets and password invitations are
                refused, and everyone signed in without your identity provider is signed out now. If
                the identity provider ever stops working, nobody can sign in through the web: the
                Site owner can then turn this off with cluster access by running{" "}
                <code>{BREAK_GLASS_COMMAND}</code> (see the guide&apos;s Single sign-on page).
              </>
            ),
            confirmLabel: "Require single sign-on",
          }
        : {
            title: "Stop requiring single sign-on?",
            description:
              "People can sign in with their password or passkey again, beside your identity provider.",
            confirmLabel: "Stop requiring",
          },
      trigger,
    );
    if (!yes) return;
    const done = await mutation.run(
      () => putSsoSettings(next),
      (saved) =>
        saved.requireSso
          ? "Single sign-on is now required. Password and passkey sign-in are off."
          : "Single sign-on is no longer required.",
    );
    if (done) reload();
  }

  return (
    <Section id="sso-required" title="Require single sign-on">
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="single sign-on settings">
        {(settings) => {
          const ownerOnly = settings.requireSso && !canTurnOffRequiredSso(access.siteRole);
          const cannotStart = !settings.requireSso && !settings.canTurnOn;
          return (
            <>
              <Switch
                label="Require single sign-on"
                checked={settings.requireSso}
                disabled={mutation.pending || ownerOnly || cannotStart}
                onCheckedChange={(checked) =>
                  void change(checked, document.activeElement as HTMLElement | null)
                }
                hint={
                  ownerOnly
                    ? "Only the Owner can turn this off."
                    : cannotStart
                      ? "Sign out and sign in with an enabled identity provider to turn this on: that proves the provider works and that you can still sign in."
                      : "People sign in only with your identity provider: no password, passkey, password reset or password invitation. API keys and SCIM keep working. It turns itself off if the last enabled provider is turned off or deleted."
                }
              />
              {settings.requireSso && !settings.inForce ? (
                <Notice tone="warn">
                  Stored on but not in force: no enabled provider can finish a sign-in (or single
                  sign-on is off in the chart), so password sign-in still works.
                </Notice>
              ) : null}
            </>
          );
        }}
      </ResourceView>
      {confirmDialog}
    </Section>
  );
}
